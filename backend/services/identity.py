"""
services/identity.py — Resolución de identidad compartida por ambos modos.

Reglas:
  * Usuario TMA heredado: users.user_id == Telegram ID (compatibilidad v1).
  * Usuario Standalone: users.user_id sale de standalone_user_id_seq (rango 2^52..2^53).
  * Una cuenta Standalone puede vincular su Telegram mediante deep link firmado
    por el servidor; desde entonces el initData de ese Telegram resuelve a la
    cuenta Standalone (misma billetera, mismo rango, mismo historial).
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from auth.telegram_init_data import TelegramWebAppUser
from database.models import User
from database.models_v2 import AuthIdentity, TelegramLinkNonce

LINK_NONCE_TTL = timedelta(minutes=15)
LINK_START_PREFIX = "link_"


class IdentityConflict(Exception):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def resolve_telegram_user(db: Session, tg: TelegramWebAppUser) -> User:
    """Devuelve (y si hace falta crea) el User asociado a un Telegram ID verificado.
    Seguro ante concurrencia: INSERT ... ON CONFLICT DO NOTHING."""
    identity = db.execute(
        select(AuthIdentity).where(
            AuthIdentity.provider == "telegram",
            AuthIdentity.provider_uid == str(tg.id),
        )
    ).scalar_one_or_none()

    user_id = identity.user_id if identity else tg.id

    db.execute(
        pg_insert(User.__table__)
        .values(
            user_id=user_id,
            name=tg.display_name[:64],
            role="fan",
            access_level=0,
            avatar_url=tg.photo_url,
        )
        .on_conflict_do_nothing(index_elements=["user_id"])
    )
    if not identity:
        db.execute(
            pg_insert(AuthIdentity.__table__)
            .values(user_id=user_id, provider="telegram", provider_uid=str(tg.id))
            .on_conflict_do_nothing()
        )
    db.flush()
    return db.execute(select(User).where(User.user_id == user_id)).scalar_one()


def telegram_id_for_user(db: Session, user_id: int) -> Optional[int]:
    row = db.execute(
        select(AuthIdentity.provider_uid).where(
            AuthIdentity.user_id == user_id, AuthIdentity.provider == "telegram"
        )
    ).scalar_one_or_none()
    return int(row) if row else None


def user_id_for_telegram(db: Session, telegram_id: int) -> Optional[int]:
    row = db.execute(
        select(AuthIdentity.user_id).where(
            AuthIdentity.provider == "telegram", AuthIdentity.provider_uid == str(telegram_id)
        )
    ).scalar_one_or_none()
    return int(row) if row is not None else None


def create_standalone_user(db: Session, display_name: str) -> User:
    new_id = db.execute(text("SELECT nextval('standalone_user_id_seq')")).scalar_one()
    user = User(user_id=int(new_id), name=display_name[:64] or "Operativo", role="fan", access_level=0)
    db.add(user)
    db.flush()
    return user


# ---------------- Vinculación Telegram ↔ cuenta Standalone ----------------

def _hash_nonce(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


def create_link_nonce(db: Session, user_id: int) -> str:
    if telegram_id_for_user(db, user_id):
        raise IdentityConflict("La cuenta ya tiene Telegram vinculado.")
    nonce = secrets.token_urlsafe(24)  # 32 chars; start param admite 64 [A-Za-z0-9_-]
    db.add(TelegramLinkNonce(nonce_hash=_hash_nonce(nonce), user_id=user_id,
                             expires_at=_utcnow() + LINK_NONCE_TTL))
    db.flush()
    return LINK_START_PREFIX + nonce


def consume_link_nonce(db: Session, start_param: str, telegram_id: int) -> int:
    """Llamado desde el webhook (/start link_…). El telegram_id viene de message.from,
    autenticado por el secreto del webhook. Devuelve el user_id vinculado."""
    if not start_param.startswith(LINK_START_PREFIX):
        raise IdentityConflict("Parámetro de vinculación inválido.")
    nonce_hash = _hash_nonce(start_param[len(LINK_START_PREFIX):])
    row = db.execute(
        select(TelegramLinkNonce).where(TelegramLinkNonce.nonce_hash == nonce_hash).with_for_update()
    ).scalar_one_or_none()
    if not row or row.used_at is not None or row.expires_at < _utcnow():
        raise IdentityConflict("Enlace de vinculación caducado o ya usado.")

    existing = user_id_for_telegram(db, telegram_id)
    if existing is not None and existing != row.user_id:
        # El Telegram ya tiene su propia cuenta (con saldo/historial). Fusionar
        # dos cuentas con dinero NO se hace automáticamente.
        raise IdentityConflict(
            "Este Telegram ya tiene una cuenta Alpha Vault propia. Contacta a soporte para fusionarlas."
        )
    row.used_at = _utcnow()
    if existing is None:
        db.add(AuthIdentity(user_id=row.user_id, provider="telegram", provider_uid=str(telegram_id)))
    db.flush()
    return row.user_id
