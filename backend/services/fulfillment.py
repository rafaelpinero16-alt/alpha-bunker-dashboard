"""
services/fulfillment.py — Aplica una orden pagada, en UNA transacción:

    orden (FOR UPDATE) → saldo $ALPHA (ledger) → membresía → nivel/rol de usuario
    → descuento de referido consumido → recompensa al referidor (solo tras 1er pago real)

Los efectos externos (mensajes de Telegram, enlaces de invitación) se ejecutan
DESPUÉS del commit por el llamador o por el worker de membresías, que reintenta
las membresías sin enlace. Así una caída de la API de Telegram nunca deja un
pago cobrado sin acreditar, ni uno acreditado dos veces.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from core.settings import get_settings
from database.models import User
from database.models_v2 import Membership, PaymentOrder
from services import ledger
from services.catalog import CREATOR_ROLE_MIN_LEVEL, REFERRAL_REWARD_ALPHA, get_package


class FulfillmentError(Exception):
    pass


@dataclass(frozen=True)
class FulfillmentResult:
    order_id: uuid.UUID
    user_id: int
    alpha_credited: int
    new_access_level: int
    membership_id: int
    already_processed: bool


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def lock_order(db: Session, order_id: uuid.UUID) -> Optional[PaymentOrder]:
    return db.execute(
        select(PaymentOrder).where(PaymentOrder.id == order_id).with_for_update()
    ).scalar_one_or_none()


def recompute_access_level(db: Session, user: User) -> int:
    level = db.execute(
        select(func.coalesce(func.max(Membership.level), 0)).where(
            Membership.user_id == user.user_id,
            Membership.status == "active",
        )
    ).scalar_one()
    user.access_level = int(level)
    return user.access_level


def fulfill_order(db: Session, order: PaymentOrder, provider_ref: str,
                  payer_telegram_id: Optional[int]) -> FulfillmentResult:
    """El llamador DEBE haber obtenido `order` con lock_order() en esta misma transacción."""
    if order.status == "paid":
        m_id = db.execute(select(Membership.id).where(Membership.last_order_id == order.id)).scalar()
        return FulfillmentResult(order.id, order.user_id, 0, -1, m_id or 0, already_processed=True)
    if order.status not in ("created", "expired"):
        # 'expired' se acepta: Telegram/TON pueden confirmar tras nuestro TTL y el dinero ya se cobró.
        raise FulfillmentError(f"Orden en estado no cumplible: {order.status}")

    pkg = get_package(order.package_slug)
    settings = get_settings()
    now = _utcnow()

    user = db.execute(select(User).where(User.user_id == order.user_id).with_for_update()).scalar_one()

    # 1) Saldo $ALPHA — idempotente por orden.
    ledger.credit(db, user.user_id, order.alpha_amount, "package_purchase",
                  reference=f"order:{order.id}", idempotency_key=f"order:{order.id}:alpha")

    # 2) Membresía — renovación acumulativa si sigue activa.
    existing = db.execute(
        select(Membership).where(Membership.user_id == user.user_id,
                                 Membership.tier_slug == pkg.slug).with_for_update()
    ).scalar_one_or_none()
    if pkg.duration_days is None:
        new_expiry = None
    else:
        base = existing.expires_at if (existing and existing.status == "active"
                                       and existing.expires_at and existing.expires_at > now) else now
        new_expiry = base + timedelta(days=pkg.duration_days)

    chat_id = settings.tier_chat_ids.get(pkg.slug)
    if existing:
        was_active = existing.status == "active"
        existing.status = "active"
        existing.level = pkg.level
        existing.chat_id = chat_id
        existing.expires_at = new_expiry
        existing.last_order_id = order.id
        if not was_active:
            existing.starts_at = now
            existing.invite_link = None          # fuerza nuevo enlace
            existing.invite_attempts = 0
        membership = existing
    else:
        membership = Membership(
            user_id=user.user_id, tier_slug=pkg.slug, level=pkg.level, chat_id=chat_id,
            status="active", starts_at=now, expires_at=new_expiry, last_order_id=order.id,
            invite_attempts=0,
        )
        db.add(membership)
    db.flush()

    # 3) Nivel y rol.
    new_level = recompute_access_level(db, user)
    if pkg.level >= CREATOR_ROLE_MIN_LEVEL and user.role == "fan":
        user.role = "creator"  # TODO-NEGOCIO: ¿se retira el rol al expirar? Hoy NO.

    # 4) Referidos: descuento consumido y recompensa SOLO con el primer pago real.
    #    (v1 pagaba 100 $ALPHA por cada cuenta creada → granja infinita con IDs falsos.)
    if order.discount_applied:
        user.has_referral_discount = False
    referrer_id = getattr(user, "referred_by", None)
    if referrer_id and not getattr(user, "referral_rewarded", False):
        user.referral_rewarded = True
        try:
            ledger.credit(db, int(referrer_id), REFERRAL_REWARD_ALPHA, "referral_bonus",
                          reference=f"referee:{user.user_id}",
                          idempotency_key=f"referral:{user.user_id}")
        except ledger.DuplicateOperation:
            pass

    # 5) Orden.
    order.status = "paid"
    order.paid_at = now
    order.provider_ref = provider_ref
    order.payer_telegram_id = payer_telegram_id
    db.flush()

    return FulfillmentResult(order.id, user.user_id, order.alpha_amount, new_level,
                             membership.id, already_processed=False)
