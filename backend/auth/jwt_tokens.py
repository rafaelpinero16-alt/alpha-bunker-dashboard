"""
auth/jwt_tokens.py — Tokens de sesión para el modo Standalone (Web / APK) y TMA.

* Access token: JWT HS256 de vida corta (15 min por defecto). Firmado, no cifrado:
  no contiene datos sensibles (solo sub/modo/sid), así que JWE no aporta nada
  y complica el cliente. Lo que impide la suplantación es la FIRMA.
* Refresh token: opaco (no JWT), aleatorio, guardado como SHA-256 en BD,
  rotado en cada uso con detección de reutilización por familia.
* WS ticket: JWT de 60 s con typ="ws", porque el navegador no permite
  cabeceras Authorization en el handshake de WebSocket.
"""
from __future__ import annotations

import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Literal, Optional

import jwt

from core.settings import get_settings

AuthMode = Literal["telegram", "standalone"]
_ALG = "HS256"


class TokenError(Exception):
    pass


@dataclass(frozen=True)
class AccessClaims:
    user_id: int
    auth_mode: AuthMode
    session_id: str
    jti: str


def _now() -> int:
    return int(time.time())


def issue_access_token(user_id: int, auth_mode: AuthMode, session_id: str) -> tuple[str, int]:
    s = get_settings()
    now = _now()
    exp = now + s.access_token_ttl_s
    token = jwt.encode(
        {
            "iss": s.jwt_issuer,
            "aud": s.jwt_audience,
            "sub": str(user_id),
            "typ": "access",
            "mode": auth_mode,
            "sid": session_id,
            "jti": uuid.uuid4().hex,
            "iat": now,
            "nbf": now,
            "exp": exp,
        },
        s.jwt_secret,
        algorithm=_ALG,
    )
    return token, exp


def _decode(token: str, expected_typ: str) -> dict:
    s = get_settings()
    try:
        claims = jwt.decode(
            token,
            s.jwt_secret,
            algorithms=[_ALG],  # lista cerrada: bloquea "alg=none" y confusión de algoritmos
            audience=s.jwt_audience,
            issuer=s.jwt_issuer,
            options={"require": ["exp", "iat", "sub", "typ", "jti"]},
            leeway=10,
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("typ") != expected_typ:
        raise TokenError("Tipo de token incorrecto.")
    return claims


def decode_access_token(token: str) -> AccessClaims:
    c = _decode(token, "access")
    mode = c.get("mode")
    if mode not in ("telegram", "standalone"):
        raise TokenError("Modo de autenticación inválido.")
    try:
        user_id = int(c["sub"])
    except ValueError as exc:
        raise TokenError("sub inválido.") from exc
    return AccessClaims(user_id=user_id, auth_mode=mode, session_id=str(c.get("sid", "")), jti=c["jti"])


def issue_ws_ticket(user_id: int, auth_mode: AuthMode) -> tuple[str, int]:
    s = get_settings()
    now = _now()
    exp = now + s.ws_ticket_ttl_s
    token = jwt.encode(
        {
            "iss": s.jwt_issuer,
            "aud": s.jwt_audience,
            "sub": str(user_id),
            "typ": "ws",
            "mode": auth_mode,
            "jti": uuid.uuid4().hex,
            "iat": now,
            "exp": exp,
        },
        s.jwt_secret,
        algorithm=_ALG,
    )
    return token, exp


def decode_ws_ticket(token: str) -> tuple[int, AuthMode, str]:
    c = _decode(token, "ws")
    return int(c["sub"]), c.get("mode", "standalone"), c["jti"]


# ---------------- Refresh tokens opacos ----------------

def new_refresh_token() -> tuple[str, str]:
    """Devuelve (token_en_claro_para_el_cliente, hash_sha256_para_la_BD)."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_session_id() -> str:
    return uuid.uuid4().hex


def optional_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        raise TokenError("Cabecera Authorization mal formada.")
    return value.strip()
