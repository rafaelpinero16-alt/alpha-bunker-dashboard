"""
routers/app_support_v2.py — Endpoints que el app.js v2 necesita y que en v1 confiaban
en el user_id del cliente (o no existían y la app guardaba todo en localStorage).

  GET  /v2/wallet/history                 movimientos del ledger del usuario
  POST /v2/wallet/payouts                 solicitud de retiro (creador + KYC), retiene saldo
  POST /v2/wallet/ton-address             guarda la dirección TON mostrada en el perfil
  GET  /v2/creators/{id}/tip-menu         menú de propinas público de un creador
  PUT  /v2/creators/me/tip-menu           reemplaza atómicamente los 10 slots del creador
  GET  /v2/users/{id}/public              perfil público con esquema explícito (sin PII)
  GET  /v2/users/me/preferences           favoritos, slots, contactos, bloqueados (JSONB)
  PUT  /v2/users/me/preferences           reemplazo atómico con control de versión
  PUT  /v2/users/me/presence              online/offline visible
  POST /v2/users/me/referrer              asigna referidor una sola vez (cuentas nuevas)
  POST /v2/users/visit                    contador diario (upsert atómico)
  POST /v2/auth/password                  cambio de contraseña (solo cuentas email)
  GET  /v2/chat/conversations             bandeja de DMs
  GET  /v2/chat/dm/{target_id}/history    historial de una conversación
  POST /v2/chat/dm/{target_id}            enviar DM por REST (p. ej. mensaje adjunto a una propina)
  DELETE /v2/chat/messages/{msg_id}       borrar mensaje propio (o admin) y notificar en tiempo real
  POST /v2/posts/{post_id}/like           like idempotente por usuario (v1: contador inflable)
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal, Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import and_, case, delete, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from auth.dependencies import (
    Principal, StrictBody, get_current_principal, get_optional_principal, require_creator,
)
from database.db import get_db
from database.models import ChatMessage, Post, TipMenuSlot, User
from database.models_v2 import AuthIdentity, LedgerEntry
from services import ledger
from services.moderation import moderate, normalize_text
from services.realtime import get_hub

router = APIRouter(prefix="/v2", tags=["App support v2"])
_ph = PasswordHasher()
MAX_PREFS_BYTES = 32 * 1024


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ================================================================ wallet

@router.get("/wallet/history")
def wallet_history(limit: int = Query(30, ge=1, le=100), principal: Principal = Depends(get_current_principal),
                   db: Session = Depends(get_db)):
    rows = db.execute(select(LedgerEntry).where(LedgerEntry.user_id == principal.user_id)
                      .order_by(LedgerEntry.id.desc()).limit(limit)).scalars().all()
    return {"transactions": [{"id": r.id, "amount": int(r.delta), "tx_type": r.entry_type,
                              "balance_after": int(r.balance_after),
                              "created_at": r.created_at.isoformat()} for r in rows]}


class PayoutBody(StrictBody):
    amount_alpha: int = Field(gt=0, le=10_000_000)
    method: Literal["dolarapp_ach", "skrill", "ton", "binance"]
    destination: str = Field(min_length=4, max_length=200)
    client_ref: str = Field(min_length=8, max_length=64)


@router.post("/wallet/payouts", status_code=201)
def request_payout(body: PayoutBody, principal: Principal = Depends(require_creator), db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    if not principal.is_admin and getattr(user, "kyc_status", None) != "verified":
        raise HTTPException(status_code=403, detail="Retiros requieren KYC verificado.")
    try:
        ledger.debit(db, principal.user_id, body.amount_alpha, "payout_hold",
                     reference=f"payout:{body.method}",
                     idempotency_key=f"payout:{principal.user_id}:{body.client_ref}")
    except ledger.InsufficientFunds:
        raise HTTPException(status_code=402, detail="Saldo insuficiente.")
    except ledger.DuplicateOperation:
        db.rollback()
        return {"status": "duplicate"}
    db.execute(text("""INSERT INTO payout_requests (user_id, amount_alpha, method, destination, status)
                       VALUES (:u, :a, :m, :d, 'pending')"""),
               {"u": principal.user_id, "a": body.amount_alpha, "m": body.method,
                "d": normalize_text(body.destination)})
    db.commit()
    return {"status": "pending", "message": "Retiro registrado. Se procesará tras revisión."}


class TonAddressBody(StrictBody):
    address: str = Field(min_length=40, max_length=80, pattern=r"^[A-Za-z0-9_\-:+/=]+$")


@router.post("/wallet/ton-address")
def save_ton_address(body: TonAddressBody, principal: Principal = Depends(get_current_principal),
                     db: Session = Depends(get_db)):
    db.execute(text("UPDATE users SET ton_address = :a WHERE user_id = :u"),
               {"a": body.address, "u": principal.user_id})
    db.commit()
    return {"status": "ok"}


# ================================================================ tip menu

@router.get("/creators/{creator_id}/tip-menu")
def get_tip_menu(creator_id: int, db: Session = Depends(get_db)):
    slots = db.execute(select(TipMenuSlot).where(TipMenuSlot.creator_id == creator_id)
                       .order_by(TipMenuSlot.slot_number)).scalars().all()
    return {"slots": [{"slot_number": s.slot_number, "title": s.title, "price_alpha": s.price_alpha}
                      for s in slots if s.title and (s.price_alpha or 0) > 0]}


class TipSlot(StrictBody):
    slot_number: int = Field(ge=1, le=10)
    title: str = Field(min_length=1, max_length=80)
    price_alpha: int = Field(gt=0, le=1_000_000)


class TipMenuBody(StrictBody):
    slots: list[TipSlot] = Field(max_length=10)


@router.put("/creators/me/tip-menu")
def put_tip_menu(body: TipMenuBody, principal: Principal = Depends(require_creator), db: Session = Depends(get_db)):
    numbers = [s.slot_number for s in body.slots]
    if len(numbers) != len(set(numbers)):
        raise HTTPException(status_code=400, detail="Slots duplicados.")
    db.execute(delete(TipMenuSlot).where(TipMenuSlot.creator_id == principal.user_id))
    for s in body.slots:
        db.add(TipMenuSlot(creator_id=principal.user_id, slot_number=s.slot_number,
                           title=normalize_text(s.title), price_alpha=s.price_alpha))
    db.commit()
    return {"saved": len(body.slots)}


# ================================================================ usuarios

@router.get("/users/{user_id}/public")
def public_profile(user_id: int, principal: Optional[Principal] = Depends(get_optional_principal),
                   db: Session = Depends(get_db)):
    u = db.execute(select(User).where(User.user_id == user_id)).scalar_one_or_none()
    if not u or getattr(u, "is_disabled", False):
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")
    following = False
    if principal:
        following = db.execute(text(
            "SELECT 1 FROM follows WHERE follower_id = :a AND following_id = :b"),
            {"a": principal.user_id, "b": user_id}).first() is not None
    visible_online = bool(getattr(u, "is_online", False))
    return {"user_id": u.user_id, "name": u.name, "bio": u.bio, "avatar_url": u.avatar_url,
            "role": u.role, "access_level": int(u.access_level or 0), "is_online": visible_online,
            "kyc_verified": getattr(u, "kyc_status", None) == "verified", "is_following": following}


class PreferencesBody(StrictBody):
    version: int = Field(ge=0)
    data: dict[str, Any]


@router.get("/users/me/preferences")
def get_preferences(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    row = db.execute(text("SELECT preferences, preferences_version FROM users WHERE user_id = :u"),
                     {"u": principal.user_id}).first()
    return {"data": (row[0] if row and row[0] else {}), "version": int(row[1] or 0) if row else 0}


@router.put("/users/me/preferences")
def put_preferences(body: PreferencesBody, principal: Principal = Depends(get_current_principal),
                    db: Session = Depends(get_db)):
    raw = json.dumps(body.data, ensure_ascii=False)
    if len(raw.encode()) > MAX_PREFS_BYTES:
        raise HTTPException(status_code=413, detail="Preferencias demasiado grandes.")
    # Compare-and-set: si otro dispositivo guardó antes, 409 y el cliente recarga y fusiona.
    res = db.execute(text("""UPDATE users SET preferences = CAST(:p AS JSONB),
                                    preferences_version = preferences_version + 1
                             WHERE user_id = :u AND preferences_version = :v
                             RETURNING preferences_version"""),
                     {"p": raw, "u": principal.user_id, "v": body.version}).first()
    if res is None:
        db.rollback()
        raise HTTPException(status_code=409, detail="Las preferencias cambiaron en otro dispositivo.")
    db.commit()
    return {"version": int(res[0])}


class PresenceBody(StrictBody):
    online: bool


@router.put("/users/me/presence")
def set_presence(body: PresenceBody, principal: Principal = Depends(get_current_principal),
                 db: Session = Depends(get_db)):
    if not body.online and principal.access_level < 1 and not principal.is_admin:
        raise HTTPException(status_code=403, detail="El modo invisible requiere rango SOLDIER.")
    db.execute(update(User).where(User.user_id == principal.user_id).values(is_online=body.online))
    db.commit()
    return {"online": body.online}


class ReferrerBody(StrictBody):
    referrer_id: int


@router.post("/users/me/referrer")
def set_referrer(body: ReferrerBody, principal: Principal = Depends(get_current_principal),
                 db: Session = Depends(get_db)):
    if body.referrer_id == principal.user_id:
        raise HTTPException(status_code=400, detail="Referidor inválido.")
    user = db.execute(select(User).where(User.user_id == principal.user_id).with_for_update()).scalar_one()
    if getattr(user, "referred_by", None):
        return {"status": "already_set"}
    created = getattr(user, "created_at", None)
    if created is not None:
        created = created if created.tzinfo else created.replace(tzinfo=timezone.utc)
        if _utcnow() - created > timedelta(hours=72):
            return {"status": "too_late"}
    has_purchase = db.execute(text(
        "SELECT 1 FROM payment_orders WHERE user_id = :u AND status = 'paid' LIMIT 1"),
        {"u": principal.user_id}).first()
    if has_purchase:
        return {"status": "too_late"}
    if not db.execute(select(User.user_id).where(User.user_id == body.referrer_id)).first():
        raise HTTPException(status_code=404, detail="Referidor no encontrado.")
    user.referred_by = body.referrer_id
    user.has_referral_discount = True  # la recompensa al referidor se paga con el 1er pago real
    db.commit()
    return {"status": "ok", "discount": True}


@router.post("/users/visit")
def daily_visit(db: Session = Depends(get_db)):
    count = db.execute(text("""
        INSERT INTO daily_visits (visit_date, visits_count) VALUES (:d, 1)
        ON CONFLICT (visit_date) DO UPDATE SET visits_count = daily_visits.visits_count + 1
        RETURNING visits_count"""), {"d": date.today()}).scalar_one()
    db.commit()
    return {"daily_visits": int(count)}


class PasswordBody(StrictBody):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


@router.post("/auth/password", status_code=204)
def change_password(body: PasswordBody, principal: Principal = Depends(get_current_principal),
                    db: Session = Depends(get_db)):
    ident = db.execute(select(AuthIdentity).where(AuthIdentity.user_id == principal.user_id,
                                                  AuthIdentity.provider == "password")
                       .with_for_update()).scalar_one_or_none()
    if not ident:
        raise HTTPException(status_code=400, detail="Tu cuenta no usa contraseña (acceso con Telegram).")
    try:
        _ph.verify(ident.secret_hash, body.current_password)
    except (VerifyMismatchError, InvalidHashError):
        raise HTTPException(status_code=401, detail="Contraseña actual incorrecta.")
    ident.secret_hash = _ph.hash(body.new_password)
    # Cierra las demás sesiones.
    db.execute(text("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :u AND revoked_at IS NULL"),
               {"u": principal.user_id})
    db.commit()


# ================================================================ DMs

def _dm_payload(m: ChatMessage) -> dict[str, Any]:
    return {"type": "new_msg", "id": m.id, "user_id": m.user_id, "recipient_id": m.recipient_id,
            "author_name": m.author_name, "author_role": m.author_role, "access_level": m.access_level,
            "content": m.content, "is_read": bool(m.is_read), "is_system": bool(m.is_system),
            "created_at": m.created_at.isoformat() if m.created_at else None}


@router.get("/chat/conversations")
def conversations(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    me = principal.user_id
    other = case((ChatMessage.user_id == me, ChatMessage.recipient_id), else_=ChatMessage.user_id)
    latest = (select(other.label("other_id"), func.max(ChatMessage.id).label("last_id"),
                     func.sum(case((and_(ChatMessage.recipient_id == me, ChatMessage.is_read.is_(False)), 1),
                                   else_=0)).label("unread"))
              .where(ChatMessage.recipient_id.is_not(None),
                     or_(ChatMessage.user_id == me, ChatMessage.recipient_id == me))
              .group_by(other).subquery())
    rows = db.execute(
        select(latest.c.other_id, latest.c.unread, ChatMessage, User)
        .join(ChatMessage, ChatMessage.id == latest.c.last_id)
        .join(User, User.user_id == latest.c.other_id, isouter=True)
        .order_by(latest.c.last_id.desc()).limit(100)
    ).all()
    return {"conversations": [{
        "user_id": oid, "name": (u.name if u else f"user_{oid}"),
        "avatar_url": (u.avatar_url if u else None),
        "is_online": bool(getattr(u, "is_online", False)) if u else False,
        "last_message": m.content, "last_time": m.created_at.isoformat() if m.created_at else None,
        "unread_count": int(unread or 0),
    } for oid, unread, m, u in rows]}


@router.get("/chat/dm/{target_id}/history")
def dm_history(target_id: int, limit: int = Query(50, ge=1, le=200),
               principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    me = principal.user_id
    rows = db.execute(select(ChatMessage).where(or_(
        and_(ChatMessage.user_id == me, ChatMessage.recipient_id == target_id),
        and_(ChatMessage.user_id == target_id, ChatMessage.recipient_id == me),
    )).order_by(ChatMessage.id.desc()).limit(limit)).scalars().all()
    return {"messages": [_dm_payload(m) for m in reversed(rows)]}


class DmBody(StrictBody):
    text: Optional[str] = Field(default=None, max_length=1000)
    media_url: Optional[str] = None


@router.post("/chat/dm/{target_id}", status_code=201)
async def send_dm(target_id: int, body: DmBody, principal: Principal = Depends(get_current_principal),
                  db: Session = Depends(get_db)):
    if target_id == principal.user_id:
        raise HTTPException(status_code=400, detail="Destinatario inválido.")
    me = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    if not db.execute(select(User.user_id).where(User.user_id == target_id)).first():
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")
    verdict = moderate(body.text, body.media_url, privileged=principal.is_admin,
                       access_level=principal.access_level)
    if not verdict.ok:
        raise HTTPException(status_code=400, detail=verdict.reason)
    msg = ChatMessage(user_id=me.user_id, recipient_id=target_id, author_name=me.name, author_role=principal.role,
                      access_level=principal.access_level, is_system=False,
                      content=json.dumps({"text": verdict.text, "media_url": verdict.media_url}, ensure_ascii=False))
    db.add(msg)
    db.commit()
    db.refresh(msg)
    payload = _dm_payload(msg)
    hub = get_hub()
    await hub.publish(f"user:{target_id}:dm", payload)
    await hub.publish(f"user:{me.user_id}:dm", payload)
    return payload


@router.delete("/chat/messages/{msg_id}", status_code=204)
async def delete_message(msg_id: int, principal: Principal = Depends(get_current_principal),
                         db: Session = Depends(get_db)):
    m = db.get(ChatMessage, msg_id)
    if not m:
        raise HTTPException(status_code=404)
    if m.user_id != principal.user_id and not principal.is_admin:
        raise HTTPException(status_code=403, detail="No puedes borrar este mensaje.")
    room_id, recipient, author = getattr(m, "room_id", None), m.recipient_id, m.user_id
    db.delete(m)
    db.commit()
    event = {"type": "delete_msg", "msg_id": msg_id, "user_id": author, "recipient_id": recipient}
    hub = get_hub()
    if recipient:
        await hub.publish(f"user:{recipient}:dm", event)
        await hub.publish(f"user:{author}:dm", event)
    elif room_id:
        await hub.publish(f"room:{room_id}:text", {**event, "room_id": room_id})


# ================================================================ likes

@router.post("/posts/{post_id}/like")
def toggle_like(post_id: int, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    if not db.get(Post, post_id):
        raise HTTPException(status_code=404)
    removed = db.execute(text("DELETE FROM post_likes WHERE user_id = :u AND post_id = :p"),
                         {"u": principal.user_id, "p": post_id}).rowcount
    if not removed:
        db.execute(text("INSERT INTO post_likes (user_id, post_id) VALUES (:u, :p) ON CONFLICT DO NOTHING"),
                   {"u": principal.user_id, "p": post_id})
    count = db.execute(text("""UPDATE posts SET likes_count = (SELECT count(*) FROM post_likes WHERE post_id = :p)
                               WHERE id = :p RETURNING likes_count"""), {"p": post_id}).scalar_one()
    db.commit()
    return {"liked": not removed, "likes_count": int(count)}
