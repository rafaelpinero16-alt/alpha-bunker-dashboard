"""Capa de persistencia asíncrona.

Almacén en memoria protegido por `asyncio.Lock` con persistencia JSON atómica
(escritura a archivo temporal + `os.replace`) ejecutada en un hilo para no
bloquear el event loop. Todos los métodos devuelven copias profundas de los
modelos para que nadie mute el estado fuera del lock.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
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

TransactionStatus = Literal["pending", "completed", "failed"]
GatewayName = Literal["stars", "paypal", "binance", "global66", "payoneer"]
TriggerType = Literal["command", "keyword", "join"]
ActionType = Literal["send_message", "add_role", "kick", "payment_wall"]
BlacklistAction = Literal["delete", "delete_and_warn", "kick"]

SUPPORTED_LANGUAGES = ("es", "en", "it", "fr", "de", "pt")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_language(code: Optional[str]) -> str:
    if not code:
        return "es"
    short = code.split("-")[0].lower()
    return short if short in SUPPORTED_LANGUAGES else "es"


# ---------------------------------------------------------------------------
# Modelos
# ---------------------------------------------------------------------------
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
# Base de datos
# ---------------------------------------------------------------------------
class Database:
    """Repositorio asíncrono con persistencia JSON."""

    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._lock = asyncio.Lock()
        self._users: Dict[int, User] = {}
        self._communities: Dict[int, Community] = {}
        self._transactions: Dict[str, Transaction] = {}
        self._blocks: Dict[str, PuzzleBlock] = {}

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
            logger.info(
                "BD cargada: %d usuarios, %d comunidades, %d transacciones, %d bloques",
                len(self._users),
                len(self._communities),
                len(self._transactions),
                len(self._blocks),
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

    # --- Usuarios -----------------------------------------------------------
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
                # El idioma elegido por el usuario se conserva; solo se refrescan datos de perfil.
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
        """Actualiza el estado. Con `expected_status` actúa como compare-and-set
        atómico: devuelve `None` si el estado actual no coincide."""
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
        """Fusiona `settings_data` con la configuración actual y la valida."""
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
            }


db = Database(settings.DATABASE_PATH)
