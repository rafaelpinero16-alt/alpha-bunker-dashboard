"""
routers/social_v2.py — Reemplazo seguro de los endpoints v1 que confiaban en IDs del cliente.

Vulnerabilidades v1 que cierra (todas explotables con un simple curl):
  * POST /posts/unlock {user_id: VÍCTIMA}  → gastaba el saldo de otro usuario.
  * POST /videocalls/request {fan_id: VÍCTIMA} → idem; /respond aceptaba cualquier creator_id.
  * POST /wallet/send-tip {sender_id: VÍCTIMA} → idem (según api.js).
  * GET  /posts/feed/{id} devolvía media_url de posts PPV BLOQUEADOS → paywall inexistente.
  * POST /posts/create {user_id, levelRequired…} → publicar como cualquiera.
  * PUT  /users/{id}, POST /users/follow, POST /posts/delete → editar/borrar ajeno.
  * Feed con N+1 consultas (1 query por post para el autor).
"""
from __future__ import annotations

import uuid
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from auth.dependencies import (
    Principal, StrictBody, get_current_principal, get_optional_principal, require_creator,
)
from database.db import get_db
from database.models import Follow, Post, UnlockedPost, User, VideoCallSession, Wallet
from services import ledger
from services.moderation import normalize_text, validate_media_url

router = APIRouter(prefix="/v2", tags=["Social & Wallet v2"])


# =========================================================== wallet

