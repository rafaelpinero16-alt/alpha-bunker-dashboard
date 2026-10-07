"""Controladores aiogram 3: chat privado, pagos con Stars y moderación de grupos."""
from __future__ import annotations

import asyncio
import logging
from html import escape
from typing import Any, Coroutine, Dict, Optional, Set, Tuple

from aiogram import Bot, F, Router
from aiogram.enums import ChatMemberStatus, ChatType
from aiogram.exceptions import TelegramAPIError, TelegramBadRequest
from aiogram.filters import JOIN_TRANSITION, ChatMemberUpdatedFilter, Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    Chat,
    ChatMemberUpdated,
    ChatPermissions,
    InlineKeyboardMarkup,
    Message,
    PreCheckoutQuery,
)
from aiogram.types import User as TgUser

from app.bot.keyboards import (
    CaptchaCallback,
    GatewayCallback,
    LanguageCallback,
    MenuCallback,
    PlanCallback,
    back_to_menu_keyboard,
    captcha_keyboard,
    dashboard_keyboard,
    gateway_selection_keyboard,
    language_keyboard,
    main_menu_keyboard,
    payment_link_keyboard,
    payment_wall_keyboard,
    plans_selection_keyboard,
)
from app.config import settings
from app.services.database import Community, CommunitySettings, PuzzleBlock, db, normalize_language
from app.services.payments import (
    PLANS,
    PaymentError,
    Plan,
    create_checkout,
    fulfill_transaction,
    notify_admin,
    payment_service,
)

logger = logging.getLogger(__name__)

router = Router(name="private")
router.message.filter(F.chat.type == ChatType.PRIVATE)

group_router = Router(name="groups")
group_router.message.filter(F.chat.type.in_({ChatType.GROUP, ChatType.SUPERGROUP}))

GROUP_TYPES = {ChatType.GROUP, ChatType.SUPERGROUP, ChatType.CHANNEL}
ADMIN_STATUSES = {ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR}

