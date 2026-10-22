"""
routers/webhook_v2.py — Webhook de la Bot API con procesamiento idempotente.

Capas de idempotencia (de fuera hacia dentro):
  1. telegram_processed_updates(update_id PK)  — dentro de la MISMA transacción
     que el procesamiento: si algo falla, el update NO queda marcado y el
     reintento de Telegram vuelve a procesarlo.
  2. stars_payments(telegram_payment_charge_id PK)
  3. payment_orders.status + SELECT … FOR UPDATE
  4. ledger_entries.idempotency_key UNIQUE

Si la transacción falla devolvemos 500 → Telegram reintenta, y es seguro.
setWebhook debe incluir allowed_updates con: message, pre_checkout_query,
chat_join_request, chat_member (ver scripts/set_webhook.py).
"""
from __future__ import annotations

import hmac
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from core.config import bot
from core.settings import get_settings
from database.db import get_db
from database.models import User
from database.models_v2 import Membership, PaymentOrder, ProcessedUpdate, StarsPayment
from services import ledger
from services.fulfillment import FulfillmentError, fulfill_order, lock_order, recompute_access_level
from services.identity import IdentityConflict, consume_link_nonce
from services.telegram_community import TelegramCommunityService

log = logging.getLogger("alpha.webhook")
router = APIRouter(prefix="/v2/telegram", tags=["Telegram Webhook v2"])
community = TelegramCommunityService(bot)


def _verify_secret(header_value: Optional[str]) -> None:
    expected = get_settings().webhook_secret
    if not header_value or not hmac.compare_digest(header_value, expected):
        raise HTTPException(status_code=403, detail="Forbidden")


def _claim_update(db: Session, update_id: int) -> bool:
    res = db.execute(
        pg_insert(ProcessedUpdate.__table__).values(update_id=update_id)
        .on_conflict_do_nothing().returning(ProcessedUpdate.__table__.c.update_id)
    ).first()
    return res is not None


def _order_id(payload: str) -> Optional[uuid.UUID]:
    try:
        return uuid.UUID(payload)
    except (ValueError, TypeError):
        return None


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
):
    _verify_secret(x_telegram_bot_api_secret_token)
    try:
        update: dict[str, Any] = await request.json()
        update_id = int(update["update_id"])
    except Exception:
        return {"ok": True}  # basura: 200 para que Telegram no reintente

    # pre_checkout_query: respuesta obligatoria en < 10 s, sin dedupe (es solo una validación).
    if "pre_checkout_query" in update:
        await _handle_pre_checkout(db, update["pre_checkout_query"])
        return {"ok": True}

    post_commit: list = []  # efectos externos a ejecutar SOLO tras commit
    try:
        if not _claim_update(db, update_id):
            db.rollback()
            return {"ok": True, "duplicate": True}

        message = update.get("message")
        if message and "successful_payment" in message:
            _handle_successful_payment(db, message, post_commit)
        elif message and "refunded_payment" in message:
            _handle_refund(db, message)
        elif message and (message.get("text") or "").startswith("/start"):
            _handle_start(db, message, post_commit)
        elif "chat_join_request" in update:
            post_commit.append(("join_request", update["chat_join_request"]))

        db.commit()
    except Exception:
        db.rollback()
        log.exception("[WEBHOOK] Error procesando update %s", update_id)
        raise HTTPException(status_code=500, detail="retry")

    for kind, data in post_commit:
        try:
            await _run_side_effect(db, kind, data)
        except Exception:
            log.exception("[WEBHOOK] Efecto post-commit falló (%s); el worker reintentará.", kind)
    return {"ok": True}


# ---------------------------------------------------------------- pre-checkout

async def _handle_pre_checkout(db: Session, q: dict) -> None:
    error: Optional[str] = None
    order_id = _order_id(q.get("invoice_payload", ""))
    order = db.get(PaymentOrder, order_id) if order_id else None
    if not order:
        error = "Orden desconocida."
    elif order.status != "created":
        error = "Esta orden ya fue procesada."
    elif q.get("currency") != "XTR" or int(q.get("total_amount", -1)) != int(order.amount):
        error = "El importe no coincide con la orden."
    db.rollback()
    try:
        if error:
            await bot.answer_pre_checkout_query(q["id"], ok=False, error_message=error)
        else:
            await bot.answer_pre_checkout_query(q["id"], ok=True)
    except Exception:
        log.exception("[STARS] answer_pre_checkout_query falló")


# ---------------------------------------------------------------- pago confirmado

