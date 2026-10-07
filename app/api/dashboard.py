"""API REST del Alpha Bunker Dashboard (consumida por la Mini App)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Literal, Optional

from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import TelegramAPIError
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.auth import get_current_telegram_user
from app.bot.dispatcher import bot
from app.config import settings
from app.services.database import (
    ActionType,
    BlacklistAction,
    Community,
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


# ---------------------------------------------------------------------------
# Esquemas de entrada
# ---------------------------------------------------------------------------
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
# Utilidades
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


async def _ensure_can_manage(chat_id: int, user_id: int) -> Community:
    """Permite gestionar si el usuario registró la comunidad o es admin en Telegram."""
    community = await db.get_community(chat_id)
    if community is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comunidad no registrada")
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
# Endpoints
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
async def user_info(user: CurrentUser = Depends(get_current_telegram_user)) -> Dict[str, Any]:
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
async def list_communities(user: CurrentUser = Depends(get_current_telegram_user)) -> Dict[str, Any]:
    communities = await db.get_user_communities(int(user["id"]), only_admin=True)
    items = []
    for community in communities:
        rules = await db.get_block_rules(community.chat_id)
        items.append(_serialize_community(community, len(rules)))
    return {"communities": items}


@router.get("/communities/{chat_id}/settings")
async def get_settings(chat_id: int, user: CurrentUser = Depends(get_current_telegram_user)) -> Dict[str, Any]:
    community = await _ensure_can_manage(chat_id, int(user["id"]))
    return {"chat_id": chat_id, "title": community.title, "settings": community.settings.model_dump()}


@router.post("/communities/{chat_id}/settings")
async def save_settings(
    chat_id: int,
    body: SettingsUpdate,
    user: CurrentUser = Depends(get_current_telegram_user),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]))
    try:
        saved = await db.save_community_settings(chat_id, body.cleaned())
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return {"chat_id": chat_id, "settings": saved.model_dump()}


@router.get("/communities/{chat_id}/rules")
async def get_rules(chat_id: int, user: CurrentUser = Depends(get_current_telegram_user)) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]))
    rules = await db.get_block_rules(chat_id)
    return {"chat_id": chat_id, "rules": [r.model_dump(mode="json") for r in rules]}


@router.post("/communities/{chat_id}/rules", status_code=status.HTTP_201_CREATED)
async def save_rule(
    chat_id: int,
    body: BlockRuleIn,
    user: CurrentUser = Depends(get_current_telegram_user),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]))
    existing = await db.get_block_rules(chat_id)
    if len(existing) >= 200:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Límite de 200 reglas alcanzado")
    block = await db.save_block_rule({"community_id": chat_id, **body.model_dump()})
    return {"rule": block.model_dump(mode="json")}


@router.delete("/communities/{chat_id}/rules/{block_id}")
async def delete_rule(
    chat_id: int,
    block_id: str,
    user: CurrentUser = Depends(get_current_telegram_user),
) -> Dict[str, Any]:
    await _ensure_can_manage(chat_id, int(user["id"]))
    if not await db.delete_block_rule(chat_id, block_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regla no encontrada")
    return {"deleted": block_id}


@router.post("/checkout/create-order")
async def create_order(
    body: CheckoutRequest,
    user: CurrentUser = Depends(get_current_telegram_user),
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
    user: CurrentUser = Depends(get_current_telegram_user),
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

