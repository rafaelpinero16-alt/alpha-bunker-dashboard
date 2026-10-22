"""
services/ledger.py — Movimientos de $ALPHA atómicos e idempotentes.

Garantías:
  * SELECT ... FOR UPDATE sobre las billeteras implicadas, SIEMPRE en orden
    ascendente de user_id (evita deadlocks en transferencias cruzadas A→B / B→A).
  * idempotency_key UNIQUE en ledger_entries: reintentar la misma operación
    no duplica saldo.
  * CHECK (alpha_balance >= 0) en BD como última línea de defensa.
  * Las funciones NO hacen commit: el llamador controla la transacción para
    que saldo + membresía + orden se confirmen juntos o no se confirmen.
"""
from __future__ import annotations

from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from database.models import Transaction, Wallet
from database.models_v2 import LedgerEntry


class LedgerError(Exception):
    pass


class InsufficientFunds(LedgerError):
    pass


class DuplicateOperation(LedgerError):
    """La idempotency_key ya fue aplicada: la operación es un reintento."""


def _ensure_wallets(db: Session, user_ids: Iterable[int]) -> None:
    for uid in set(user_ids):
        db.execute(
            pg_insert(Wallet.__table__)
            .values(user_id=uid, alpha_balance=0, total_earned=0, total_spent=0)
            .on_conflict_do_nothing(index_elements=["user_id"])
        )


def lock_wallets(db: Session, user_ids: Iterable[int]) -> dict[int, Wallet]:
    ids = sorted(set(int(u) for u in user_ids))
    _ensure_wallets(db, ids)
    rows = db.execute(
        select(Wallet).where(Wallet.user_id.in_(ids)).order_by(Wallet.user_id).with_for_update()
    ).scalars().all()
    wallets = {int(w.user_id): w for w in rows}
    if len(wallets) != len(ids):
        raise LedgerError("No se pudieron bloquear todas las billeteras.")
    return wallets


def already_applied(db: Session, idempotency_key: str) -> bool:
    return db.execute(
        select(LedgerEntry.id).where(LedgerEntry.idempotency_key == idempotency_key)
    ).first() is not None


def _entry(db: Session, wallet: Wallet, delta: int, entry_type: str, counterparty: Optional[int],
           reference: Optional[str], key: Optional[str]) -> None:
    db.add(LedgerEntry(
        user_id=wallet.user_id, delta=delta, balance_after=wallet.alpha_balance,
        entry_type=entry_type, counterparty_id=counterparty, reference=reference,
        idempotency_key=key,
    ))


def _legacy_tx(db: Session, sender: Optional[int], receiver: Optional[int], amount: int,
               tx_type: str, room_id: Optional[str] = None) -> None:
    """Espejo en la tabla 'transactions' v1 para que el historial del front siga funcionando."""
    kwargs = dict(sender_id=sender, receiver_id=receiver, amount=amount, tx_type=tx_type)
    if room_id is not None and hasattr(Transaction, "room_id"):
        kwargs["room_id"] = room_id
    db.add(Transaction(**kwargs))


def credit(db: Session, user_id: int, amount: int, entry_type: str, *,
           reference: Optional[str] = None, idempotency_key: Optional[str] = None) -> int:
    if amount <= 0:
        raise LedgerError("El crédito debe ser positivo.")
    if idempotency_key and already_applied(db, idempotency_key):
        raise DuplicateOperation(idempotency_key)
    w = lock_wallets(db, [user_id])[user_id]
    w.alpha_balance = (w.alpha_balance or 0) + amount
    w.total_earned = (w.total_earned or 0) + amount
    _entry(db, w, amount, entry_type, None, reference, idempotency_key)
    _legacy_tx(db, None, user_id, amount, entry_type)
    return w.alpha_balance


def debit(db: Session, user_id: int, amount: int, entry_type: str, *,
          reference: Optional[str] = None, idempotency_key: Optional[str] = None,
          room_id: Optional[str] = None) -> int:
    if amount <= 0:
        raise LedgerError("El débito debe ser positivo.")
    if idempotency_key and already_applied(db, idempotency_key):
        raise DuplicateOperation(idempotency_key)
    w = lock_wallets(db, [user_id])[user_id]
    if (w.alpha_balance or 0) < amount:
        raise InsufficientFunds()
    w.alpha_balance -= amount
    w.total_spent = (w.total_spent or 0) + amount
    _entry(db, w, -amount, entry_type, None, reference, idempotency_key)
    _legacy_tx(db, user_id, None, amount, entry_type, room_id)
    return w.alpha_balance


def transfer(db: Session, sender_id: int, receiver_id: int, amount: int, entry_type: str, *,
             reference: Optional[str] = None, idempotency_key: Optional[str] = None,
             room_id: Optional[str] = None) -> tuple[int, int]:
    if amount <= 0:
        raise LedgerError("La transferencia debe ser positiva.")
    if sender_id == receiver_id:
        raise LedgerError("No puedes transferirte a ti mismo.")
    if idempotency_key and already_applied(db, idempotency_key + ":out"):
        raise DuplicateOperation(idempotency_key)
    wallets = lock_wallets(db, [sender_id, receiver_id])
    s, r = wallets[sender_id], wallets[receiver_id]
    if (s.alpha_balance or 0) < amount:
        raise InsufficientFunds()
    s.alpha_balance -= amount
    s.total_spent = (s.total_spent or 0) + amount
    r.alpha_balance = (r.alpha_balance or 0) + amount
    r.total_earned = (r.total_earned or 0) + amount
    out_key = f"{idempotency_key}:out" if idempotency_key else None
    in_key = f"{idempotency_key}:in" if idempotency_key else None
    _entry(db, s, -amount, entry_type, receiver_id, reference, out_key)
    _entry(db, r, amount, entry_type, sender_id, reference, in_key)
    _legacy_tx(db, sender_id, receiver_id, amount, entry_type, room_id)
    return s.alpha_balance, r.alpha_balance
