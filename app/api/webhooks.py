"""Webhooks entrantes: Telegram (updates del bot) y PayPal (eventos de pago)."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
from typing import Any, Dict, Optional, Set
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

from aiogram.types import Update
from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import ValidationError

from app.bot.dispatcher import bot, dp
from app.config import settings
from app.services.database import db
from app.services.payments import PaymentError, fulfill_transaction, payment_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])

_background_tasks: Set["asyncio.Task[None]"] = set()


def _dashboard_redirect(**params: str) -> RedirectResponse:
    parts = urlsplit(settings.DASHBOARD_URL)
    query = dict(parse_qsl(parts.query))
    query.update(params)
    url = urlunsplit((parts.scheme, parts.netloc, parts.path or "/", urlencode(query), parts.fragment))
    return RedirectResponse(url=url, status_code=status.HTTP_303_SEE_OTHER)


async def _process_update(update: Update) -> None:
    try:
        await dp.feed_update(bot, update)
    except Exception:  # noqa: BLE001 - un update defectuoso no debe tumbar el servidor
        logger.exception("Error procesando update %s", update.update_id)


# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
@router.post(settings.WEBHOOK_PATH, include_in_schema=False)
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: Optional[str] = Header(default=None),
) -> Dict[str, bool]:
    if not x_telegram_bot_api_secret_token or not hmac.compare_digest(
        x_telegram_bot_api_secret_token, settings.WEBHOOK_SECRET
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Secret token inválido")

    try:
        payload: Dict[str, Any] = await request.json()
        update = Update.model_validate(payload, context={"bot": bot})
    except (ValueError, ValidationError) as exc:
        logger.warning("Update inválido recibido: %s", exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Update inválido") from exc

    # Respuesta inmediata a Telegram; el procesamiento continúa en segundo plano.
    task = asyncio.create_task(_process_update(update))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return {"ok": True}


# ---------------------------------------------------------------------------
# PayPal
# ---------------------------------------------------------------------------
@router.post("/api/v1/payments/paypal/webhook")
async def paypal_webhook(request: Request) -> Dict[str, str]:
    if not settings.PAYPAL_WEBHOOK_ID:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="PAYPAL_WEBHOOK_ID no configurado")

    raw_body = await request.body()
    try:
        event: Dict[str, Any] = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="JSON inválido") from exc

    try:
        verified = await payment_service.verify_paypal_webhook(request.headers, event)
    except PaymentError as exc:
        logger.error("Error verificando webhook PayPal: %s %s", exc.message, exc.details)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="No se pudo verificar") from exc
    if not verified:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Firma de PayPal inválida")

    event_type = str(event.get("event_type", ""))
    resource: Dict[str, Any] = event.get("resource") or {}
    logger.info("Webhook PayPal: %s", event_type)

    try:
        if event_type == "CHECKOUT.ORDER.APPROVED":
            order_id = str(resource.get("id", ""))
            capture = await payment_service.capture_paypal_order(order_id)
            transaction = await db.get_transaction_by_external_id(order_id)
            if capture.get("status") == "COMPLETED" and transaction is not None:
                await fulfill_transaction(
                    bot, transaction.id, metadata={"paypal_capture_id": capture.get("capture_id")}
                )
        elif event_type == "PAYMENT.CAPTURE.COMPLETED":
            transaction_id = resource.get("custom_id")
            if transaction_id:
                await fulfill_transaction(
                    bot, str(transaction_id), metadata={"paypal_capture_id": resource.get("id")}
                )
        elif event_type in {"PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"}:
            transaction_id = resource.get("custom_id")
            if transaction_id:
                await db.update_transaction_status(str(transaction_id), "failed", expected_status="pending")
    except PaymentError as exc:
        logger.error("Error procesando evento PayPal %s: %s %s", event_type, exc.message, exc.details)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=exc.message) from exc

    return {"status": "processed"}


@router.get("/api/v1/payments/paypal/return", include_in_schema=False)
async def paypal_return(token: str = Query(..., description="ID de la orden PayPal")) -> RedirectResponse:
    transaction = await db.get_transaction_by_external_id(token)
    if transaction is None:
        return _dashboard_redirect(payment="failed")
    if transaction.status == "completed":
        return _dashboard_redirect(payment="success", tx=transaction.id)
    try:
        capture = await payment_service.capture_paypal_order(token)
    except PaymentError as exc:
        logger.error("Captura PayPal fallida para %s: %s %s", token, exc.message, exc.details)
        return _dashboard_redirect(payment="failed", tx=transaction.id)

    if capture.get("status") == "COMPLETED":
        await fulfill_transaction(bot, transaction.id, metadata={"paypal_capture_id": capture.get("capture_id")})
        return _dashboard_redirect(payment="success", tx=transaction.id)
    return _dashboard_redirect(payment="pending", tx=transaction.id)


@router.get("/api/v1/payments/paypal/cancel", include_in_schema=False)
async def paypal_cancel(token: Optional[str] = Query(default=None)) -> RedirectResponse:
    if token:
        transaction = await db.get_transaction_by_external_id(token)
        if transaction is not None:
            await db.update_transaction_status(transaction.id, "failed", expected_status="pending")
    return _dashboard_redirect(payment="cancelled")