def _handle_successful_payment(db: Session, message: dict, post_commit: list) -> None:
    sp = message["successful_payment"]
    charge_id = sp["telegram_payment_charge_id"]
    payer_id = int(message["from"]["id"])
    order_id = _order_id(sp.get("invoice_payload", ""))
    if not order_id:
        log.error("[STARS] Payload no reconocido (formato v1?): %s", sp.get("invoice_payload"))
        return  # se registra el update; requiere conciliación manual

    order = lock_order(db, order_id)
    if not order:
        log.error("[STARS] Orden %s inexistente para charge %s", order_id, charge_id)
        return

    if db.get(StarsPayment, charge_id) is not None:
        return  # charge ya registrado → reintento de Telegram

    if order.status == "paid":
        # Segundo cobro de la misma orden (dos pre-checkouts simultáneos): se devuelve.
        log.critical("[STARS] Doble pago de la orden %s; reembolsando charge %s", order.id, charge_id)
        post_commit.append(("refund", (payer_id, charge_id)))
        return

    inserted = db.execute(
        pg_insert(StarsPayment.__table__).values(
            telegram_payment_charge_id=charge_id, order_id=order.id,
            payer_telegram_id=payer_id, total_amount=int(sp["total_amount"]), raw=sp,
        ).on_conflict_do_nothing().returning(StarsPayment.__table__.c.telegram_payment_charge_id)
    ).first()
    if inserted is None:
        return

    if sp.get("currency") != "XTR" or int(sp["total_amount"]) != int(order.amount):
        # Cobrado pero no cuadra: no se acredita automáticamente; alerta para revisión.
        log.critical("[STARS] Importe inconsistente orden=%s charge=%s", order.id, charge_id)
        order.status = "failed"
        return

    try:
        result = fulfill_order(db, order, provider_ref=f"stars:{charge_id}", payer_telegram_id=payer_id)
    except FulfillmentError as exc:
        log.critical("[STARS] No se pudo cumplir la orden %s: %s", order.id, exc)
        return

    if not result.already_processed:
        post_commit.append(("invite", result.membership_id))
        post_commit.append(("notify", (payer_id, result.alpha_credited)))


def _handle_refund(db: Session, message: dict) -> None:
    rp = message["refunded_payment"]
    charge_id = rp.get("telegram_payment_charge_id")
    payment = db.get(StarsPayment, charge_id) if charge_id else None
    if not payment:
        return
    order = lock_order(db, payment.order_id)
    if not order or order.status != "paid":
        return
    order.status = "refunded"
    m = db.execute(select(Membership).where(Membership.last_order_id == order.id)
                   .with_for_update()).scalar_one_or_none()
    if m and m.status == "active":
        # Vencimiento inmediato: el worker la expira, recalcula nivel y expulsa del canal.
        m.expires_at = datetime.now(timezone.utc)
    wallet = ledger.lock_wallets(db, [order.user_id])[order.user_id]
    clawback = min(order.alpha_amount, int(wallet.alpha_balance or 0))
    if clawback > 0:
        ledger.debit(db, order.user_id, clawback, "refund_clawback",
                     reference=f"order:{order.id}", idempotency_key=f"order:{order.id}:refund")
    user = db.execute(select(User).where(User.user_id == order.user_id).with_for_update()).scalar_one()
    recompute_access_level(db, user)


# ---------------------------------------------------------------- /start

def _handle_start(db: Session, message: dict, post_commit: list) -> None:
    sender_id = int(message["from"]["id"])
    parts = (message.get("text") or "").split(maxsplit=1)
    param = parts[1] if len(parts) > 1 else ""

    if param.startswith("link_"):
        try:
            user_id = consume_link_nonce(db, param, sender_id)
            post_commit.append(("text", (sender_id, "✅ Telegram vinculado a tu cuenta Alpha Vault.")))
            # Membresías pagadas antes de vincular: ahora sí pueden recibir enlace.
            for m_id in db.execute(select(Membership.id).where(
                    Membership.user_id == user_id, Membership.status == "active",
                    Membership.invite_link.is_(None))).scalars():
                post_commit.append(("invite", m_id))
        except IdentityConflict as exc:
            post_commit.append(("text", (sender_id, f"⚠️ {exc}")))
        return

    post_commit.append(("welcome", sender_id))


# ---------------------------------------------------------------- efectos externos

async def _run_side_effect(db: Session, kind: str, data: Any) -> None:
    s = get_settings()
    if kind == "invite":
        m = db.get(Membership, data)
        if m:
            await community.issue_invite(db, m)
    elif kind == "notify":
        chat_id, alpha = data
        await bot.send_message(chat_id, f"💎 <b>Pago confirmado.</b> +{alpha} $ALPHA acreditados.",
                               parse_mode="HTML")
    elif kind == "text":
        chat_id, txt = data
        await bot.send_message(chat_id, txt)
    elif kind == "welcome":
        kb = InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(
            text="🚀 Abrir Alpha Vault", web_app=WebAppInfo(url=s.mini_app_url))]])
        await bot.send_message(data, "¡Bienvenido al Búnker! 🐺", reply_markup=kb)
    elif kind == "refund":
        payer_id, charge_id = data
        await bot.refund_star_payment(user_id=payer_id, telegram_payment_charge_id=charge_id)
    elif kind == "join_request":
        await community.handle_join_request(db, data)
