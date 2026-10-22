"""
main_v2_wiring.py — Cómo integrar la v2 en tu main.py existente.

Copia el lifespan y los include_router a tu app. Mantén temporalmente los
routers v1 de solo lectura que el front aún use, pero DESREGISTRA YA:
    payments.verify_stars_payment, wallet.deposit, creators.subscribe_creator_tier,
    telegram.telegram_webhook (v1)
y apunta el webhook al endpoint v2 (scripts/set_webhook.py).
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.config import bot
from core.settings import get_settings
from routers import app_support_v2, auth_v2, chat_v2, kyc_v2, media_v2, payments_v2, social_v2, webhook_v2
from services.realtime import init_hub
from services.telegram_community import TelegramCommunityService, membership_worker
from services.ton_verifier import verify_pending_ton_orders

log = logging.getLogger("alpha")


async def _ton_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await verify_pending_ton_orders()
        except Exception:
            log.exception("[TON] ciclo falló")
        try:
            await asyncio.wait_for(stop.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()                # falla aquí si falta configuración
    hub = await init_hub(settings.redis_url)
    community = TelegramCommunityService(bot)
    await community.verify_bot_permissions()  # log de errores si faltan permisos

    stop = asyncio.Event()
    tasks = [
        asyncio.create_task(membership_worker(community, stop)),
        asyncio.create_task(_ton_loop(stop)),
    ]
    try:
        yield
    finally:
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        await hub.stop()
        await bot.session.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Alpha Bunker API", version="2.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,  # usamos Authorization/X-Telegram-Init-Data, no cookies
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Telegram-Init-Data"],
        max_age=600,
    )
    for r in (
        auth_v2.router,
        payments_v2.router,
        webhook_v2.router,
        chat_v2.router,
        kyc_v2.router,
        social_v2.router,
        media_v2.router,
        app_support_v2.router,  # 👈 Agregar este router
    ):
      app.include_router(r)