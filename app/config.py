"""Configuración centralizada de Alpha Bunker Dashboard (pydantic-settings)."""
from __future__ import annotations

import re
from typing import Any, List, Literal, Optional
from urllib.parse import urlparse

from pydantic import field_validator  # type: ignore[import-not-found]
from pydantic_settings import BaseSettings, SettingsConfigDict  # type: ignore[import-not-found]

_SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,256}$")


class Settings(BaseSettings):
    """Carga y valida todas las variables definidas en `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Telegram ---------------------------------------------------------
    BOT_TOKEN: str
    WEBHOOK_HOST: str
    WEBHOOK_PATH: str = "/api/v1/telegram/webhook"
    WEBHOOK_SECRET: str
    DASHBOARD_URL: str
    ADMIN_TELEGRAM_ID: int
    VIP_CHAT_ID: Optional[int] = None
    STARS_PER_USD: float = 77.0
    INIT_DATA_MAX_AGE: int = 86400

    # --- Servidor ---------------------------------------------------------
    SERVER_HOST: str = "0.0.0.0"
    SERVER_PORT: int = 8000
    DATABASE_PATH: str = "data/alpha_bunker.json"

    # --- PayPal -----------------------------------------------------------
    PAYPAL_CLIENT_ID: str = ""
    PAYPAL_CLIENT_SECRET: str = ""
    PAYPAL_MODE: Literal["sandbox", "live"] = "sandbox"
    PAYPAL_WEBHOOK_ID: str = ""

    # --- Binance Pay ------------------------------------------------------
    BINANCE_API_KEY: str = ""
    BINANCE_API_SECRET: str = ""

    # --- Pagos manuales ---------------------------------------------------
    GLOBAL66_ACCOUNT: str = ""
    PAYONEER_EMAIL: str = ""

    # --- Validadores ------------------------------------------------------
    @field_validator("VIP_CHAT_ID", mode="before")
    @classmethod
    def _empty_to_none(cls, value: Any) -> Any:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return value

    @field_validator("WEBHOOK_SECRET")
    @classmethod
    def _validate_secret(cls, value: str) -> str:
        if not _SECRET_PATTERN.match(value):
            raise ValueError(
                "WEBHOOK_SECRET debe tener 1-256 caracteres: letras, números, '_' o '-'."
            )
        return value

    @field_validator("WEBHOOK_HOST", "DASHBOARD_URL")
    @classmethod
    def _validate_https(cls, value: str) -> str:
        value = value.strip()
        if not value.startswith("https://"):
            raise ValueError("WEBHOOK_HOST y DASHBOARD_URL deben usar HTTPS (requisito de Telegram).")
        return value

    @field_validator("WEBHOOK_PATH")
    @classmethod
    def _validate_path(cls, value: str) -> str:
        value = value.strip()
        return value if value.startswith("/") else f"/{value}"

    @field_validator("PAYPAL_MODE", mode="before")
    @classmethod
    def _normalize_mode(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value

    # --- Propiedades derivadas -------------------------------------------
    @property
    def webhook_url(self) -> str:
        """URL absoluta del webhook: WEBHOOK_HOST + WEBHOOK_PATH sin barras duplicadas."""
        return f"{self.WEBHOOK_HOST.rstrip('/')}/{self.WEBHOOK_PATH.lstrip('/')}"

    @property
    def public_base_url(self) -> str:
        return self.WEBHOOK_HOST.rstrip("/")

    @property
    def paypal_base_url(self) -> str:
        if self.PAYPAL_MODE == "live":
            return "https://api-m.paypal.com"
        return "https://api-m.sandbox.paypal.com"

    @property
    def paypal_enabled(self) -> bool:
        return bool(self.PAYPAL_CLIENT_ID and self.PAYPAL_CLIENT_SECRET)

    @property
    def binance_enabled(self) -> bool:
        return bool(self.BINANCE_API_KEY and self.BINANCE_API_SECRET)

    @property
    def cors_origins(self) -> List[str]:
        """Orígenes permitidos: cliente web de Telegram + dominios propios."""
        origins = {"https://web.telegram.org"}
        for url in (self.DASHBOARD_URL, self.WEBHOOK_HOST):
            parsed = urlparse(url)
            if parsed.scheme and parsed.netloc:
                origins.add(f"{parsed.scheme}://{parsed.netloc}")
        return sorted(origins)


settings = Settings()  # type: ignore[call-arg]
