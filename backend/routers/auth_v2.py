"""
routers/auth_v2.py — Emisión de sesiones para ambos modos.

POST /v2/auth/telegram        initData (header) → par de tokens            [TMA]
POST /v2/auth/register        email + contraseña → par de tokens           [Standalone]
POST /v2/auth/login           email + contraseña → par de tokens           [Standalone]
POST /v2/auth/refresh         rotación de refresh token con detección de reutilización
POST /v2/auth/logout          revoca la familia del refresh token
POST /v2/auth/ws-ticket       ticket de 60 s para abrir WebSockets
POST /v2/auth/link/telegram   deep link t.me/<bot>?start=link_<nonce>    [Standalone]
GET  /v2/auth/me              perfil mínimo del principal
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from auth.dependencies import Principal, StrictBody, authenticate, get_current_principal
from auth.jwt_tokens import (
    AuthMode, hash_refresh_token, issue_access_token, issue_ws_ticket,
    new_refresh_token, new_session_id,
)
from core.settings import get_settings
from database.db import get_db
from database.models_v2 import AuthIdentity, RefreshToken
from services.identity import IdentityConflict, create_link_nonce, create_standalone_user

router = APIRouter(prefix="/v2/auth", tags=["Auth v2"])
_ph = PasswordHasher()  # argon2id, parámetros por defecto de argon2-cffi
# Hash ficticio para igualar tiempos cuando el email no existe (anti-enumeración).
_DUMMY_HASH = _ph.hash("timing-equalizer-not-a-password")


class RegisterBody(StrictBody):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    display_name: str = Field(min_length=2, max_length=48)


class LoginBody(StrictBody):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshBody(StrictBody):
    refresh_token: str = Field(min_length=20, max_length=200)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _issue_pair(db: Session, user_id: int, mode: AuthMode, request: Request,
                family_id: Optional[str] = None) -> dict:
    s = get_settings()
    sid = family_id or new_session_id()
    access, access_exp = issue_access_token(user_id, mode, sid)
    raw_refresh, refresh_hash = new_refresh_token()
    db.add(RefreshToken(
        user_id=user_id,
        token_hash=refresh_hash,
        family_id=sid,
        auth_mode=mode,
        expires_at=_utcnow() + timedelta(days=s.refresh_token_ttl_days),
        user_agent=(request.headers.get("user-agent") or "")[:255],
    ))
    db.commit()
    return {
        "token_type": "Bearer",
        "access_token": access,
        "access_expires_at": access_exp,
        "refresh_token": raw_refresh,
        "user_id": user_id,
        "auth_mode": mode,
    }


@router.post("/telegram")
def login_with_telegram(
    request: Request,
    x_telegram_init_data: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
    db: Session = Depends(get_db),
):
    if not x_telegram_init_data:
        raise HTTPException(status_code=401, detail="Falta X-Telegram-Init-Data.")
    principal = authenticate(db, x_telegram_init_data, None)
    return _issue_pair(db, principal.user_id, "telegram", request)


@router.post("/register", status_code=201)
def register(body: RegisterBody, request: Request, db: Session = Depends(get_db)):
    email = body.email.lower()
    user = create_standalone_user(db, body.display_name)
    db.add(AuthIdentity(user_id=user.user_id, provider="password",
                        provider_uid=email, secret_hash=_ph.hash(body.password)))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        # Mensaje genérico: no confirmamos qué emails existen.
        raise HTTPException(status_code=409, detail="No se pudo registrar con esos datos.")
    return _issue_pair(db, user.user_id, "standalone", request)


@router.post("/login")
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)):
    identity = db.execute(
        select(AuthIdentity).where(AuthIdentity.provider == "password",
                                   AuthIdentity.provider_uid == body.email.lower())
    ).scalar_one_or_none()
    try:
        _ph.verify(identity.secret_hash if identity else _DUMMY_HASH, body.password)
        if identity is None:
            raise VerifyMismatchError()
    except (VerifyMismatchError, InvalidHashError):
        raise HTTPException(status_code=401, detail="Credenciales inválidas.")

    if _ph.check_needs_rehash(identity.secret_hash):
        identity.secret_hash = _ph.hash(body.password)
    return _issue_pair(db, identity.user_id, "standalone", request)


@router.post("/refresh")
def refresh(body: RefreshBody, request: Request, db: Session = Depends(get_db)):
    token = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(body.refresh_token))
        .with_for_update()
    ).scalar_one_or_none()
    if not token or token.revoked_at is not None or token.expires_at < _utcnow():
        raise HTTPException(status_code=401, detail="Refresh token inválido.")

    if token.used_at is not None:
        # Reutilización = robo probable: revocamos TODA la familia.
        db.execute(update(RefreshToken).where(RefreshToken.family_id == token.family_id)
                   .values(revoked_at=_utcnow()))
        db.commit()
        raise HTTPException(status_code=401, detail="Sesión revocada por reutilización de token.")

    token.used_at = _utcnow()
    return _issue_pair(db, token.user_id, token.auth_mode, request, family_id=token.family_id)


@router.post("/logout", status_code=204)
def logout(body: RefreshBody, db: Session = Depends(get_db)):
    token = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(body.refresh_token))
    ).scalar_one_or_none()
    if token:
        db.execute(update(RefreshToken).where(RefreshToken.family_id == token.family_id)
                   .values(revoked_at=_utcnow()))
        db.commit()


@router.post("/ws-ticket")
def ws_ticket(principal: Principal = Depends(get_current_principal)):
    ticket, exp = issue_ws_ticket(principal.user_id, principal.auth_mode)
    return {"ticket": ticket, "expires_at": exp}


@router.post("/link/telegram")
def link_telegram(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    if principal.telegram_id:
        raise HTTPException(status_code=409, detail="Tu cuenta ya tiene Telegram vinculado.")
    try:
        start_param = create_link_nonce(db, principal.user_id)
    except IdentityConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    db.commit()
    s = get_settings()
    return {"deep_link": f"https://t.me/{s.bot_username}?start={start_param}", "expires_in_s": 900}


@router.get("/me")
def me(principal: Principal = Depends(get_current_principal)):
    return {
        "user_id": principal.user_id,
        "auth_mode": principal.auth_mode,
        "telegram_linked": principal.telegram_id is not None,
        "role": principal.role,
        "access_level": principal.access_level,
    }
