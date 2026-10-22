"""
services/ton_verifier.py — Confirmación de pagos TON leyendo la blockchain.

En v1 el cliente enviaba price_ton/alpha_total y luego un BOC a /ton/verify:
el BOC firmado por la wallet del usuario NO prueba que la transacción haya
llegado ni que tenga el importe correcto. Aquí el servidor consulta
toncenter (API v3) las transacciones ENTRANTES a TON_RECEIVER_ADDRESS y casa
el comentario "AB-<order hex>" con una orden abierta, comprobando importe.

⚠️ Verifica los nombres de campo contra la versión de toncenter que uses
(probado contra el esquema v3 /transactions: in_msg.value,
in_msg.message_content.decoded.comment, description.aborted, hash).
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from core.settings import get_settings
from database.db import SessionLocal
from database.models_v2 import PaymentOrder
from services.fulfillment import FulfillmentError, fulfill_order, lock_order

log = logging.getLogger("alpha.ton")


def _parse_comment(tx: dict[str, Any]) -> Optional[uuid.UUID]:
    in_msg = tx.get("in_msg") or {}
    decoded = ((in_msg.get("message_content") or {}).get("decoded") or {})
    comment = decoded.get("comment") or ""
    if not comment.startswith("AB-"):
        return None
    try:
        return uuid.UUID(hex=comment[3:].strip())
    except ValueError:
        return None


async def fetch_incoming(limit: int = 100) -> list[dict[str, Any]]:
    s = get_settings()
    headers = {"X-API-Key": s.toncenter_api_key} if s.toncenter_api_key else {}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{s.toncenter_base_url}/transactions",
            params={"account": s.ton_receiver_address, "limit": limit, "sort": "desc"},
            headers=headers,
        )
        r.raise_for_status()
        return r.json().get("transactions", [])


def _settle(db: Session, tx: dict[str, Any]) -> Optional[uuid.UUID]:
    order_id = _parse_comment(tx)
    if not order_id:
        return None
    if (tx.get("description") or {}).get("aborted"):
        return None
    in_msg = tx.get("in_msg") or {}
    if not in_msg.get("source"):
        return None  # mensaje externo: no es una transferencia entrante
    value = int(in_msg.get("value") or 0)
    tx_hash = tx.get("hash")
    if not tx_hash:
        return None

    order = lock_order(db, order_id)
    if not order or order.provider != "ton" or order.status == "paid":
        db.rollback()
        return None
    if value < order.amount:
        log.warning("[TON] Pago insuficiente orden=%s (%s < %s)", order_id, value, order.amount)
        db.rollback()
        return None
    try:
        fulfill_order(db, order, provider_ref=f"ton:{tx_hash}", payer_telegram_id=None)
        db.commit()
        return order_id
    except FulfillmentError:
        db.rollback()
        return None


async def verify_pending_ton_orders() -> list[uuid.UUID]:
    if not get_settings().ton_enabled:
        return []
    db = SessionLocal()
    try:
        has_open = db.execute(
            select(PaymentOrder.id).where(PaymentOrder.provider == "ton",
                                          PaymentOrder.status.in_(("created", "expired"))).limit(1)
        ).first()
        if not has_open:
            return []
        settled: list[uuid.UUID] = []
        for tx in await fetch_incoming():
            oid = _settle(db, tx)
            if oid:
                settled.append(oid)
        return settled
    finally:
        db.close()