# ---------------------------------------------------------------------------
# Textos (i18n)
# ---------------------------------------------------------------------------
TEXTS: Dict[str, Dict[str, str]] = {
    "es": {
        "welcome": (
            "🛡️ <b>Bienvenido/a a Alpha Bunker, {name}</b>\n\n"
            "Tu centro de mando para proteger, automatizar y monetizar comunidades de Telegram:\n"
            "• Captcha y antispam\n• Reglas por bloques sin código\n• Canales de pago y accesos VIP\n\n"
            "Abre el Dashboard para empezar 👇"
        ),
        "dashboard": "🖥️ Gestiona tus comunidades desde el <b>Alpha Bunker Dashboard</b>:",
        "plans": "📦 <b>Catálogo de planes</b>\nElige el nivel que necesita tu comunidad:",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nElige cómo pagar:",
        "pay_link": "💳 Tu orden está lista. Completa el pago con el botón de abajo.\nReferencia: <code>{tx}</code>",
        "pay_button": "💳 Pagar ahora",
        "payment_error": "⚠️ No se pudo generar el pago: {error}",
        "choose_language": "🌐 Elige tu idioma:",
        "language_set": "✅ Idioma actualizado.",
        "support": "🛠️ <b>Soporte 24/7</b>\nEscribe al equipo de Alpha Bunker: {link}",
        "payment_invalid": "⚠️ El pago no coincide con la orden. Un administrador lo revisará.",
    },
    "en": {
        "welcome": (
            "🛡️ <b>Welcome to Alpha Bunker, {name}</b>\n\n"
            "Your command center to protect, automate and monetize Telegram communities:\n"
            "• Captcha and anti-spam\n• No-code block rules\n• Paid channels and VIP access\n\n"
            "Open the Dashboard to get started 👇"
        ),
        "dashboard": "🖥️ Manage your communities from the <b>Alpha Bunker Dashboard</b>:",
        "plans": "📦 <b>Plan catalog</b>\nPick the level your community needs:",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nChoose how to pay:",
        "pay_link": "💳 Your order is ready. Complete the payment with the button below.\nReference: <code>{tx}</code>",
        "pay_button": "💳 Pay now",
        "payment_error": "⚠️ The payment could not be created: {error}",
        "choose_language": "🌐 Choose your language:",
        "language_set": "✅ Language updated.",
        "support": "🛠️ <b>24/7 support</b>\nMessage the Alpha Bunker team: {link}",
        "payment_invalid": "⚠️ The payment does not match the order. An admin will review it.",
    },
    "it": {
        "welcome": (
            "🛡️ <b>Benvenuto/a in Alpha Bunker, {name}</b>\n\n"
            "Il tuo centro di comando per proteggere, automatizzare e monetizzare le community Telegram:\n"
            "• Captcha e anti-spam\n• Regole a blocchi senza codice\n• Canali a pagamento e accessi VIP\n\n"
            "Apri la Dashboard per iniziare 👇"
        ),
        "dashboard": "🖥️ Gestisci le tue community dalla <b>Alpha Bunker Dashboard</b>:",
        "plans": "📦 <b>Catalogo piani</b>\nScegli il livello di cui ha bisogno la tua community:",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nScegli come pagare:",
        "pay_link": "💳 Il tuo ordine è pronto. Completa il pagamento con il pulsante qui sotto.\nRiferimento: <code>{tx}</code>",
        "pay_button": "💳 Paga ora",
        "payment_error": "⚠️ Impossibile creare il pagamento: {error}",
        "choose_language": "🌐 Scegli la lingua:",
        "language_set": "✅ Lingua aggiornata.",
        "support": "🛠️ <b>Supporto 24/7</b>\nScrivi al team Alpha Bunker: {link}",
        "payment_invalid": "⚠️ Il pagamento non corrisponde all'ordine. Un amministratore lo verificherà.",
    },
    "fr": {
        "welcome": (
            "🛡️ <b>Bienvenue sur Alpha Bunker, {name}</b>\n\n"
            "Ton centre de commande pour protéger, automatiser et monétiser tes communautés Telegram :\n"
            "• Captcha et anti-spam\n• Règles par blocs sans code\n• Canaux payants et accès VIP\n\n"
            "Ouvre le Dashboard pour commencer 👇"
        ),
        "dashboard": "🖥️ Gère tes communautés depuis l'<b>Alpha Bunker Dashboard</b> :",
        "plans": "📦 <b>Catalogue des offres</b>\nChoisis le niveau dont ta communauté a besoin :",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nChoisis le mode de paiement :",
        "pay_link": "💳 Ta commande est prête. Termine le paiement avec le bouton ci-dessous.\nRéférence : <code>{tx}</code>",
        "pay_button": "💳 Payer maintenant",
        "payment_error": "⚠️ Impossible de créer le paiement : {error}",
        "choose_language": "🌐 Choisis ta langue :",
        "language_set": "✅ Langue mise à jour.",
        "support": "🛠️ <b>Support 24/7</b>\nÉcris à l'équipe Alpha Bunker : {link}",
        "payment_invalid": "⚠️ Le paiement ne correspond pas à la commande. Un admin va vérifier.",
    },
    "de": {
        "welcome": (
            "🛡️ <b>Willkommen bei Alpha Bunker, {name}</b>\n\n"
            "Deine Kommandozentrale, um Telegram-Communities zu schützen, zu automatisieren und zu monetarisieren:\n"
            "• Captcha und Anti-Spam\n• Block-Regeln ohne Code\n• Bezahlkanäle und VIP-Zugänge\n\n"
            "Öffne das Dashboard, um zu starten 👇"
        ),
        "dashboard": "🖥️ Verwalte deine Communities im <b>Alpha Bunker Dashboard</b>:",
        "plans": "📦 <b>Tarifkatalog</b>\nWähle die Stufe, die deine Community braucht:",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nWähle die Zahlungsart:",
        "pay_link": "💳 Deine Bestellung ist bereit. Schließe die Zahlung über den Button ab.\nReferenz: <code>{tx}</code>",
        "pay_button": "💳 Jetzt bezahlen",
        "payment_error": "⚠️ Die Zahlung konnte nicht erstellt werden: {error}",
        "choose_language": "🌐 Wähle deine Sprache:",
        "language_set": "✅ Sprache aktualisiert.",
        "support": "🛠️ <b>Support rund um die Uhr</b>\nSchreib dem Alpha-Bunker-Team: {link}",
        "payment_invalid": "⚠️ Die Zahlung passt nicht zur Bestellung. Ein Admin prüft das.",
    },
    "pt": {
        "welcome": (
            "🛡️ <b>Bem-vindo(a) ao Alpha Bunker, {name}</b>\n\n"
            "Seu centro de comando para proteger, automatizar e monetizar comunidades no Telegram:\n"
            "• Captcha e antispam\n• Regras em blocos sem código\n• Canais pagos e acessos VIP\n\n"
            "Abra o Dashboard para começar 👇"
        ),
        "dashboard": "🖥️ Gerencie suas comunidades pelo <b>Alpha Bunker Dashboard</b>:",
        "plans": "📦 <b>Catálogo de planos</b>\nEscolha o nível que sua comunidade precisa:",
        "plan_detail": "{emoji} <b>{name}</b> · <b>${price} USD</b>\n\n{description}\n\n{features}\n\nEscolha como pagar:",
        "pay_link": "💳 Seu pedido está pronto. Conclua o pagamento pelo botão abaixo.\nReferência: <code>{tx}</code>",
        "pay_button": "💳 Pagar agora",
        "payment_error": "⚠️ Não foi possível gerar o pagamento: {error}",
        "choose_language": "🌐 Escolha seu idioma:",
        "language_set": "✅ Idioma atualizado.",
        "support": "🛠️ <b>Suporte 24/7</b>\nFale com a equipe Alpha Bunker: {link}",
        "payment_invalid": "⚠️ O pagamento não corresponde ao pedido. Um administrador vai revisar.",
    },
}


