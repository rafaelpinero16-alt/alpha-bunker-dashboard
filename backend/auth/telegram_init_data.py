"""
auth/telegram_init_data.py — Validación criptográfica de Telegram.WebApp.initData.

Algoritmo oficial (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
    secret_key       = HMAC_SHA256(key="WebAppData", msg=bot_token)
    data_check_string = "\n".join(sorted(f"{k}={v}" for k, v in campos if k != "hash"))
    hash_esperado    = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))

Diferencias frente a users.py original:
  * Comparación en tiempo constante (hmac.compare_digest).
  * Se valida la frescura de auth_date (anti-replay de initData filtrado).
  * Se rechazan claves duplicadas (ambigüedad de parsing = vector de bypass).
  * Devuelve la identidad VERIFICADA; el cliente ya no envía user_id.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qsl

MAX_INIT_DATA_LEN = 4096
CLOCK_SKEW_TOLERANCE_S = 60


class InitDataError(Exception):
    """initData ausente, malformado, con firma inválida o caducado."""


@dataclass(frozen=True)
class TelegramWebAppUser:
    id: int
    first_name: str
    last_name: Optional[str]
    username: Optional[str]
    language_code: Optional[str]
    is_premium: bool
    photo_url: Optional[str]

    @property
    def display_name(self) -> str:
        full = f"{self.first_name} {self.last_name or ''}".strip()
        return full or (self.username or f"tg_{self.id}")


@dataclass(frozen=True)
class VerifiedInitData:
    user: TelegramWebAppUser
    auth_date: int
    query_id: Optional[str]
    start_param: Optional[str]
    chat_type: Optional[str]


def _secret_key(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()


def verify_init_data(
    init_data: str,
    bot_token: str,
    max_age_seconds: int,
    now: Optional[int] = None,
) -> VerifiedInitData:
    if not init_data or not bot_token:
        raise InitDataError("initData vacío.")
    if len(init_data) > MAX_INIT_DATA_LEN:
        raise InitDataError("initData demasiado largo.")

    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError as exc:
        raise InitDataError("initData malformado.") from exc

    fields: dict[str, str] = {}
    for key, value in pairs:
        if key in fields:
            raise InitDataError(f"Clave duplicada en initData: {key}")
        fields[key] = value

    received_hash = fields.pop("hash", None)
    if not received_hash:
        raise InitDataError("initData sin hash.")

    data_check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    expected_hash = hmac.new(
        _secret_key(bot_token), data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected_hash, received_hash.lower()):
        raise InitDataError("Firma de initData inválida.")

    try:
        auth_date = int(fields["auth_date"])
    except (KeyError, ValueError) as exc:
        raise InitDataError("auth_date ausente o inválido.") from exc

    current = int(now if now is not None else time.time())
    if auth_date > current + CLOCK_SKEW_TOLERANCE_S:
        raise InitDataError("auth_date en el futuro.")
    if current - auth_date > max_age_seconds:
        raise InitDataError("initData caducado; reabre la Mini App.")

    raw_user = fields.get("user")
    if not raw_user:
        raise InitDataError("initData sin usuario (¿abierto desde un chat inline?).")
    try:
        u = json.loads(raw_user)
        user = TelegramWebAppUser(
            id=int(u["id"]),
            first_name=str(u.get("first_name", ""))[:64],
            last_name=(str(u["last_name"])[:64] if u.get("last_name") else None),
            username=(str(u["username"])[:32] if u.get("username") else None),
            language_code=u.get("language_code"),
            is_premium=bool(u.get("is_premium", False)),
            photo_url=u.get("photo_url"),
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise InitDataError("Campo user inválido.") from exc

    if u.get("is_bot"):
        raise InitDataError("Los bots no pueden autenticarse.")

    return VerifiedInitData(
        user=user,
        auth_date=auth_date,
        query_id=fields.get("query_id"),
        start_param=fields.get("start_param"),
        chat_type=fields.get("chat_type"),
    )


def sign_init_data_for_tests(fields: dict[str, str], bot_token: str) -> str:
    """Genera initData firmado. SOLO para tests automatizados."""
    from urllib.parse import urlencode

    dcs = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    h = hmac.new(_secret_key(bot_token), dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": h})
