"""Capa de persistencia asíncrona — The Bunker OS / Alpha Bunker Dashboard.

Almacén en memoria protegido por `asyncio.Lock` con persistencia JSON atómica
(escritura a archivo temporal + `os.replace`) ejecutada en un hilo para no
bloquear el event loop. Todos los métodos devuelven copias profundas de los
modelos para que nadie mute el estado fuera del lock.

Módulo enriquecido con soporte de Cuentas del Portal (Arquitecto Maestro / Creadores),
Autenticación Dual (Email / Teléfono + Password Hash PBKDF2) y Desafíos de Captcha Alfanuméricos.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple
from uuid import uuid4

try:
    from pydantic import BaseModel, Field  # type: ignore[import-not-found]
    PYDANTIC_V2 = True
except ImportError:  # pragma: no cover - compatibilidad con pydantic v1
    from pydantic.v1 import BaseModel, Field  # type: ignore[import-not-found]
    PYDANTIC_V2 = False

if not PYDANTIC_V2:
    def _model_validate(cls, obj: Any) -> BaseModel:
        return cls.parse_obj(obj)

    def _model_copy(self, *, deep: bool = False, update: Optional[Dict[str, Any]] = None) -> BaseModel:
        if update is None:
            return self.copy(deep=deep)
        return self.copy(update=update, deep=deep)

    def _model_dump(self, *, mode: str = "python", **kwargs: Any) -> Dict[str, Any]:
        if mode == "json":
            return json.loads(self.json())
        return self.dict(**kwargs)

    BaseModel.model_validate = classmethod(_model_validate)
    BaseModel.model_copy = _model_copy
    BaseModel.model_dump = _model_dump

from app.config import settings

logger = logging.getLogger(__name__)

# ==========================================
# 👑 TIPOS Y PERMISOS DEL PORTAL
# ==========================================
AccountRole = Literal["master", "creator", "admin"]
TransactionStatus = Literal["pending", "completed", "failed"]
GatewayName = Literal["stars", "paypal", "binance", "global66", "payoneer"]
TriggerType = Literal["command", "keyword", "join"]
ActionType = Literal["send_message", "add_role", "kick", "payment_wall"]
BlacklistAction = Literal["delete", "delete_and_warn", "kick"]

SUPPORTED_LANGUAGES = ("es", "en", "it", "fr", "de", "pt")

RAW_ADMINS = os.getenv("ADMIN_IDS", "")
MASTER_ADMIN_IDS = {int(x.strip()) for x in RAW_ADMINS.split(",") if x.strip().isdigit()}
MASTER_ADMIN_IDS.update([8269470905, 1738976493])


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_language(code: Optional[str]) -> str:
    if not code:
        return "es"
    short = code.split("-")[0].lower()
    return short if short in SUPPORTED_LANGUAGES else "es"


def normalize_phone(phone: Optional[str]) -> str:
    if not phone:
        return ""
    clean = re.sub(r"[^\d+]", "", phone.strip())
    if clean and not clean.startswith("+"):
        clean = f"+{clean}"
    return clean


# ==========================================
# 🔒 UTILIDADES CRIPTOGRÁFICAS PARA CUENTAS
# ==========================================
def hash_password(password: str, salt: Optional[str] = None) -> Tuple[str, str]:
    """Genera hash criptográfico PBKDF2-HMAC-SHA256 con salt aleatorio."""
    if not salt:
        salt = secrets.token_hex(16)
    key = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        100_000,
    )
    return key.hex(), salt


def verify_password(password: str, password_hash: str, salt: str) -> bool:
    """Verificación segura contra ataques de tiempo."""
    computed_hash, _ = hash_password(password, salt)
    return hmac.compare_digest(computed_hash, password_hash)


def generate_captcha_code(length: int = 5) -> str:
    """Genera código alfanumérico excluyendo caracteres confusos (0, O, 1, I)."""
    charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "".join(secrets.choice(charset) for _ in range(length))


# ---------------------------------------------------------------------------
# Modelos de Datos
# ---------------------------------------------------------------------------
class PortalAccount(BaseModel):
    """Cuenta de acceso web para el panel/dashboard de creadores y del Arquitecto Maestro."""
    id: str = Field(default_factory=lambda: uuid4().hex)
    email: Optional[str] = None
    phone: Optional[str] = None
    password_hash: str
    salt: str
    role: AccountRole = "creator"
    telegram_id: Optional[int] = None
    first_name: str = "Creador"
    is_active: bool = True
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class User(BaseModel):
    user_id: int
    username: Optional[str] = None
    first_name: str = ""
    language_code: str = "es"
    created_at: datetime = Field(default_factory=utcnow)


class CommunitySettings(BaseModel):
    welcome_enabled: bool = True
    welcome_message: str = Field(
        default="👋 ¡Bienvenido/a <b>{first_name}</b> a <b>{chat_title}</b>!",
        max_length=2000,
    )
    captcha_enabled: bool = False
    captcha_timeout: int = Field(default=120, ge=30, le=3600)
    auto_roles: List[str] = Field(default_factory=list)
    blacklist: List[str] = Field(default_factory=list)
    blacklist_action: BlacklistAction = "delete"


class Community(BaseModel):
    chat_id: int
    title: str
    owner_id: int
    chat_type: str = "supergroup"
    bot_is_admin: bool = False
    settings: CommunitySettings = Field(default_factory=CommunitySettings)
    member_roles: Dict[str, List[str]] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Transaction(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    user_id: int
    plan_id: str
    plan_name: str
    amount: float
    currency: str
    gateway: GatewayName
    status: TransactionStatus = "pending"
    external_id: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class PuzzleBlock(BaseModel):
    block_id: str = Field(default_factory=lambda: uuid4().hex[:12])
    community_id: int
    trigger_type: TriggerType
    trigger_value: str = ""
    action_type: ActionType
    payload: Dict[str, Any] = Field(default_factory=dict)
    enabled: bool = True
    created_at: datetime = Field(default_factory=utcnow)


# ---------------------------------------------------------------------------
# Base de datos Principal
# ---------------------------------------------------------------------------
class Database:
    """Repositorio asíncrono con persistencia JSON y control integral de accesos."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._users: Dict[int, User] = {}
        self._communities: Dict[int, Community] = {}
        self._transactions: Dict[str, Transaction] = {}
        self._blocks: Dict[str, PuzzleBlock] = {}
        self._accounts: Dict[str, PortalAccount] = {}
        # Memoria volátil para retos de captcha (token -> (codigo, timestamp_expiracion))
        self._captchas: Dict[str, Tuple[str, float]] = {}

    # --- Ciclo de vida -----------------------------------------------------
    async def connect(self) -> None:
        async with self._lock:
            if not self._path.exists():
                logger.info("Base de datos nueva en %s", self._path)
                await self._persist_unlocked()
                return
            raw = await asyncio.to_thread(self._path.read_text, encoding="utf-8")
            data: Dict[str, Any] = json.loads(raw) if raw.strip() else {}
            self._users = {u["user_id"]: User.model_validate(u) for u in data.get("users", [])}
            self._communities = {
                c["chat_id"]: Community.model_validate(c) for c in data.get("communities", [])
            }
            self._transactions = {
                t["id"]: Transaction.model_validate(t) for t in data.get("transactions", [])
            }
            self._blocks = {b["block_id"]: PuzzleBlock.model_validate(b) for b in data.get("blocks", [])}
            self._accounts = {
                a["id"]: PortalAccount.model_validate(a) for a in data.get("accounts", [])
            }
            logger.info(
                "BD cargada: %d usuarios, %d comunidades, %d transacciones, %d bloques, %d cuentas de portal",
                len(self._users),
                len(self._communities),
                len(self._transactions),
                len(self._blocks),
                len(self._accounts),
            )

    async def close(self) -> None:
        async with self._lock:
            await self._persist_unlocked()

    def _snapshot(self) -> Dict[str, Any]:
        return {
            "users": [u.model_dump(mode="json") for u in self._users.values()],
            "communities": [c.model_dump(mode="json") for c in self._communities.values()],
            "transactions": [t.model_dump(mode="json") for t in self._transactions.values()],
            "blocks": [b.model_dump(mode="json") for b in self._blocks.values()],
            "accounts": [a.model_dump(mode="json") for a in self._accounts.values()],
        }

    def _atomic_write(self, payload: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=str(self._path.parent), prefix=".db-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, self._path)
        except BaseException:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

    async def _persist_unlocked(self) -> None:
        payload = json.dumps(self._snapshot(), ensure_ascii=False, indent=2)
        await asyncio.to_thread(self._atomic_write, payload)

    # --- Autenticación y Captchas -----------------------------------------
    async def create_captcha(self, ttl_seconds: int = 300) -> Dict[str, str]:
        """Genera un reto captcha en memoria con tiempo de vida (TTL)."""
        token = uuid4().hex
        code = generate_captcha_code(5)
        expires_at = asyncio.get_running_loop().time() + ttl_seconds
        async with self._lock:
            # Purgar retos expirados
            now = asyncio.get_running_loop().time()
            self._captchas = {k: v for k, v in self._captchas.items() if v[1] > now}
            self._captchas[token] = (code, expires_at)
        return {"token": token, "code": code}

    async def verify_captcha(self, token: str, code: str) -> bool:
        """Verifica y consume un reto de captcha."""
        if not token or not code:
            return False
        clean_code = code.strip().upper()
        now = asyncio.get_running_loop().time()
        async with self._lock:
            challenge = self._captchas.pop(token, None)
            if not challenge:
                return False
            expected_code, expires_at = challenge
            if now > expires_at:
                return False
            return hmac.compare_digest(clean_code, expected_code)

    async def create_portal_account(
        self,
        password: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        first_name: str = "Creador",
        telegram_id: Optional[int] = None,
        role: Optional[AccountRole] = None,
    ) -> PortalAccount:
        """Registra una cuenta nueva garantizando unicidad de correo o teléfono."""
        clean_email = email.strip().lower() if email else None
        clean_phone = normalize_phone(phone) if phone else None

        if not clean_email and not clean_phone:
            raise ValueError("Debes proporcionar al menos un correo electrónico o un número de teléfono.")

        async with self._lock:
            for acc in self._accounts.values():
                if clean_email and acc.email and acc.email.lower() == clean_email:
                    raise ValueError("El correo electrónico ya está registrado.")
                if clean_phone and acc.phone and acc.phone == clean_phone:
                    raise ValueError("El número de teléfono ya está registrado.")

            # Determinación de Rol: si coincide con la lista blanca de Arquitectos es master
            assigned_role = role or "creator"
            if telegram_id and telegram_id in MASTER_ADMIN_IDS:
                assigned_role = "master"

            pwd_hash, salt = hash_password(password)

            account = PortalAccount(
                email=clean_email,
                phone=clean_phone,
                password_hash=pwd_hash,
                salt=salt,
                role=assigned_role,
                telegram_id=int(telegram_id) if telegram_id else None,
                first_name=first_name.strip() or "Creador",
                is_active=True,
            )
            self._accounts[account.id] = account
            await self._persist_unlocked()
            return account.model_copy(deep=True)

    async def authenticate_portal_account(self, login_identifier: str, password: str) -> Optional[PortalAccount]:
        """Autentica por correo o por teléfono."""
        clean_ident = login_identifier.strip().lower()
        clean_phone = normalize_phone(login_identifier)

        async with self._lock:
            target_account: Optional[PortalAccount] = None
            for acc in self._accounts.values():
                if acc.email and acc.email.lower() == clean_ident:
                    target_account = acc
                    break
                if acc.phone and clean_phone and acc.phone == clean_phone:
                    target_account = acc
                    break

            if not target_account or not target_account.is_active:
                return None

            if verify_password(password, target_account.password_hash, target_account.salt):
                return target_account.model_copy(deep=True)
            return None

    async def get_portal_account_by_id(self, account_id: str) -> Optional[PortalAccount]:
        async with self._lock:
            acc = self._accounts.get(account_id)
            return acc.model_copy(deep=True) if acc else None

    async def get_portal_account_by_telegram(self, telegram_id: int) -> Optional[PortalAccount]:
        async with self._lock:
            for acc in self._accounts.values():
                if acc.telegram_id == int(telegram_id):
                    return acc.model_copy(deep=True)
            return None

    async def link_telegram_account(self, account_id: str, telegram_id: int) -> Optional[PortalAccount]:
        async with self._lock:
            acc = self._accounts.get(account_id)
            if not acc:
                return None
            role = "master" if int(telegram_id) in MASTER_ADMIN_IDS else acc.role
            updated = acc.model_copy(update={"telegram_id": int(telegram_id), "role": role, "updated_at": utcnow()})
            self._accounts[account_id] = updated
            await self._persist_unlocked()
            return updated.model_copy(deep=True)

    # --- Usuarios Telegram --------------------------------------------------
    async def upsert_user(self, user_data: Dict[str, Any]) -> User:
        user_id = int(user_data["user_id"])
        async with self._lock:
            existing = self._users.get(user_id)
            if existing is None:
                user = User(
                    user_id=user_id,
                    username=user_data.get("username"),
                    first_name=user_data.get("first_name") or "",
                    language_code=normalize_language(user_data.get("language_code")),
                )
            else:
                user = existing.model_copy(
                    update={
                        "username": user_data.get("username", existing.username),
                        "first_name": user_data.get("first_name") or existing.first_name,
                    }
                )
            changed = existing is None or existing.model_dump() != user.model_dump()
            self._users[user_id] = user
            if changed:
                await self._persist_unlocked()
            return user.model_copy(deep=True)

    async def get_user(self, user_id: int) -> Optional[User]:
        async with self._lock:
            user = self._users.get(int(user_id))
            return user.model_copy(deep=True) if user else None

    async def set_user_language(self, user_id: int, language_code: str) -> Optional[User]:
        async with self._lock:
            user = self._users.get(int(user_id))
            if user is None:
                return None
            user.language_code = normalize_language(language_code)
            await self._persist_unlocked()
            return user.model_copy(deep=True)

    # --- Transacciones --------------------------------------------------------
    async def save_transaction(
        self,
        user_id: int,
        plan_id: str,
        plan_name: str,
        amount: float,
        currency: str,
        gateway: GatewayName,
        status: TransactionStatus = "pending",
        external_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Transaction:
        transaction = Transaction(
            user_id=int(user_id),
            plan_id=plan_id,
            plan_name=plan_name,
            amount=float(amount),
            currency=currency.upper(),
            gateway=gateway,
            status=status,
            external_id=external_id,
            metadata=metadata or {},
        )
        async with self._lock:
            self._transactions[transaction.id] = transaction
            await self._persist_unlocked()
            return transaction.model_copy(deep=True)

    async def update_transaction_status(
        self,
        transaction_id: str,
        status: TransactionStatus,
        external_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        expected_status: Optional[TransactionStatus] = None,
    ) -> Optional[Transaction]:
        async with self._lock:
            transaction = self._transactions.get(transaction_id)
            if transaction is None:
                return None
            if expected_status is not None and transaction.status != expected_status:
                return None
            transaction.status = status
            if external_id:
                transaction.external_id = external_id
            if metadata:
                transaction.metadata.update(metadata)
            transaction.updated_at = utcnow()
            await self._persist_unlocked()
            return transaction.model_copy(deep=True)

    async def set_transaction_external_id(self, transaction_id: str, external_id: str) -> None:
        async with self._lock:
            transaction = self._transactions.get(transaction_id)
            if transaction is None:
                return
            transaction.external_id = external_id
            transaction.updated_at = utcnow()
            await self._persist_unlocked()

    async def get_transaction(self, transaction_id: str) -> Optional[Transaction]:
        async with self._lock:
            transaction = self._transactions.get(transaction_id)
            return transaction.model_copy(deep=True) if transaction else None

    async def get_transaction_by_external_id(self, external_id: str) -> Optional[Transaction]:
        async with self._lock:
            for transaction in self._transactions.values():
                if transaction.external_id == external_id:
                    return transaction.model_copy(deep=True)
            return None

    async def get_user_transactions(self, user_id: int) -> List[Transaction]:
        async with self._lock:
            items = [t for t in self._transactions.values() if t.user_id == int(user_id)]
            items.sort(key=lambda t: t.created_at, reverse=True)
            return [t.model_copy(deep=True) for t in items]

    # --- Comunidades ----------------------------------------------------------
    async def upsert_community(
        self,
        chat_id: int,
        title: str,
        owner_id: int,
        bot_is_admin: bool,
        chat_type: str = "supergroup",
    ) -> Community:
        async with self._lock:
            community = self._communities.get(int(chat_id))
            if community is None:
                community = Community(
                    chat_id=int(chat_id),
                    title=title,
                    owner_id=int(owner_id),
                    bot_is_admin=bot_is_admin,
                    chat_type=chat_type,
                )
                self._communities[community.chat_id] = community
            else:
                community.title = title
                community.bot_is_admin = bot_is_admin
                community.chat_type = chat_type
                community.updated_at = utcnow()
            await self._persist_unlocked()
            return community.model_copy(deep=True)

    async def set_bot_admin(self, chat_id: int, bot_is_admin: bool) -> None:
        async with self._lock:
            community = self._communities.get(int(chat_id))
            if community is None:
                return
            community.bot_is_admin = bot_is_admin
            community.updated_at = utcnow()
            await self._persist_unlocked()

    async def get_community(self, chat_id: int) -> Optional[Community]:
        async with self._lock:
            community = self._communities.get(int(chat_id))
            return community.model_copy(deep=True) if community else None

    async def get_user_communities(self, user_id: int, only_admin: bool = False) -> List[Community]:
        async with self._lock:
            items = [
                c
                for c in self._communities.values()
                if c.owner_id == int(user_id) and (c.bot_is_admin or not only_admin)
            ]
            items.sort(key=lambda c: c.title.lower())
            return [c.model_copy(deep=True) for c in items]

    async def save_community_settings(self, chat_id: int, settings_data: Dict[str, Any]) -> CommunitySettings:
        async with self._lock:
            community = self._communities.get(int(chat_id))
            if community is None:
                raise KeyError(f"Comunidad {chat_id} no registrada")
            merged = {**community.settings.model_dump(), **settings_data}
            community.settings = CommunitySettings.model_validate(merged)
            community.updated_at = utcnow()
            await self._persist_unlocked()
            return community.settings.model_copy(deep=True)

    async def get_community_settings(self, chat_id: int) -> CommunitySettings:
        async with self._lock:
            community = self._communities.get(int(chat_id))
            if community is None:
                return CommunitySettings()
            return community.settings.model_copy(deep=True)

    async def assign_role(self, chat_id: int, user_id: int, role: str) -> List[str]:
        role = role.strip()
        async with self._lock:
            community = self._communities.get(int(chat_id))
            if community is None or not role:
                return []
            roles = community.member_roles.setdefault(str(user_id), [])
            if role not in roles:
                roles.append(role)
                await self._persist_unlocked()
            return list(roles)

    # --- Bloques lógicos (PuzzleBlocks) --------------------------------------
    async def save_block_rule(self, block_data: Dict[str, Any]) -> PuzzleBlock:
        block = PuzzleBlock.model_validate(block_data)
        async with self._lock:
            self._blocks[block.block_id] = block
            await self._persist_unlocked()
            return block.model_copy(deep=True)

    async def get_block_rules(self, chat_id: int) -> List[PuzzleBlock]:
        async with self._lock:
            items = [b for b in self._blocks.values() if b.community_id == int(chat_id)]
            items.sort(key=lambda b: b.created_at)
            return [b.model_copy(deep=True) for b in items]

    async def delete_block_rule(self, chat_id: int, block_id: str) -> bool:
        async with self._lock:
            block = self._blocks.get(block_id)
            if block is None or block.community_id != int(chat_id):
                return False
            del self._blocks[block_id]
            await self._persist_unlocked()
            return True

    # --- Métricas -------------------------------------------------------------
    async def stats(self) -> Dict[str, int]:
        async with self._lock:
            return {
                "users": len(self._users),
                "communities": len(self._communities),
                "protected_communities": sum(1 for c in self._communities.values() if c.bot_is_admin),
                "transactions": len(self._transactions),
                "completed_transactions": sum(
                    1 for t in self._transactions.values() if t.status == "completed"
                ),
                "rules": len(self._blocks),
                "accounts": len(self._accounts),
            }


db = Database(settings.DATABASE_PATH)