def t(lang: str, key: str, **kwargs: object) -> str:
    template = TEXTS.get(lang, TEXTS["es"]).get(key) or TEXTS["es"][key]
    return template.format(**kwargs) if kwargs else template


async def _user_language(tg_user: Optional[TgUser]) -> str:
    if tg_user is None:
        return "es"
    stored = await db.get_user(tg_user.id)
    return stored.language_code if stored else normalize_language(tg_user.language_code)


async def _register(tg_user: TgUser) -> str:
    user = await db.upsert_user(
        {
            "user_id": tg_user.id,
            "username": tg_user.username,
            "first_name": tg_user.first_name,
            "language_code": tg_user.language_code,
        }
    )
    return user.language_code


async def _safe_edit(
    callback: CallbackQuery, text: str, reply_markup: Optional[InlineKeyboardMarkup] = None
) -> None:
    """Edita el mensaje del callback; si no es posible, envía uno nuevo."""
    message = callback.message
    if isinstance(message, Message):
        try:
            await message.edit_text(text, reply_markup=reply_markup)
            return
        except TelegramBadRequest as exc:
            if "message is not modified" in str(exc):
                return
    await callback.bot.send_message(callback.from_user.id, text, reply_markup=reply_markup)  # type: ignore[union-attr]


def _plan_text(plan: Plan, lang: str) -> str:
    features = "\n".join(f"✔️ {escape(feature)}" for feature in plan.features)
    return t(
        lang,
        "plan_detail",
        emoji=plan.emoji,
        name=escape(plan.name),
        price=f"{plan.price_usd:.0f}",
        description=escape(plan.description),
        features=features,
    )


# ---------------------------------------------------------------------------
# Chat privado
# ---------------------------------------------------------------------------
@router.message(CommandStart())
async def cmd_start(message: Message, command: CommandObject) -> None:
    if message.from_user is None:
        return
    lang = await _register(message.from_user)
    await message.answer(
        t(lang, "welcome", name=escape(message.from_user.first_name)),
        reply_markup=main_menu_keyboard(settings.DASHBOARD_URL),
    )
    args = (command.args or "").strip()
    if args.startswith("plan_"):
        plan = PLANS.get(args[len("plan_"):])
        if plan is not None:
            await message.answer(_plan_text(plan, lang), reply_markup=gateway_selection_keyboard(plan.id))


@router.message(Command("dashboard"))
async def cmd_dashboard(message: Message) -> None:
    lang = await _user_language(message.from_user)
    await message.answer(t(lang, "dashboard"), reply_markup=dashboard_keyboard(settings.DASHBOARD_URL))


@router.message(Command("planes", "plans"))
async def cmd_plans(message: Message) -> None:
    lang = await _user_language(message.from_user)
    await message.answer(t(lang, "plans"), reply_markup=plans_selection_keyboard())


