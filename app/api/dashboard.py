"""API REST del Alpha Bunker Dashboard (consumida por la Mini App y Portal Web).

Incluye autenticación dual (Telegram WebApp initData + Cuentas de Portal con Email/Teléfono y Password),
desafíos de Captcha alfanuméricos con TTL, privilegios directos para el Arquitecto Maestro
y gestión integral de comunidades, reglas y pagos.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, List, Literal, Optional

try:
    from aiogram.enums import ChatMemberStatus  # type: ignore[reportMissingImports]
except ImportError:  # pragma: no cover - compatibilidad con aiogram 2.x
    from aiogram.types import ChatMemberStatus  # type: ignore[reportMissingImports]

try:
    from aiogram.exceptions import TelegramAPIError  # type: ignore[reportMissingImports]
except ImportError:  # pragma: no cover - compatibilidad con aiogram 2.x
    from aiogram.utils.exceptions import TelegramAPIError  # type: ignore[reportMissingImports]

from fastapi import APIRouter, Depends, Header, HTTPException, status  # type: ignore[reportMissingImports]
from pydantic import BaseModel, ConfigDict, Field, model_validator  # type: ignore[reportMissingImports]

from app.auth import get_current_telegram_user
from app.bot.dispatcher import bot
from app.config import settings
from app.services.database import (
    ActionType,
    BlacklistAction,
    Community,
    PortalAccount,
    TriggerType,
    db,
)
from app.services.payments import (
    PLANS,
    PaymentError,
    create_checkout,
    gateway_availability,
    sorted_plans,
    verify_transaction,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])

CurrentUser = Dict[str, Any]

MASTER_ADMIN_IDS = {8269470905, 1738976493}
SESSION_SECRET = hashlib.sha256(f"alpha-bunker-portal::{settings.BOT_TOKEN}".encode("utf-8")).digest()


# ---------------------------------------------------------------------------
# Tokens y Autenticación de Cuentas del Portal
# ---------------------------------------------------------------------------
def issue_portal_token(account: PortalAccount) -> str:
    """Emite un token de sesión web firmado para la cuenta del portal."""
    payload = {
        "sub": account.id,
        "role": account.role,
        "email": account.email,
        "phone": account.phone,
        "first_name": account.first_name,
        "telegram_id": account.telegram_id,
        "iat": int(time.time()),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    raw_b64 = base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")
    sig = hmac.new(SESSION_SECRET, raw_b64.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{raw_b64}.{sig}"


def verify_portal_token(token: str) -> Optional[Dict[str, Any]]:
    """Verifica la firma y vigencia del token de sesión web."""
    try:
        if not token or "." not in token:
            return None
        raw_b64, sig = token.rsplit(".", 1)
        expected_sig = hmac.new(SESSION_SECRET, raw_b64.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        padded = raw_b64 + "=" * (-len(raw_b64) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
        # Validez de 30 días
        if int(time.time()) - int(data.get("iat", 0)) > 86400 * 30:
            return None
        return data
    except Exception:
        return None


async def get_current_actor(
    authorization: Optional[str] = Header(None),
    x_telegram_init_data: Optional[str] = Header(None, alias="X-Telegram-Init-Data"),
) -> CurrentUser:
    """Resuelve la identidad del usuario actual vía Bearer Token (Portal Web) o Telegram initData."""
    # 1. Autenticación Web Portal (Bearer Token)
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1].strip()
        payload = verify_portal_token(token)
        if payload:
            account = await db.get_portal_account_by_id(payload.get("sub", ""))
            if account and account.is_active:
                effective_id = account.telegram_id
                if not effective_id:
                    if account.role == "master":
                        effective_id = 8269470905
                    else:
                        effective_id = int(account.id[:8], 16)
                return {
                    "id": effective_id,
                    "user_id": effective_id,
                    "account_id": account.id,
                    "username": account.email or account.phone or "operador",
                    "first_name": account.first_name,
                    "role": account.role,
                    "telegram_id": account.telegram_id,
                    "is_portal": True,
                }

    # 2. Autenticación Telegram WebApp
    if x_telegram_init_data:
        try:
            tg_user = await get_current_telegram_user(x_telegram_init_data)
            uid = int(tg_user.get("id", 0))
            role = "master" if uid in MASTER_ADMIN_IDS else "creator"
            tg_user["role"] = role
            return tg_user
        except Exception:
            pass

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Autenticación requerida. Inicia sesión con Telegram o tus credenciales de portal.",
    )


# ---------------------------------------------------------------------------
# Esquemas de entrada
# ---------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    email: Optional[str] = None
    phone: Optional[str] = None
    password: str = Field(min_length=6, max_length=128)
    first_name: str = Field(default="Creador", max_length=64)
    telegram_id: Optional[int] = None
    captcha_token: str
    captcha_code: str


class LoginRequest(BaseModel):
    login: str  # Email o teléfono
    password: str
    captcha_token: Optional[str] = None
    captcha_code: Optional[str] = None


class SettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    welcome_enabled: Optional[bool] = None
    welcome_message: Optional[str] = Field(default=None, max_length=2000)
    captcha_enabled: Optional[bool] = None
    captcha_timeout: Optional[int] = Field(default=None, ge=30, le=3600)
    auto_roles: Optional[List[str]] = Field(default=None, max_length=20)
    blacklist: Optional[List[str]] = Field(default=None, max_length=500)
    blacklist_action: Optional[BlacklistAction] = None

    def cleaned(self) -> Dict[str, Any]:
        data = self.model_dump(exclude_none=True)
        for key in ("auto_roles", "blacklist"):
            if key in data:
                seen: List[str] = []
                for item in data[key]:
                    value = str(item).strip()[:64]
                    if value and value not in seen:
                        seen.append(value)
                data[key] = seen
        return data


class BlockRuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    trigger_type: TriggerType
    trigger_value: str = Field(default="", max_length=64)
    action_type: ActionType
    payload: Dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True

    @model_validator(mode="after")
    def _check_consistency(self) -> "BlockRuleIn":
        self.trigger_value = self.trigger_value.strip()
        if self.trigger_type in ("command", "keyword") and not self.trigger_value:
            raise ValueError("Los disparadores 'command' y 'keyword' necesitan trigger_value.")
        if self.trigger_type == "command":
            self.trigger_value = self.trigger_value.lstrip("/").split()[0].lower()
        if self.action_type == "send_message" and not str(self.payload.get("text", "")).strip():
            raise ValueError("La acción 'send_message' necesita payload.text.")
        if self.action_type == "add_role" and not str(self.payload.get("role", "")).strip():
            raise ValueError("La acción 'add_role' necesita payload.role.")
        if self.action_type == "payment_wall" and self.payload.get("plan_id") not in PLANS:
            raise ValueError("La acción 'payment_wall' necesita un payload.plan_id válido.")
        text = self.payload.get("text")
        if isinstance(text, str) and len(text) > 2000:
            raise ValueError("payload.text no puede superar 2000 caracteres.")
        return self


class CheckoutRequest(BaseModel):
    plan_id: str
    gateway: Literal["stars", "paypal", "binance", "global66", "payoneer"]


# ---------------------------------------------------------------------------
# Utilidades de Acceso
# ---------------------------------------------------------------------------
def _serialize_community(community: Community, rules_count: int) -> Dict[str, Any]:
    return {
        "chat_id": community.chat_id,
        "title": community.title,
        "chat_type": community.chat_type,
        "bot_is_admin": community.bot_is_admin,
        "is_owner": True,
        "rules_count": rules_count,
        "settings": community.settings.model_dump(),
        "members_with_roles": len(community.member_roles),
    }


async def _ensure_can_manage(chat_id: int, user_id: int, role: str = "") -> Community:
    """Verifica si el usuario puede gestionar la comunidad o posee inmunidad de Arquitecto Maestro."""
    community = await db.get_community(chat_id)
    if community is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comunidad no registrada")
    # Inmunidad para el Arquitecto Maestro
    if role == "master" or user_id in MASTER_ADMIN_IDS:
        return community
    if community.owner_id == user_id:
        return community
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No se pudo verificar tu rol") from exc
    if member.status not in {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No eres administrador de esta comunidad")
    return community


# ---------------------------------------------------------------------------
# Endpoints de Autenticación y Captcha
# ---------------------------------------------------------------------------
@router.get("/auth/captcha")
async def get_captcha_challenge() -> Dict[str, str]:
    """Genera un reto de verificación alfanumérico temporal contra bots."""
    challenge = await db.create_captcha(ttl_seconds=300)
    return {
        "status": "success",
        "captcha_token": challenge["token"],
        "captcha_code": challenge["code"],
    }


@router.post("/auth/register")
async def register_account(body: RegisterRequest) -> Dict[str, Any]:
    """Registra una cuenta de creador validando el reto de captcha."""
    captcha_valid = await db.verify_captcha(body.captcha_token, body.captcha_code)
    if not captcha_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Código de verificación alfanumérico incorrecto o expirado.",
        )
    try:
        account = await db.create_portal_account(
            password=body.password,
            email=body.email,
            phone=body.phone,
            first_name=body.first_name,
            telegram_id=body.telegram_id,
        )
        token = issue_portal_token(account)
        return {
            "status": "success",
            "session_token": token,
            "account": {
                "id": account.id,
                "email": account.email,
                "phone": account.phone,
                "role": account.role,
                "first_name": account.first_name,
                "telegram_id": account.telegram_id,
            },
        }
    except ValueError as val_err:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(val_err)) from val_err


@router.post("/auth/login")
async def login_account(body: LoginRequest) -> Dict[str, Any]:
    """Autentica a un creador o al Arquitecto Maestro con correo o teléfono."""
    if body.captcha_token and body.captcha_code:
        captcha_valid = await db.verify_captcha(body.captcha_token, body.captcha_code)
        if not captcha_valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Código de verificación alfanumérico incorrecto o expirado.",
            )

    account = await db.authenticate_portal_account(body.login, body.password)
    if not account:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas o cuenta inactiva.",
        )

    token = issue_portal_token(account)
    return {
        "status": "success",
        "session_token": token,
        "account": {
            "id": account.id,
            "email": account.email,
            "phone": account.phone,
            "role": account.role,
            "first_name": account.first_name,
            "telegram_id": account.telegram_id,
        },
    }


@router.get("/auth/me")
async def get_current_user_profile(user: CurrentUser = Depends(get_current_actor)) -> Dict[str, Any]:
    """Retorna los datos de identidad y permisos de la sesión activa."""
    return {"status": "success", "user": user}


# ---------------------------------------------------------------------------
# Endpoints de Dashboard y Operaciones
# ---------------------------------------------------------------------------
@router.get("/public-config")
async def public_config() -> Dict[str, Any]:
    """Configuración pública: catálogo, pasarelas activas y username del bot."""
    try:
        me = await bot.me()
        bot_username: Optional[str] = me.username
    except TelegramAPIError:
        bot_username = None
    return {
        "bot_username": bot_username,
        "plans": [plan.model_dump() for plan in sorted_plans()],
        "gateways": gateway_availability(),
        "stars_per_usd": settings.STARS_PER_USD,
    }


@router.get("/user-info")
async def user_info(user: CurrentUser = Depends(get_current_actor)) -> Dict[str, Any]:
    user_id = int(user["id"])
    stored = await db.get_user(user_id)
    communities = await db.get_user_communities(user_id)
    transactions = await db.get_user_transactions(user_id)

    serialized = []
    total_rules = 0
    for community in communities:
        rules = await db.get_block_rules(community.chat_id)
        total_rules += len(rules)
        serialized.append(_serialize_community(community, len(rules)))

    return {
        "user": {
            "id": user_id,
            "username": user.get("username"),
            "first_name": user.get("first_name", ""),
            "language_code": stored.language_code if stored else "es",
            "photo_url": user.get("photo_url"),
            "role": user.get("role", "creator"),
        },
        "communities": serialized,
        "subscriptions": [t.model_dump(mode="json") for t in transactions],
        "stats": {
            "communities": len(communities),
            "protected": sum(1 for c in communities if c.bot_is_admin),
            "rules": total_rules,
            "active_subscriptions": sum(1 for t in transactions if t.status == "completed"),
        },
    }


@router.get("/communities")
async def list_communities(user: CurrentUser = Depends(get_current_actor)) -> Dict[str, Any]:
    communities = await db.get_user_communities(int(user["id"]), only_admin=True)
    items = []
    for community in communities:
        rules = await db.get_block_rules(community.chat_id)
        items.append(_serialize_community(community, len(rules)))
    return {"communities": items}


@router.get("/communities/{chat_id}/settings")
async def get_settings(chat_id: int, user: CurrentUser = Depends(get_current_actor)) -> Dict[str, Any]:
    community = await _ensure_can_manage(chat_id, int(user["id"]), role=user.get("role", ""))
    return {"chat_id": chat_id, "title": community.title, "settings": community.settings.model_dump()}


@router.post("/communities/{chat_id}/settings")
async def save_settings(
    chat_id: int,
    body: SettingsUpdate,
    user: CurrentUser = Depends(get_current_actor),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]), role=user.get("role", ""))
    try:
        saved = await db.save_community_settings(chat_id, body.cleaned())
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return {"chat_id": chat_id, "settings": saved.model_dump()}


@router.get("/communities/{chat_id}/rules")
async def get_rules(chat_id: int, user: CurrentUser = Depends(get_current_actor)) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]), role=user.get("role", ""))
    rules = await db.get_block_rules(chat_id)
    return {"chat_id": chat_id, "rules": [r.model_dump(mode="json") for r in rules]}


@router.post("/communities/{chat_id}/rules", status_code=status.HTTP_201_CREATED)
async def save_rule(
    chat_id: int,
    body: BlockRuleIn,
    user: CurrentUser = Depends(get_current_actor),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]), role=user.get("role", ""))
    existing = await db.get_block_rules(chat_id)
    if len(existing) >= 200:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Límite de 200 reglas alcanzado")
    block = await db.save_block_rule({"community_id": chat_id, **body.model_dump()})
    return {"rule": block.model_dump(mode="json")}


@router.delete("/communities/{chat_id}/rules/{block_id}")
async def delete_rule(
    chat_id: int,
    block_id: str,
    user: CurrentUser = Depends(get_current_actor),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]), role=user.get("role", ""))
    if not await db.delete_block_rule(chat_id, block_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regla no encontrada")
    return {"deleted": block_id}


@router.post("/checkout/create-order")
async def create_order(
    body: CheckoutRequest,
    user: CurrentUser = Depends(get_current_actor),
) -> Dict[str, Any]:
    if body.plan_id not in PLANS:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plan no encontrado")
    try:
        return await create_checkout(bot, int(user["id"]), body.plan_id, body.gateway)
    except PaymentError as exc:
        logger.warning("Checkout fallido (%s): %s %s", exc.gateway, exc.message, exc.details)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc


@router.post("/checkout/{transaction_id}/verify")
async def verify_order(
    transaction_id: str,
    user: CurrentUser = Depends(get_current_actor),
) -> Dict[str, Any]:
    transaction = await db.get_transaction(transaction_id)
    if transaction is None or transaction.user_id != int(user["id"]):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transacción no encontrada")
    try:
        transaction = await verify_transaction(bot, transaction)
    except PaymentError as exc:
        logger.warning("Verificación fallida (%s): %s %s", exc.gateway, exc.message, exc.details)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc
    return {"transaction": transaction.model_dump(mode="json")}