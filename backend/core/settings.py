"""
core/settings.py — Configuración centralizada, tipada y fail-fast.

Regla: NINGÚN secreto tiene valor por defecto en el código. Si falta una
variable obligatoria, el proceso no arranca (mejor caer en el deploy que
servir pagos con un secreto público como "AlphaBunker2026").
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from functools import lru_cache


class ConfigError(RuntimeError):
    pass


def _req(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(f"Variable de entorno obligatoria ausente: {name}")
    return value


def _opt(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


def _id_list(name: str) -> frozenset[int]:
    raw = _opt(name)
    return frozenset(int(x) for x in raw.split(",") if x.strip())


_WEBHOOK_SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


@dataclass(frozen=True)
class Settings:
    # --- Telegram ---
    bot_token: str
    bot_username: str
    webhook_secret: str
    mini_app_url: str
    public_backend_url: str

    # --- Auth ---
    jwt_secret: str
    jwt_issuer: str
    jwt_audience: str
    access_token_ttl_s: int
    refresh_token_ttl_days: int
    init_data_max_age_s: int
    ws_ticket_ttl_s: int

    # --- Infra ---
    database_url: str
    redis_url: str
    cors_origins: tuple[str, ...]

    # --- Administración (solo bootstrap; la fuente de verdad es users.role) ---
    bootstrap_admin_ids: frozenset[int]

    # --- Canales VIP por tier ---
    tier_chat_ids: dict[str, int] = field(default_factory=dict)

    # --- Video ---
    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    mesh_max_publishers: int = 4

    # --- TON ---
    ton_receiver_address: str = ""
    toncenter_api_key: str = ""
    toncenter_base_url: str = "https://toncenter.com/api/v3"

    # --- KYC (almacenamiento de objetos privado) ---
    kyc_s3_bucket: str = ""
    kyc_s3_region: str = ""
    kyc_s3_endpoint_url: str = ""
    kyc_max_upload_bytes: int = 8 * 1024 * 1024

    # --- Workers ---
    membership_worker_interval_s: int = 300
    moderation_terms_file: str = ""
    media_allowed_hosts: tuple[str, ...] = ()
    media_s3_bucket: str = ""
    media_public_base_url: str = ""

    @property
    def livekit_enabled(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    @property
    def ton_enabled(self) -> bool:
        return bool(self.ton_receiver_address)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    webhook_secret = _req("TELEGRAM_WEBHOOK_SECRET")
    if not _WEBHOOK_SECRET_RE.match(webhook_secret):
        raise ConfigError(
            "TELEGRAM_WEBHOOK_SECRET debe tener 32-256 caracteres [A-Za-z0-9_-] "
            "(genera uno con: python -c 'import secrets;print(secrets.token_urlsafe(48))')"
        )

    jwt_secret = _req("JWT_SECRET")
    if len(jwt_secret) < 32:
        raise ConfigError("JWT_SECRET debe tener al menos 32 caracteres aleatorios.")

    tier_chat_ids: dict[str, int] = {}
    for slug, env_name in (
        ("soldier", "CHANNEL_SOLDIER_ID"),
        ("veteran", "CHANNEL_VETERAN_ID"),
        ("legend", "CHANNEL_LEGEND_ID"),
        ("icon-legend", "CHANNEL_ICON_LEGEND_ID"),
    ):
        raw = _opt(env_name)
        if raw:
            if not raw.startswith("-100"):
                raise ConfigError(f"{env_name} debe ser un ID de supergrupo/canal (-100…).")
            tier_chat_ids[slug] = int(raw)

    cors = tuple(o.strip() for o in _req("CORS_ORIGINS").split(",") if o.strip())
    if "*" in cors:
        raise ConfigError("CORS_ORIGINS no puede ser '*' en una API con credenciales.")

    return Settings(
        bot_token=_req("TELEGRAM_BOT_TOKEN"),
        bot_username=_req("TELEGRAM_BOT_USERNAME").lstrip("@"),
        webhook_secret=webhook_secret,
        mini_app_url=_req("MINI_APP_URL"),
        public_backend_url=_req("PUBLIC_BACKEND_URL").rstrip("/"),
        jwt_secret=jwt_secret,
        jwt_issuer=_opt("JWT_ISSUER", "alpha-bunker-api"),
        jwt_audience=_opt("JWT_AUDIENCE", "alpha-bunker-clients"),
        access_token_ttl_s=_int("ACCESS_TOKEN_TTL_S", 900),
        refresh_token_ttl_days=_int("REFRESH_TOKEN_TTL_DAYS", 30),
        init_data_max_age_s=_int("INIT_DATA_MAX_AGE_S", 86400),
        ws_ticket_ttl_s=_int("WS_TICKET_TTL_S", 60),
        database_url=_req("DATABASE_URL"),
        redis_url=_opt("REDIS_URL"),
        cors_origins=cors,
        bootstrap_admin_ids=_id_list("BOOTSTRAP_ADMIN_TELEGRAM_IDS"),
        tier_chat_ids=tier_chat_ids,
        livekit_url=_opt("LIVEKIT_URL"),
        livekit_api_key=_opt("LIVEKIT_API_KEY"),
        livekit_api_secret=_opt("LIVEKIT_API_SECRET"),
        mesh_max_publishers=_int("MESH_MAX_PUBLISHERS", 4),
        ton_receiver_address=_opt("TON_RECEIVER_ADDRESS"),
        toncenter_api_key=_opt("TONCENTER_API_KEY"),
        toncenter_base_url=_opt("TONCENTER_BASE_URL", "https://toncenter.com/api/v3"),
        kyc_s3_bucket=_opt("KYC_S3_BUCKET"),
        kyc_s3_region=_opt("KYC_S3_REGION"),
        kyc_s3_endpoint_url=_opt("KYC_S3_ENDPOINT_URL"),
        kyc_max_upload_bytes=_int("KYC_MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
        membership_worker_interval_s=_int("MEMBERSHIP_WORKER_INTERVAL_S", 300),
        moderation_terms_file=_opt("MODERATION_TERMS_FILE"),
        media_s3_bucket=_opt("MEDIA_S3_BUCKET"),
        media_public_base_url=_opt("MEDIA_PUBLIC_BASE_URL").rstrip("/"),
        media_allowed_hosts=tuple(h.strip().lower() for h in _opt("MEDIA_ALLOWED_HOSTS").split(",") if h.strip()),
    )