@router.callback_query(MenuCallback.filter())
async def cb_menu(callback: CallbackQuery, callback_data: MenuCallback) -> None:
    lang = await _user_language(callback.from_user)
    action = callback_data.action
    if action == "plans":
        await _safe_edit(callback, t(lang, "plans"), plans_selection_keyboard())
    elif action == "language":
        await _safe_edit(callback, t(lang, "choose_language"), language_keyboard())
    elif action == "support":
        link = f'<a href="tg://user?id={settings.ADMIN_TELEGRAM_ID}">Alpha Bunker Support</a>'
        await _safe_edit(callback, t(lang, "support", link=link), back_to_menu_keyboard())
    else:
        await _safe_edit(
            callback,
            t(lang, "welcome", name=escape(callback.from_user.first_name)),
            main_menu_keyboard(settings.DASHBOARD_URL),
        )
    await callback.answer()


@router.callback_query(LanguageCallback.filter())
async def cb_language(callback: CallbackQuery, callback_data: LanguageCallback) -> None:
    await _register(callback.from_user)
    user = await db.set_user_language(callback.from_user.id, callback_data.code)
    lang = user.language_code if user else "es"
    await callback.answer(t(lang, "language_set"))
    await _safe_edit(
        callback,
        t(lang, "welcome", name=escape(callback.from_user.first_name)),
        main_menu_keyboard(settings.DASHBOARD_URL),
    )


@router.callback_query(PlanCallback.filter())
async def cb_plan(callback: CallbackQuery, callback_data: PlanCallback) -> None:
    lang = await _user_language(callback.from_user)
    plan = PLANS.get(callback_data.plan_id)
    if plan is None:
        await callback.answer("Plan no disponible", show_alert=True)
        return
    await _safe_edit(callback, _plan_text(plan, lang), gateway_selection_keyboard(plan.id))
    await callback.answer()


@router.callback_query(GatewayCallback.filter())
async def cb_gateway(callback: CallbackQuery, callback_data: GatewayCallback, bot: Bot) -> None:
    lang = await _user_language(callback.from_user)
    if callback_data.gateway == "back":
        await _safe_edit(callback, t(lang, "plans"), plans_selection_keyboard())
        await callback.answer()
        return

    await callback.answer("⏳")
    await _register(callback.from_user)
    try:
        if callback_data.gateway == "stars":
            await create_checkout(
                bot,
                callback.from_user.id,
                callback_data.plan_id,
                "stars",
                send_invoice_to=callback.from_user.id,
            )
            return
        result = await create_checkout(bot, callback.from_user.id, callback_data.plan_id, callback_data.gateway)
    except PaymentError as exc:
        logger.warning("Checkout fallido (%s): %s %s", exc.gateway, exc.message, exc.details)
        await bot.send_message(callback.from_user.id, t(lang, "payment_error", error=escape(exc.message)))
        return

    await bot.send_message(
        callback.from_user.id,
        t(lang, "pay_link", tx=result["transaction_id"]),
        reply_markup=payment_link_keyboard(result["payment_url"], t(lang, "pay_button")),
    )


# --- Pagos con Telegram Stars ------------------------------------------------
@router.pre_checkout_query()
async def on_pre_checkout(query: PreCheckoutQuery) -> None:
    parsed = payment_service.parse_invoice_payload(query.invoice_payload)
    if parsed is None:
        await query.answer(ok=False, error_message="Orden no reconocida.")
        return
    transaction = await db.get_transaction(parsed[1])
    if transaction is None or transaction.status != "pending":
        await query.answer(ok=False, error_message="Esta orden ya no está disponible. Genera una nueva.")
        return
    await query.answer(ok=True)