@router.get("/wallet/me")
def my_wallet(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    w = db.execute(select(Wallet).where(Wallet.user_id == principal.user_id)).scalar_one_or_none()
    return {"alpha_balance": int(w.alpha_balance or 0) if w else 0,
            "total_earned": int(w.total_earned or 0) if w else 0,
            "total_spent": int(w.total_spent or 0) if w else 0}


class TipBody(StrictBody):
    creator_id: int
    amount: int = Field(gt=0, le=100_000)
    post_id: Optional[int] = None
    client_ref: str = Field(min_length=8, max_length=64)  # UUID del cliente: anti doble clic


@router.post("/wallet/tip")
def tip(body: TipBody, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    creator = db.execute(select(User).where(User.user_id == body.creator_id)).scalar_one_or_none()
    if not creator or creator.role not in ("creator", "admin"):
        raise HTTPException(status_code=404, detail="Creador no encontrado.")
    try:
        sender_bal, _ = ledger.transfer(
            db, principal.user_id, body.creator_id, body.amount, "tip",
            reference=f"post:{body.post_id}" if body.post_id else None,
            idempotency_key=f"tip:{principal.user_id}:{body.client_ref}")
    except ledger.InsufficientFunds:
        raise HTTPException(status_code=402, detail="Saldo insuficiente.")
    except ledger.DuplicateOperation:
        db.rollback()
        return {"status": "duplicate"}
    except ledger.LedgerError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return {"status": "success", "alpha_balance": sender_bal}


# =========================================================== posts

class PostBody(StrictBody):
    text: Optional[str] = Field(default=None, max_length=5000)
    media_url: Optional[str] = None          # URL del almacenamiento de objetos, NO base64
    level_required: int = Field(default=0, ge=0, le=4)
    is_ppv: bool = False
    price_alpha: int = Field(default=0, ge=0, le=1_000_000)


@router.get("/posts/feed")
def feed(limit: int = Query(30, ge=1, le=100), before_id: Optional[int] = None,
         principal: Optional[Principal] = Depends(get_optional_principal), db: Session = Depends(get_db)):
    uid = principal.user_id if principal else None
    level = principal.access_level if principal else 0
    is_admin = bool(principal and principal.is_admin)

    q = select(Post, User).join(User, User.user_id == Post.creator_id, isouter=True) \
        .order_by(Post.id.desc()).limit(limit)
    if before_id:
        q = q.where(Post.id < before_id)
    rows = db.execute(q).all()

    unlocked: set[int] = set()
    if uid and rows:
        unlocked = set(db.execute(select(UnlockedPost.post_id).where(
            UnlockedPost.user_id == uid, UnlockedPost.post_id.in_([p.id for p, _ in rows]))).scalars())

    out = []
    for p, author in rows:
        own = uid is not None and p.creator_id == uid
        ppv_locked = bool(p.is_ppv and (p.price_alpha or 0) > 0 and p.id not in unlocked)
        tier_locked = (p.levelRequired or 0) > level
        locked = not (own or is_admin) and (ppv_locked or tier_locked)
        out.append({
            "id": p.id, "creator_id": p.creator_id, "author": p.author,
            "author_role": author.role if author else "fan",
            "author_avatar": author.avatar_url if author else None,
            "is_online": bool(getattr(author, "is_online", False)) if author else False,
            "content": None if locked and p.is_ppv else p.text_es,
            "media_url": None if locked else p.image_url,   # ← el contenido bloqueado NO sale del servidor
            "levelRequired": p.levelRequired, "is_ppv": p.is_ppv, "price_alpha": p.price_alpha,
            "is_locked": locked, "likes_count": int(getattr(p, "likes_count", 0) or 0),
            "date_created": p.date_created.isoformat() if p.date_created else None,
        })
    return {"posts": out}


@router.post("/posts", status_code=201)
def create_post(body: PostBody, principal: Principal = Depends(require_creator), db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    if not principal.is_admin and getattr(user, "kyc_status", None) != "verified":
        raise HTTPException(status_code=403, detail="Publicar requiere KYC aprobado.")
    try:
        media = validate_media_url(body.media_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if body.is_ppv and body.price_alpha <= 0:
        raise HTTPException(status_code=400, detail="Un PPV necesita precio.")
    post = Post(creator_id=principal.user_id, author=user.name, text_es=normalize_text(body.text) or None,
                image_url=media, levelRequired=body.level_required, is_ppv=body.is_ppv,
                price_alpha=body.price_alpha if body.is_ppv else 0)
    db.add(post)
    db.commit()
    return {"post_id": post.id}


@router.post("/posts/{post_id}/unlock")
def unlock_post(post_id: int, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Publicación no encontrada.")
    if not post.is_ppv or (post.price_alpha or 0) <= 0 or post.creator_id == principal.user_id:
        return {"status": "success", "media_url": post.image_url, "price_paid": 0}

    inserted = db.execute(
        pg_insert(UnlockedPost.__table__).values(user_id=principal.user_id, post_id=post_id)
        .on_conflict_do_nothing().returning(UnlockedPost.__table__.c.post_id)
    ).first()
    if inserted is None:
        db.rollback()
        return {"status": "success", "media_url": post.image_url, "price_paid": 0}
    try:
        ledger.transfer(db, principal.user_id, post.creator_id, int(post.price_alpha), "ppv_unlock",
                        reference=f"post:{post_id}", idempotency_key=f"ppv:{principal.user_id}:{post_id}")
    except ledger.InsufficientFunds:
        db.rollback()
        raise HTTPException(status_code=402, detail="Saldo insuficiente en $ALPHA.")
    db.commit()
    return {"status": "success", "media_url": post.image_url, "price_paid": post.price_alpha}


@router.delete("/posts/{post_id}", status_code=204)
def delete_post(post_id: int, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404)
    if post.creator_id != principal.user_id and not principal.is_admin:
        raise HTTPException(status_code=403, detail="No puedes borrar este post.")
    db.delete(post)
    db.commit()


# =========================================================== perfil y follows

class ProfileBody(StrictBody):
    name: Optional[str] = Field(default=None, min_length=2, max_length=48)
    bio: Optional[str] = Field(default=None, max_length=300)
    avatar_url: Optional[str] = None


@router.put("/users/me")
def update_me(body: ProfileBody, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.user_id == principal.user_id)).scalar_one()
    if body.name is not None:
        name = normalize_text(body.name)
        if name.lower() in {"admin", "centinela", "soporte", "support"}:
            raise HTTPException(status_code=400, detail="Nombre reservado.")
        user.name = name
    if body.bio is not None:
        user.bio = normalize_text(body.bio)
    if body.avatar_url is not None:
        try:
            user.avatar_url = validate_media_url(body.avatar_url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return {"user_id": user.user_id, "name": user.name, "bio": user.bio, "avatar_url": user.avatar_url}


@router.post("/users/{target_id}/follow")
def toggle_follow(target_id: int, principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    if target_id == principal.user_id:
        raise HTTPException(status_code=400, detail="No puedes seguirte a ti mismo.")
    removed = db.execute(delete(Follow).where(Follow.follower_id == principal.user_id,
                                              Follow.following_id == target_id)).rowcount
    if not removed:
        db.execute(pg_insert(Follow.__table__).values(follower_id=principal.user_id, following_id=target_id)
                   .on_conflict_do_nothing())
    db.commit()
    return {"following": not removed}


# =========================================================== videollamadas 1:1

class CallRequestBody(StrictBody):
    creator_id: int
    client_ref: str = Field(min_length=8, max_length=64)


class CallRespondBody(StrictBody):
    action: Literal["accept", "reject"]


CALL_PRICE_FIELD = "videocall_price_alpha"  # TODO-NEGOCIO: precio fijado por el CREADOR, no por el fan


@router.post("/videocalls")
def request_call(body: CallRequestBody, principal: Principal = Depends(get_current_principal),
                 db: Session = Depends(get_db)):
    creator = db.execute(select(User).where(User.user_id == body.creator_id)).scalar_one_or_none()
    if not creator or creator.role not in ("creator", "admin") or creator.user_id == principal.user_id:
        raise HTTPException(status_code=404, detail="Creador no disponible.")
    price = int(getattr(creator, CALL_PRICE_FIELD, 0) or 0)
    if price <= 0:
        raise HTTPException(status_code=409, detail="Este creador no ofrece videollamadas.")
    try:
        ledger.debit(db, principal.user_id, price, "videocall_hold",
                     reference=f"creator:{creator.user_id}",
                     idempotency_key=f"call:{principal.user_id}:{body.client_ref}")
    except ledger.InsufficientFunds:
        raise HTTPException(status_code=402, detail="Saldo insuficiente.")
    except ledger.DuplicateOperation:
        db.rollback()
        raise HTTPException(status_code=409, detail="Solicitud duplicada.")
    room = f"call_{uuid.uuid4().hex[:16]}"  # v1: room_url predecible "room_{fan}_{creator}"
    session = VideoCallSession(fan_id=principal.user_id, creator_id=creator.user_id, cost_alpha=price,
                               status="pending", room_url=room)
    db.add(session)
    db.commit()
    return {"session_id": session.id, "status": "pending"}


@router.post("/videocalls/{session_id}/respond")
def respond_call(session_id: int, body: CallRespondBody, principal: Principal = Depends(get_current_principal),
                 db: Session = Depends(get_db)):
    s = db.execute(select(VideoCallSession).where(VideoCallSession.id == session_id).with_for_update()
                   ).scalar_one_or_none()
    if not s or s.creator_id != principal.user_id or s.status != "pending":
        raise HTTPException(status_code=404, detail="Solicitud no encontrada o ya procesada.")
    if body.action == "reject":
        s.status = "rejected"
        ledger.credit(db, s.fan_id, int(s.cost_alpha), "videocall_refund",
                      reference=f"call:{s.id}", idempotency_key=f"call:{s.id}:settle")
    else:
        s.status = "accepted"
        ledger.credit(db, s.creator_id, int(s.cost_alpha), "videocall_completed",
                      reference=f"call:{s.id}", idempotency_key=f"call:{s.id}:settle")
    db.commit()
    return {"status": s.status, "room": s.room_url if s.status == "accepted" else None}
