"""
auth/dependencies.py — Autenticación híbrida para FastAPI.

Orígenes aceptados (y NINGUNO más):
  1. X-Telegram-Init-Data: <initData>      → firma HMAC-SHA256 con el Bot Token.
  2. Authorization: Bearer <access JWT>    → sesión emitida por /v2/auth/*.
Si llegan ambos, deben resolver al MISMO usuario o se rechaza (401).

La identidad SIEMPRE sale del Principal. Los modelos de entrada heredan de
StrictBody (extra="forbid"): un cuerpo con "user_id", "sender_id",
"follower_id"… se rechaza con 422 en vez de ignorarse en silencio.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal, Optional

from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from auth.jwt_tokens import TokenError, decode_access_token, optional_bearer
from auth.telegram_init_data import InitDataError, verify_init_data
from core.settings import get_settings
from database.db import get_db
from database.models import User
from services.identity import resolve_telegram_user, telegram_id_for_user

AuthMode = Literal["telegram", "standalone"]


class StrictBody(BaseModel):
    """Base para TODOS los cuerpos de petición v2: prohíbe campos no declarados."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


@dataclass(frozen=True)
class Principal:
    user_id: int
    auth_mode: AuthMode
    telegram_id: Optional[int]
    role: str
    access_level: int

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_creator(self) -> bool:
        return self.role in ("creator", "admin")


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": 'Bearer realm="alpha-bunker"'},
    )


def _principal_from_user(user: User, mode: AuthMode, telegram_id: Optional[int]) -> Principal:
    if getattr(user, "is_disabled", False):
        raise HTTPException(status_code=403, detail="Cuenta suspendida.")
    role = user.role or "fan"
    settings = get_settings()
    # Bootstrap: los IDs de BOOTSTRAP_ADMIN_TELEGRAM_IDS son admin aunque la BD
    # aún no lo refleje. Solo se aplica a identidades Telegram VERIFICADAS.
    if telegram_id is not None and telegram_id in settings.bootstrap_admin_ids:
        role = "admin"
    return Principal(
        user_id=int(user.user_id),
        auth_mode=mode,
        telegram_id=telegram_id,
        role=role,
        access_level=int(user.access_level or 0),
    )


def authenticate(
    db: Session,
    init_data: Optional[str],
    authorization: Optional[str],
) -> Principal:
    settings = get_settings()
    tma_principal: Optional[Principal] = None
    jwt_principal: Optional[Principal] = None

    if init_data:
        try:
            verified = verify_init_data(init_data, settings.bot_token, settings.init_data_max_age_s)
        except InitDataError as exc:
            raise _unauthorized(f"Telegram: {exc}") from exc
        user = resolve_telegram_user(db, verified.user)
        db.commit()
        tma_principal = _principal_from_user(user, "telegram", verified.user.id)

    try:
        bearer = optional_bearer(authorization)
    except TokenError as exc:
        raise _unauthorized(str(exc)) from exc

    if bearer:
        try:
            claims = decode_access_token(bearer)
        except TokenError as exc:
            raise _unauthorized(f"Sesión inválida: {exc}") from exc
        user = db.execute(select(User).where(User.user_id == claims.user_id)).scalar_one_or_none()
        if not user:
            raise _unauthorized("La cuenta ya no existe.")
        jwt_principal = _principal_from_user(user, claims.auth_mode, telegram_id_for_user(db, user.user_id))

    if tma_principal and jwt_principal and tma_principal.user_id != jwt_principal.user_id:
        raise _unauthorized("Conflicto de identidad entre initData y JWT.")

    principal = tma_principal or jwt_principal
    if principal is None:
        raise _unauthorized("Autenticación requerida.")
    return principal


def get_current_principal(
    x_telegram_init_data: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> Principal:
    return authenticate(db, x_telegram_init_data, authorization)


def get_optional_principal(
    x_telegram_init_data: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> Optional[Principal]:
    if not x_telegram_init_data and not authorization:
        return None
    return authenticate(db, x_telegram_init_data, authorization)


def require_admin(principal: Principal = Depends(get_current_principal)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status_code=403, detail="Solo administradores.")
    return principal


def require_creator(principal: Principal = Depends(get_current_principal)) -> Principal:
    if not principal.is_creator:
        raise HTTPException(status_code=403, detail="Solo creadores verificados.")
    return principal


def require_access_level(min_level: int) -> Callable[[Principal], Principal]:
    def _dep(principal: Principal = Depends(get_current_principal)) -> Principal:
        if principal.access_level < min_level and not principal.is_admin:
            raise HTTPException(status_code=403, detail=f"Requiere nivel de acceso {min_level}.")
        return principal
    return _dep