@router.message(F.successful_payment)
async def on_successful_payment(message: Message, bot: Bot) -> None:
    payment = message.successful_payment
    if payment is None or message.from_user is None:
        return
    lang = await _user_language(message.from_user)
    parsed = payment_service.parse_invoice_payload(payment.invoice_payload)
    transaction = await db.get_transaction(parsed[1]) if parsed else None

    if (
        transaction is None
        or payment.currency != "XTR"
        or payment.total_amount < int(transaction.amount)
        or transaction.user_id != message.from_user.id
    ):
        await message.answer(t(lang, "payment_invalid"))
        await notify_admin(
            bot,
            "⚠️ <b>Pago Stars sin conciliar</b>\n"
            f"Usuario: <code>{message.from_user.id}</code>\n"
            f"Payload: <code>{escape(payment.invoice_payload)}</code>\n"
            f"Monto: {payment.total_amount} {payment.currency}\n"
            f"Charge ID: <code>{payment.telegram_payment_charge_id}</code>",
        )
        return

    await fulfill_transaction(
        bot,
        transaction.id,
        external_id=payment.telegram_payment_charge_id,
        metadata={"total_amount": payment.total_amount, "currency": payment.currency},
    )


# ---------------------------------------------------------------------------
# Grupos y canales
# ---------------------------------------------------------------------------
_pending_captchas: Dict[Tuple[int, int], int] = {}
_background_tasks: Set["asyncio.Task[None]"] = set()


def _spawn(coro: Coroutine[Any, Any, None]) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def _render(template: str, user: TgUser, chat: Chat) -> str:
    return (
        template.replace("{first_name}", escape(user.first_name))
        .replace("{username}", f"@{escape(user.username)}" if user.username else escape(user.first_name))
        .replace("{chat_title}", escape(chat.title or ""))
        .replace("{user_id}", str(user.id))
    )


async def _send_html_safe(
    bot: Bot,
    chat_id: int,
    text: str,
    reply_markup: Optional[InlineKeyboardMarkup] = None,
    reply_to_message_id: Optional[int] = None,
) -> Optional[Message]:
    """Envía HTML; si el HTML escrito por el admin es inválido, reintenta como texto plano."""
    try:
        return await bot.send_message(
            chat_id, text, reply_markup=reply_markup, reply_to_message_id=reply_to_message_id
        )
    except TelegramBadRequest:
        try:
            return await bot.send_message(
                chat_id,
                text,
                parse_mode=None,
                reply_markup=reply_markup,
                reply_to_message_id=reply_to_message_id,
            )
        except TelegramAPIError as exc:
            logger.warning("No se pudo enviar mensaje a %s: %s", chat_id, exc)
            return None
    except TelegramAPIError as exc:
        logger.warning("No se pudo enviar mensaje a %s: %s", chat_id, exc)
        return None


async def _is_chat_admin(bot: Bot, chat_id: int, user_id: int) -> bool:
    try:
        member = await bot.get_chat_member(chat_id, user_id)
    except TelegramAPIError:
        return False
    return member.status in ADMIN_STATUSES


async def _kick(bot: Bot, chat_id: int, user_id: int) -> bool:
    try:
        await bot.ban_chat_member(chat_id, user_id)
        await bot.unban_chat_member(chat_id, user_id, only_if_banned=True)
        return True
    except TelegramAPIError as exc:
        logger.warning("No se pudo expulsar a %s de %s: %s", user_id, chat_id, exc)
        return False


async def _send_welcome(bot: Bot, chat: Chat, user: TgUser, community_settings: CommunitySettings) -> None:
    if community_settings.welcome_enabled and community_settings.welcome_message.strip():
        await _send_html_safe(bot, chat.id, _render(community_settings.welcome_message, user, chat))


@group_router.my_chat_member()
async def on_bot_membership(event: ChatMemberUpdated, bot: Bot) -> None:
    """Registra la comunidad cuando el bot es añadido, promovido o expulsado."""
    chat = event.chat
    if chat.type not in GROUP_TYPES:
        return
    status = event.new_chat_member.status
    if status in {ChatMemberStatus.LEFT, ChatMemberStatus.KICKED}:
        await db.set_bot_admin(chat.id, False)
        return

    is_admin = status in ADMIN_STATUSES
    existing = await db.get_community(chat.id)
    owner_id = existing.owner_id if existing else event.from_user.id
    await db.upsert_community(
        chat_id=chat.id,
        title=chat.title or str(chat.id),
        owner_id=owner_id,
        bot_is_admin=is_admin,
        chat_type=str(getattr(chat.type, "value", chat.type)),
    )

    state = "🟢 activo como administrador" if is_admin else "🟡 añadido sin permisos de administrador"
    try:
        await bot.send_message(
            owner_id,
            f"🛡️ <b>{escape(chat.title or '')}</b>: Alpha Bunker {state}.\n"
            "Configúralo desde el dashboard.",
            reply_markup=dashboard_keyboard(settings.DASHBOARD_URL),
        )
    except TelegramAPIError:
        logger.info("El propietario %s aún no ha iniciado el bot", owner_id)

    if is_admin and chat.type != ChatType.CHANNEL and (
        existing is None or not existing.bot_is_admin
    ):
        await _send_html_safe(bot, chat.id, "🛡️ <b>Alpha Bunker</b> está protegiendo este grupo.")


