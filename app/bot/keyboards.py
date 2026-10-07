"""Fábrica de teclados inline del bot y callback data tipados."""
from __future__ import annotations

from typing import Dict

from aiogram.filters.callback_data import CallbackData
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from aiogram.utils.keyboard import InlineKeyboardBuilder

from app.services.payments import sorted_plans

LANGUAGES: Dict[str, str] = {
    "es": "🇪🇸 Español",
    "en": "🇬🇧 English",
    "it": "🇮🇹 Italiano",
    "fr": "🇫🇷 Français",
    "de": "🇩🇪 Deutsch",
    "pt": "🇧🇷 Português",
}


class MenuCallback(CallbackData, prefix="menu"):
    action: str


class PlanCallback(CallbackData, prefix="plan"):
    plan_id: str


class GatewayCallback(CallbackData, prefix="gw"):
    plan_id: str
    gateway: str


class LanguageCallback(CallbackData, prefix="lang"):
    code: str


class CaptchaCallback(CallbackData, prefix="cap"):
    chat_id: int
    user_id: int


def main_menu_keyboard(dashboard_url: str) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(
        InlineKeyboardButton(
            text="🛡️ Abrir Alpha Bunker Dashboard",
            web_app=WebAppInfo(url=dashboard_url),
        )
    )
    builder.row(
        InlineKeyboardButton(text="📦 Catálogo de Planes", callback_data=MenuCallback(action="plans").pack())
    )
    builder.row(
        InlineKeyboardButton(text="🛠️ Soporte 24/7", callback_data=MenuCallback(action="support").pack()),
        InlineKeyboardButton(text="🌐 Cambiar Idioma", callback_data=MenuCallback(action="language").pack()),
    )
    return builder.as_markup()


def dashboard_keyboard(dashboard_url: str) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(
        InlineKeyboardButton(
            text="🛡️ Abrir Alpha Bunker Dashboard",
            web_app=WebAppInfo(url=dashboard_url),
        )
    )
    return builder.as_markup()


def plans_selection_keyboard() -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    for plan in sorted_plans():
        builder.row(
            InlineKeyboardButton(
                text=f"{plan.emoji} Nivel {plan.level}: {plan.name} (${plan.price_usd:.0f} USD)",
                callback_data=PlanCallback(plan_id=plan.id).pack(),
            )
        )
    builder.row(InlineKeyboardButton(text="⬅️ Volver", callback_data=MenuCallback(action="home").pack()))
    return builder.as_markup()


def gateway_selection_keyboard(plan_id: str) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(
        InlineKeyboardButton(
            text="⭐ Telegram Stars",
            callback_data=GatewayCallback(plan_id=plan_id, gateway="stars").pack(),
        )
    )
    builder.row(
        InlineKeyboardButton(
            text="🅿️ PayPal",
            callback_data=GatewayCallback(plan_id=plan_id, gateway="paypal").pack(),
        ),
        InlineKeyboardButton(
            text="🪙 Binance Pay",
            callback_data=GatewayCallback(plan_id=plan_id, gateway="binance").pack(),
        ),
    )
    builder.row(
        InlineKeyboardButton(
            text="⬅️ Volver",
            callback_data=GatewayCallback(plan_id=plan_id, gateway="back").pack(),
        )
    )
    return builder.as_markup()


def language_keyboard() -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    for code, label in LANGUAGES.items():
        builder.button(text=label, callback_data=LanguageCallback(code=code).pack())
    builder.adjust(2)
    builder.row(InlineKeyboardButton(text="⬅️ Volver", callback_data=MenuCallback(action="home").pack()))
    return builder.as_markup()


def payment_link_keyboard(url: str, label: str) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text=label, url=url))
    builder.row(InlineKeyboardButton(text="⬅️ Planes", callback_data=MenuCallback(action="plans").pack()))
    return builder.as_markup()


def captcha_keyboard(chat_id: int, user_id: int) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(
        InlineKeyboardButton(
            text="✅ No soy un robot",
            callback_data=CaptchaCallback(chat_id=chat_id, user_id=user_id).pack(),
        )
    )
    return builder.as_markup()


def payment_wall_keyboard(bot_username: str, plan_id: str, label: str = "🔓 Desbloquear acceso") -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text=label, url=f"https://t.me/{bot_username}?start=plan_{plan_id}"))
    return builder.as_markup()


def back_to_menu_keyboard() -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.row(InlineKeyboardButton(text="⬅️ Menú principal", callback_data=MenuCallback(action="home").pack()))
    return builder.as_markup()
