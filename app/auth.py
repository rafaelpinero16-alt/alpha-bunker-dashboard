"""Autenticación de Telegram Mini Apps (validación criptográfica de `initData`)."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl

from fastapi import Header, HTTPException, status  # type: ignore[import-not-found]

from app.config import settings
from app.services.database import db

logger = logging.getLogger(__name__)


def validate_telegram_data(
    init_data: str,
    bot_token: str,
    max_age_seconds: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Valida el `initData` de una Mini App según la especificación oficial.

    1. secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    2. data_check_string = pares "clave=valor" (excepto `hash`) ordenados y unidos por "\\n"
    3. hash esperado = HEX(HMAC_SHA256(key=secret_key, msg=data_check_string))

    Devuelve el usuario parseado (con `auth_date`, `start_param` y `query_id`)
    si la firma es válida y no ha expirado; en otro caso `None`.
    """
    if not init_data or not bot_token:
        return None

    try:
        pairs: Dict[str, str] = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=True))
    except ValueError:
        logger.debug("initData con formato inválido")
        return None

    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        logger.warning("Firma de initData inválida")
        return None

    try:
        auth_date = int(pairs.get("auth_date", "0"))
    except ValueError:
        return None

    max_age = settings.INIT_DATA_MAX_AGE if max_age_seconds is None else max_age_seconds
    if auth_date <= 0 or (max_age > 0 and time.time() - auth_date > max_age):
        logger.info("initData expirado (auth_date=%s)", auth_date)
        return None

    raw_user = pairs.get("user")
    if not raw_user:
        return None
    try:
        user: Dict[str, Any] = json.loads(raw_user)
    except json.JSONDecodeError:
        return None
    if not isinstance(user, dict) or "id" not in user:
        return None

    user["auth_date"] = auth_date
    user["start_param"] = pairs.get("start_param")
    user["query_id"] = pairs.get("query_id")
    return user


def _extract_init_data(x_telegram_init_data: Optional[str], authorization: Optional[str]) -> Optional[str]:
    if x_telegram_init_data:
        return x_telegram_init_data
    if authorization and authorization.lower().startswith("tma "):
        return authorization[4:].strip()
    return None


async def get_current_telegram_user(
    x_telegram_init_data: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    """Dependencia FastAPI que protege los endpoints del dashboard.

    Acepta el initData en el header `X-Telegram-Init-Data` o como
    `Authorization: tma <initData>`. Registra/actualiza al usuario en la BD.
    """
    init_data = _extract_init_data(x_telegram_init_data, authorization)
    if not init_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Falta initData de Telegram. Abre el dashboard desde la Mini App.",
        )

    user = validate_telegram_data(init_data, settings.BOT_TOKEN)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="initData inválido o expirado.",
        )

    await db.upsert_user(
        {
            "user_id": int(user["id"]),
            "username": user.get("username"),
            "first_name": user.get("first_name", ""),
            "language_code": user.get("language_code"),
        }
    )
    return user
