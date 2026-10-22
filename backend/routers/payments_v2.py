"""
routers/payments_v2.py — Monetización con órdenes generadas por el servidor.

Flujo Stars (TMA y Standalone con Telegram vinculado):
  1. POST /v2/payments/stars/invoice {package_slug}
       → payment_orders(status=created, amount=precio del catálogo SERVIDOR)
       → createInvoiceLink(currency="XTR", payload=<order UUID>)
  2. Telegram → webhook pre_checkout_query  → se valida orden/importe/moneda
  3. Telegram → webhook successful_payment  → fulfill_order() atómico + idempotente
  4. Cliente hace polling de GET /v2/payments/orders/{id} hasta status=paid

ELIMINADOS de v1 (registrar estos routers era regalar dinero):
  * POST /payments/verify-stars   → acreditaba $ALPHA sin ningún pago.
  * POST /wallet/deposit          → idem (llamado desde api.js).
  * POST /creators/subscribe-tier → otorgaba rol creator sin cobrar.
"""
from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from aiogram.types import LabeledPrice
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from auth.dependencies import Principal, StrictBody, get_current_principal, get_optional_principal
from core.config import bot
from core.settings import get_settings
from database.db import get_db
from database.models import User
from database.models_v2 import PaymentOrder
from services.catalog import get_package, public_catalog

router = APIRouter(prefix="/v2/payments", tags=["Payments v2"])

ORDER_TTL = timedelta(hours=1)
MAX_OPEN_ORDERS_PER_10_MIN = 10


class PackageBody(StrictBody):
    package_slug: str = Field(min_length=2, max_length=32, pattern=r"^[a-z0-9-]+$")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _rate_limit(db: Session, user_id: int) -> None:
    recent = db.execute(
        select(func.count()).select_from(PaymentOrder).where(
            PaymentOrder.user_id == user_id,
            PaymentOrder.created_at > _utcnow() - timedelta(minutes=10),
        )
    ).scalar_one()
    if recent >= MAX_OPEN_ORDERS_PER_10_MIN:
        raise HTTPException(status_code=429, detail="Demasiadas órdenes. Espera unos minutos.")


def _create_order(db: Session, principal: Principal, slug: str,
                  provider: Literal["stars", "ton"]) -> PaymentOrder:
    try:
        pkg = get_package(slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="Paquete no encontrado.")
    _rate_limit(db, principal.user_id)

    user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    discount = bool(getattr(user, "has_referral_discount", False))
    amount = pkg.stars_price(discount) if provider == "stars" else pkg.ton_price_nano(discount)

    order = PaymentOrder(
        id=uuid.uuid4(), user_id=principal.user_id, package_slug=pkg.slug,
        provider=provider, currency="XTR" if provider == "stars" else "TON",
        amount=amount, alpha_amount=pkg.alpha_total, discount_applied=discount,
        status="created", expires_at=_utcnow() + ORDER_TTL,
    )
    db.add(order)
    db.flush()
    return order


@router.get("/packages")
def packages(principal: Optional[Principal] = Depends(get_optional_principal),
             db: Session = Depends(get_db)):
    has_discount = False
    if principal:
        user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one_or_none()
        has_discount = bool(user and getattr(user, "has_referral_discount", False))
    return {"packages": public_catalog(), "referral_discount_available": has_discount}


@router.post("/stars/invoice")
async def create_stars_invoice(body: PackageBody,
                               principal: Principal = Depends(get_current_principal),
                               db: Session = Depends(get_db)):
    order = _create_order(db, principal, body.package_slug, "stars")
    pkg = get_package(order.package_slug)
    try:
        # Stars: currency "XTR" y sin provider_token (aiogram ≥ 3.7).
        invoice_link = await bot.create_invoice_link(
            title=f"Búnker VIP · {pkg.name}"[:32],
            description=pkg.description[:255],
            payload=str(order.id),                      # 36 bytes < límite de 128
            currency="XTR",
            prices=[LabeledPrice(label=pkg.name[:32], amount=int(order.amount))],
        )
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=502, detail="Telegram no pudo generar la factura.") from exc
    db.commit()
    return {"order_id": str(order.id), "invoice_link": invoice_link,
            "amount_stars": order.amount, "discount_applied": order.discount_applied}


@router.post("/ton/order")
def create_ton_order(body: PackageBody,
                     principal: Principal = Depends(get_current_principal),
                     db: Session = Depends(get_db)):
    s = get_settings()
    if not s.ton_enabled:
        raise HTTPException(status_code=503, detail="Pagos TON no configurados.")
    order = _create_order(db, principal, body.package_slug, "ton")
    comment = ton_comment_for(order.id)
    db.commit()
    return {
        "order_id": str(order.id),
        "address": s.ton_receiver_address,
        "amount_nano": str(order.amount),
        "comment": comment,
        "payload": build_ton_comment_payload(comment),  # BOC base64 para TonConnect
        "valid_until": int((order.expires_at).timestamp()),
    }


@router.get("/orders/{order_id}")
def get_order(order_id: uuid.UUID, principal: Principal = Depends(get_current_principal),
              db: Session = Depends(get_db)):
    order = db.get(PaymentOrder, order_id)
    if not order or order.user_id != principal.user_id:
        raise HTTPException(status_code=404, detail="Orden no encontrada.")
    return {
        "order_id": str(order.id), "status": order.status, "package_slug": order.package_slug,
        "provider": order.provider, "amount": str(order.amount),
        "alpha_amount": order.alpha_amount,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
    }


# ------------------------------------------------------------------ helpers TON

def ton_comment_for(order_id: uuid.UUID) -> str:
    return f"AB-{order_id.hex}"


def build_ton_comment_payload(comment: str) -> str:
    """Celda TON con op=0 + comentario de texto, serializada como BOC base64.
    Requiere pytoniq-core (pip install pytoniq-core)."""
    from pytoniq_core import begin_cell

    cell = begin_cell().store_uint(0, 32).store_snake_string(comment).end_cell()
    return base64.b64encode(cell.to_boc()).decode()