@group_router.chat_member(ChatMemberUpdatedFilter(member_status_changed=JOIN_TRANSITION))
async def on_member_join(event: ChatMemberUpdated, bot: Bot) -> None:
    community = await db.get_community(event.chat.id)
    if community is None or not community.bot_is_admin:
        return
    member = event.new_chat_member.user
    if member.is_bot:
        return

    community_settings = community.settings
    for role in community_settings.auto_roles:
        await db.assign_role(event.chat.id, member.id, role)

    if community_settings.captcha_enabled and event.chat.type != ChatType.CHANNEL:
        await _start_captcha(bot, event.chat, member, community_settings)
    else:
        await _send_welcome(bot, event.chat, member, community_settings)

    for rule in await db.get_block_rules(event.chat.id):
        if rule.enabled and rule.trigger_type == "join":
            await _execute_rule(bot, event.chat, member, rule, community, reply_to=None)


async def _start_captcha(bot: Bot, chat: Chat, user: TgUser, community_settings: CommunitySettings) -> None:
    try:
        await bot.restrict_chat_member(chat.id, user.id, permissions=ChatPermissions(can_send_messages=False))
    except TelegramAPIError as exc:
        logger.warning("Sin permisos para restringir en %s: %s", chat.id, exc)
        await _send_welcome(bot, chat, user, community_settings)
        return

    mention = f'<a href="tg://user?id={user.id}">{escape(user.first_name)}</a>'
    message = await _send_html_safe(
        bot,
        chat.id,
        f"🔐 {mention}, pulsa el botón en {community_settings.captcha_timeout} s "
        "para confirmar que eres humano.",
        reply_markup=captcha_keyboard(chat.id, user.id),
    )
    if message is None:
        return
    _pending_captchas[(chat.id, user.id)] = message.message_id
    _spawn(_captcha_timeout(bot, chat.id, user.id, community_settings.captcha_timeout, message.message_id))


async def _captcha_timeout(bot: Bot, chat_id: int, user_id: int, timeout: int, message_id: int) -> None:
    await asyncio.sleep(timeout)
    if _pending_captchas.pop((chat_id, user_id), None) is None:
        return
    await _kick(bot, chat_id, user_id)
    try:
        await bot.delete_message(chat_id, message_id)
    except TelegramAPIError:
        pass


@group_router.callback_query(CaptchaCallback.filter())
async def cb_captcha(callback: CallbackQuery, callback_data: CaptchaCallback, bot: Bot) -> None:
    if callback.from_user.id != callback_data.user_id:
        await callback.answer("Este botón no es para ti.", show_alert=True)
        return
    key = (callback_data.chat_id, callback_data.user_id)
    message_id = _pending_captchas.pop(key, None)
    if message_id is None:
        await callback.answer("Verificación expirada o ya completada.")
        return

    try:
        chat_info = await bot.get_chat(callback_data.chat_id)
        permissions = chat_info.permissions or ChatPermissions(
            can_send_messages=True,
            can_send_audios=True,
            can_send_documents=True,
            can_send_photos=True,
            can_send_videos=True,
            can_send_video_notes=True,
            can_send_voice_notes=True,
            can_send_polls=True,
            can_send_other_messages=True,
            can_add_web_page_previews=True,
        )
        await bot.restrict_chat_member(callback_data.chat_id, callback_data.user_id, permissions=permissions)
    except TelegramAPIError as exc:
        logger.error("No se pudo levantar la restricción: %s", exc)
        await callback.answer("No se pudo verificar. Avisa a un administrador.", show_alert=True)
        return

    await callback.answer("✅ Verificado")
    try:
        await bot.delete_message(callback_data.chat_id, message_id)
    except TelegramAPIError:
        pass

    community = await db.get_community(callback_data.chat_id)
    if community is not None:
        await _send_welcome(bot, chat_info, callback.from_user, community.settings)


