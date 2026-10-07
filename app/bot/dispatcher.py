"""Inicialización del Bot y del Dispatcher de aiogram 3."""
from __future__ import annotations

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app.bot import handlers
from app.config import settings

bot = Bot(
    token=settings.BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)

dp = Dispatcher()

# El router privado va primero; el de grupos contiene el handler genérico de
# mensajes (lista negra y bloques lógicos) y debe evaluarse al final.
dp.include_routers(handlers.router, handlers.group_router)
