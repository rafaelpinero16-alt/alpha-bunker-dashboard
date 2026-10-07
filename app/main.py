"""Punto de entrada de Alpha Bunker Dashboard (FastAPI + aiogram 3 vía webhook)."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Dict

from aiogram.exceptions import TelegramAPIError
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api import dashboard, webhooks
from app.bot.dispatcher import bot, dp
from app.config import settings
from app.services.database import db
from app.services.payments import payment_service

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("alpha_bunker")

BASE_DIR = Path(__file__).resolve().parent.parent
PUBLIC_DIR = BASE_DIR / "public"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Inicio: BD + webhook en Telegram. Cierre: elimina webhook y libera sesiones."""
    await db.connect()
    me = await bot.get_me()
    app.state.bot_username = me.username
    await bot.set_webhook(
        url=settings.webhook_url,
        secret_token=settings.WEBHOOK_SECRET,
        drop_pending_updates=True,
        allowed_updates=dp.resolve_used_update_types(),
    )
    logger.info("Bot @%s activo. Webhook: %s", me.username, settings.webhook_url)
    try:
        yield
    finally:
        try:
            await bot.delete_webhook()
        except TelegramAPIError as exc:
            logger.warning("No se pudo eliminar el webhook: %s", exc)
        await bot.session.close()
        await payment_service.close()
        await db.close()
        logger.info("Alpha Bunker detenido correctamente")


app = FastAPI(
    title="Alpha Bunker Dashboard API",
    version="1.0.0",
    description="Backend del Alpha Bunker Dashboard y motor del bot de Telegram.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Telegram-Init-Data"],
)

app.include_router(webhooks.router)
app.include_router(dashboard.router)


@app.get("/health", tags=["system"])
async def health() -> Dict[str, Any]:
    """Certifica que la API, el bot y el webhook están operativos."""
    result: Dict[str, Any] = {"api": "online", "bot": "offline", "webhook": "unknown"}
    try:
        me = await bot.get_me()
        info = await bot.get_webhook_info()
        result["bot"] = "online"
        result["bot_username"] = me.username
        result["webhook"] = "ok" if info.url == settings.webhook_url else "mismatch"
        result["pending_updates"] = info.pending_update_count
        if info.last_error_message:
            result["webhook_last_error"] = info.last_error_message
    except TelegramAPIError as exc:
        result["error"] = str(exc)
    result["database"] = await db.stats()
    result["status"] = "ok" if result["bot"] == "online" and result["webhook"] == "ok" else "degraded"
    return result


# El montaje estático va al final para no ocultar las rutas de la API.
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.SERVER_HOST, port=settings.SERVER_PORT, proxy_headers=True)