@group_router.message(F.text | F.caption)
async def on_group_message(message: Message, bot: Bot) -> None:
    if message.from_user is None:
        return
    community = await db.get_community(message.chat.id)
    if community is None or not community.bot_is_admin:
        return

    text = message.text or message.caption or ""
    community_settings = community.settings
    lowered = text.casefold()

    if community_settings.blacklist and any(
        word.strip() and word.strip().casefold() in lowered for word in community_settings.blacklist
    ):
        if not await _is_chat_admin(bot, message.chat.id, message.from_user.id):
            await _apply_blacklist(bot, message, community_settings)
            return

    await _run_message_rules(bot, message, community, text)


async def _apply_blacklist(bot: Bot, message: Message, community_settings: CommunitySettings) -> None:
    user = message.from_user
    if user is None:
        return
    try:
        await message.delete()
    except TelegramAPIError as exc:
        logger.warning("No se pudo borrar mensaje en %s: %s", message.chat.id, exc)
    mention = f'<a href="tg://user?id={user.id}">{escape(user.first_name)}</a>'
    if community_settings.blacklist_action == "delete_and_warn":
        await _send_html_safe(bot, message.chat.id, f"⚠️ {mention}, ese contenido no está permitido aquí.")
    elif community_settings.blacklist_action == "kick":
        if await _kick(bot, message.chat.id, user.id):
            await _send_html_safe(bot, message.chat.id, f"🚫 {mention} fue expulsado por contenido prohibido.")


async def _run_message_rules(bot: Bot, message: Message, community: Community, text: str) -> None:
    rules = await db.get_block_rules(message.chat.id)
    if not rules or message.from_user is None:
        return
    stripped = text.strip()
    command: Optional[str] = None
    if stripped.startswith("/"):
        command = stripped.split()[0][1:].split("@")[0].casefold()
    lowered = stripped.casefold()

    for rule in rules:
        if not rule.enabled:
            continue
        trigger = rule.trigger_value.strip().lstrip("/").casefold()
        matched = (rule.trigger_type == "command" and command is not None and command == trigger) or (
            rule.trigger_type == "keyword" and bool(trigger) and trigger in lowered
        )
        if matched:
            await _execute_rule(bot, message.chat, message.from_user, rule, community, reply_to=message)


async def _execute_rule(
    bot: Bot,
    chat: Chat,
    user: TgUser,
    rule: PuzzleBlock,
    community: Community,
    reply_to: Optional[Message],
) -> None:
    payload = rule.payload
    reply_id = reply_to.message_id if reply_to else None

    if rule.action_type == "send_message":
        text = str(payload.get("text", "")).strip()
        if text:
            await _send_html_safe(bot, chat.id, _render(text, user, chat), reply_to_message_id=reply_id)

    elif rule.action_type == "add_role":
        role = str(payload.get("role", "")).strip()
        if role:
            await db.assign_role(chat.id, user.id, role)
            if payload.get("announce", True):
                await _send_html_safe(
                    bot,
                    chat.id,
                    f"🏷️ {escape(user.first_name)} ahora tiene el rol <b>{escape(role)}</b>.",
                    reply_to_message_id=reply_id,
                )

    elif rule.action_type == "kick":
        if await _is_chat_admin(bot, chat.id, user.id):
            return
        if await _kick(bot, chat.id, user.id):
            reason = str(payload.get("reason", "")).strip()
            suffix = f" Motivo: {escape(reason)}" if reason else ""
            await _send_html_safe(bot, chat.id, f"🚫 {escape(user.first_name)} fue expulsado.{suffix}")

    elif rule.action_type == "payment_wall":
        plan_id = str(payload.get("plan_id", ""))
        plan = PLANS.get(plan_id)
        if plan is None:
            return
        me = await bot.me()
        if not me.username:
            return
        text = str(payload.get("text", "")).strip() or (
            f"🔒 Este contenido es exclusivo del plan <b>{escape(plan.name)}</b> "
            f"(${plan.price_usd:.0f} USD)."
        )
        await _send_html_safe(
            bot,
            chat.id,
            _render(text, user, chat),
            reply_markup=payment_wall_keyboard(me.username, plan.id),
            reply_to_message_id=reply_id,
        )
