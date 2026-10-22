"""
scripts/set_webhook.py — Registra el webhook v2 y verifica permisos del bot.

    cd backend && python -m scripts.set_webhook

Imprime un informe por canal VIP; si alguno sale "FALTAN PERMISOS", ve a
docs/DESPLIEGUE.md §3.
"""
from __future__ import annotations

import asyncio

from aiogram import Bot

from core.settings import get_settings
from services.telegram_community import TelegramCommunityService

ALLOWED_UPDATES = ["message", "pre_checkout_query", "chat_join_request", "chat_member", "my_chat_member"]


async def main() -> None:
    s = get_settings()
    bot = Bot(s.bot_token)
    try:
        url = f"{s.public_backend_url}/v2/telegram/webhook"
        await bot.set_webhook(
            url=url,
            secret_token=s.webhook_secret,
            allowed_updates=ALLOWED_UPDATES,
            drop_pending_updates=False,  # NO descartar: podría haber pagos pendientes
            max_connections=40,
        )
        info = await bot.get_webhook_info()
        print(f"Webhook: {info.url}\n  pendientes={info.pending_update_count}"
              f"\n  último error={info.last_error_message or '-'}"
              f"\n  allowed_updates={info.allowed_updates}")

        for r in await TelegramCommunityService(bot).verify_bot_permissions():
            flag = "✅" if r.ok else "❌"
            print(f"{flag} {r.detail} (admin={r.is_admin}, invite={r.can_invite_users}, "
                  f"restrict={r.can_restrict_members})")
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
