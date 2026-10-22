"""
core/config.py — Instancia única del Bot y Dispatcher de Aiogram 3.x
utilizando la configuración centralizada de core/settings.py.
"""
from __future__ import annotations

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from core.settings import get_settings

# Obtiene la configuración validada en tiempo de ejecución
settings = get_settings()

# Instancia oficial del Bot de Telegram para todo el backend
bot = Bot(
    token=settings.bot_token,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML)
)

# Dispatcher para gestión de eventos si se requieren routers nativos
dp = Dispatcher()