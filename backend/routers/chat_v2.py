"""
routers/chat_v2.py — Chat de texto, DMs y señalización de video, aislados por sala.

Endpoints:
  WS   /v2/chat/rooms/{room_id}/text?ticket=…     chat de texto (persistido)
  WS   /v2/video/rooms/{room_id}/signal?ticket=…  señalización WebRTC (efímera)
  WS   /v2/chat/dm?ticket=…                       mensajes directos
  GET  /v2/chat/rooms                             salas + permisos del usuario
  GET  /v2/chat/rooms/{room_id}/history           historial de una sala
  POST /v2/video/rooms/{room_id}/session          estrategia de video (TG nativo / SFU / mesh)

Correcciones frente a chat.py v1:
  * Identidad desde ticket firmado de un solo uso (v1: user_id en la URL → suplantación).
  * room_id SOLO de la ruta (v1: payload.room_id permitía escribir en salas restringidas).
  * min_access_level se exige al conectar (v1 nunca lo comprobaba).
  * Texto y señalización en sockets y canales distintos; la señalización no toca la BD.
  * Una sesión de BD por operación en threadpool (v1: una sesión por socket
    durante horas → agotamiento del pool y event loop bloqueado por I/O síncrono).
  * Cobros y propinas vía ledger con FOR UPDATE (v1: carreras → doble gasto).
  * Rechazo de creador sin KYC antes de accept() (v1: doble accept → excepción).
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional, TypeVar

import jwt as pyjwt
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from auth.dependencies import Principal, get_current_principal
from auth.jwt_tokens import TokenError, decode_ws_ticket
from core.settings import get_settings
from database.db import SessionLocal, get_db
from database.models import ChatMessage, User, VideoRoom
from services import ledger
from services.identity import telegram_id_for_user
from services.moderation import TokenBucket, moderate
from services.realtime import get_hub

log = logging.getLogger("alpha.chat")
router = APIRouter(prefix="/v2", tags=["Chat & Video v2"])

ROOM_ID_RE = re.compile(r"^[a-z0-9_]{2,50}$")
MAX_FRAME_TEXT = 4096
MAX_FRAME_SIGNAL = 16384
SPY_MESSAGE_FEE = 1
SPAM_PENALTY = 5
MAX_TIP = 100_000
SIGNAL_TYPES = {"webrtc_offer", "webrtc_answer", "webrtc_ice"}

T = TypeVar("T")


# ======================================================================= utilidades

async def in_db(fn: Callable[[Session], T]) -> T:
    """Ejecuta fn(db) en el threadpool con una sesión corta y commit/rollback."""
    def _run() -> T:
        db = SessionLocal()
        try:
            result = fn(db)
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
    return await run_in_threadpool(_run)


@dataclass(frozen=True)
class Actor:
    user_id: int
    name: str
    role: str
    access_level: int
    kyc_status: str

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class RoomInfo:
    room_id: str
    name: str
    min_access_level: int
    min_broadcast_level: int
    is_active: bool
    telegram_videochat_link: Optional[str]


def _load_actor(db: Session, user_id: int) -> Optional[Actor]:
    u = db.execute(select(User).where(User.user_id == user_id)).scalar_one_or_none()
    if not u or getattr(u, "is_disabled", False):
        return None
    role = u.role or "fan"
    tg = telegram_id_for_user(db, user_id)
    if tg is not None and tg in get_settings().bootstrap_admin_ids:
        role = "admin"
    return Actor(int(u.user_id), u.name or "Operativo", role, int(u.access_level or 0),
                 getattr(u, "kyc_status", None) or "unverified")


def _load_room(db: Session, room_id: str) -> Optional[RoomInfo]:
    r = db.execute(select(VideoRoom).where(VideoRoom.room_id == room_id)).scalar_one_or_none()
    if not r:
        return None
    return RoomInfo(r.room_id, r.name, int(r.min_access_level or 0), int(r.min_broadcast_level or 1),
                    bool(r.is_active if r.is_active is not None else True),
                    getattr(r, "telegram_videochat_link", None))


async def _authenticate_ws(ws: WebSocket, ticket: str) -> Optional[tuple[int, str]]:
    try:
        user_id, mode, jti = decode_ws_ticket(ticket)
    except TokenError:
        await ws.close(code=4401)
        return None
    if not await get_hub().claim_once(f"wsticket:{jti}", get_settings().ws_ticket_ttl_s + 30):
        await ws.close(code=4401)  # ticket reutilizado
        return None
    return user_id, mode


async def _admit(ws: WebSocket, room_id: str, ticket: str) -> Optional[tuple[Actor, RoomInfo]]:
    if not ROOM_ID_RE.match(room_id):
        await ws.close(code=4400)
        return None
    auth = await _authenticate_ws(ws, ticket)
    if not auth:
        return None
    user_id, _mode = auth
    actor, room = await in_db(lambda db: (_load_actor(db, user_id), _load_room(db, room_id)))
    if not actor:
        await ws.close(code=4401)
        return None
    if not room or not room.is_active:
        await ws.close(code=4404)
        return None
    if not actor.is_admin:
        if actor.role == "creator" and actor.kyc_status != "verified":
            await ws.close(code=4403, reason="KYC requerido")
            return None
        if actor.access_level < room.min_access_level:
            await ws.close(code=4403, reason="Rango insuficiente")
            return None
    await ws.accept()
    return actor, room


async def _send_error(ws: WebSocket, message: str, code: str = "error") -> None:
    try:
        await ws.send_json({"type": "error", "code": code, "is_error": True, "message": message})
    except Exception:
        pass


def _parse_frame(raw: str, limit: int) -> Optional[dict[str, Any]]:
    if len(raw) > limit:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


# ======================================================================= REST

@router.get("/chat/rooms")
def list_rooms(principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    rooms = db.execute(select(VideoRoom).where(VideoRoom.is_active.is_(True))).scalars().all()
    return {"rooms": [
        {
            "room_id": r.room_id, "name": r.name, "category": r.category, "description": r.description,
            "min_access_level": r.min_access_level, "min_broadcast_level": r.min_broadcast_level,
            "can_join": principal.is_admin or principal.access_level >= (r.min_access_level or 0),
            "can_broadcast": principal.is_admin or principal.access_level >= (r.min_broadcast_level or 1),
            "has_telegram_videochat": bool(getattr(r, "telegram_videochat_link", None)),
        } for r in rooms
    ]}


@router.get("/chat/rooms/{room_id}/history")
def room_history(room_id: str, limit: int = Query(50, ge=1, le=200),
                 principal: Principal = Depends(get_current_principal), db: Session = Depends(get_db)):
    room = _load_room(db, room_id) if ROOM_ID_RE.match(room_id) else None
    if not room:
        raise HTTPException(status_code=404, detail="Sala no encontrada.")
    if not principal.is_admin and principal.access_level < room.min_access_level:
        raise HTTPException(status_code=403, detail="Rango insuficiente.")
    rows = db.execute(
        select(ChatMessage).where(ChatMessage.room_id == room_id, ChatMessage.recipient_id.is_(None))
        .order_by(ChatMessage.created_at.desc()).limit(limit)
    ).scalars().all()
    return {"messages": [_msg_payload(m, room_id) for m in reversed(rows)]}


def _msg_payload(m: ChatMessage, room_id: Optional[str]) -> dict[str, Any]:
    # Forma compatible con app.appendChatMessage() de v1.
    return {
        "type": "new_msg", "id": m.id, "user_id": m.user_id, "author_name": m.author_name,
        "author_role": m.author_role, "access_level": m.access_level, "content": m.content,
        "is_system": bool(m.is_system), "room_id": room_id,
        "recipient_id": getattr(m, "recipient_id", None),
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


# ======================================================================= WS: texto

@router.websocket("/chat/rooms/{room_id}/text")
async def room_text_ws(ws: WebSocket, room_id: str, ticket: str = Query(...)):
    admitted = await _admit(ws, room_id, ticket)
    if not admitted:
        return
    actor, room = admitted
    hub = get_hub()
    channel = f"room:{room_id}:text"
    bucket = TokenBucket(rate=5, per=10)

    await hub.subscribe(channel, ws)
    await hub.presence_touch(room_id, actor.user_id)
    await hub.publish(channel, {"type": "online_count_update", "room_id": room_id,
                                "count": len(await hub.presence_members(room_id))})
    try:
        while True:
            frame = _parse_frame(await ws.receive_text(), MAX_FRAME_TEXT)
            if frame is None:
                await _send_error(ws, "Mensaje inválido o demasiado grande.")
                continue
            kind = frame.get("type", "chat")

            if kind == "ping":
                await hub.presence_touch(room_id, actor.user_id)
                continue

            if not bucket.allow():
                await _send_error(ws, "Vas demasiado rápido.", "rate_limited")
                continue

            if kind == "chat":
                await _handle_room_chat(ws, actor, room_id, frame, channel)
            elif kind == "live_tip":
                await _handle_tip(ws, actor, room_id, frame, channel)
            else:
                await _send_error(ws, "Tipo de mensaje no soportado en el canal de texto.")
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unsubscribe(channel, ws)
        await hub.presence_leave(room_id, actor.user_id)
        try:
            await hub.publish(channel, {"type": "online_count_update", "room_id": room_id,
                                        "count": len(await hub.presence_members(room_id))})
        except Exception:
            pass


async def _handle_room_chat(ws: WebSocket, actor: Actor, room_id: str, frame: dict, channel: str) -> None:
    def persist(db: Session) -> dict[str, Any]:
        fresh = _load_actor(db, actor.user_id)
        if not fresh:
            raise PermissionError("Cuenta no disponible.")
        privileged = fresh.is_admin
        verdict = moderate(frame.get("text"), frame.get("media_url"),
                           privileged=privileged, access_level=fresh.access_level)

        if not verdict.ok:
            if verdict.penalize:
                db.execute(update(User).where(User.user_id == fresh.user_id)
                           .values(warnings_count=User.warnings_count + 1))
                try:
                    ledger.debit(db, fresh.user_id, SPAM_PENALTY, "spam_penalty", room_id=room_id)
                except ledger.InsufficientFunds:
                    pass
            return {"error": verdict.reason, "penalized": verdict.penalize}

        if not privileged and fresh.access_level == 0:
            try:
                ledger.debit(db, fresh.user_id, SPY_MESSAGE_FEE, "message_fee", room_id=room_id)
            except ledger.InsufficientFunds:
                return {"error": f"Rango ESPÍA: cada mensaje cuesta {SPY_MESSAGE_FEE} $ALPHA. Saldo insuficiente."}

        msg = ChatMessage(
            user_id=fresh.user_id, author_name=fresh.name, author_role=fresh.role,
            access_level=fresh.access_level, is_system=False, room_id=room_id,
            content=json.dumps({"text": verdict.text, "media_url": verdict.media_url, "room_id": room_id},
                               ensure_ascii=False),
        )
        db.add(msg)
        db.flush()
        db.refresh(msg)
        return {"payload": _msg_payload(msg, room_id)}

    try:
        result = await in_db(persist)
    except PermissionError as exc:
        await _send_error(ws, str(exc))
        return
    if "error" in result:
        await _send_error(ws, result["error"], "moderation" if result.get("penalized") else "rejected")
        return
    await get_hub().publish(channel, result["payload"])


async def _handle_tip(ws: WebSocket, actor: Actor, room_id: str, frame: dict, channel: str) -> None:
    try:
        target_id = int(frame.get("target_id"))
        amount = int(frame.get("amount"))
        client_ref = str(frame.get("client_ref", ""))[:64]
    except (TypeError, ValueError):
        await _send_error(ws, "Propina inválida.")
        return
    if not (0 < amount <= MAX_TIP) or target_id == actor.user_id:
        await _send_error(ws, "Monto o destinatario inválido.")
        return
    if target_id not in await get_hub().presence_members(room_id):
        await _send_error(ws, "El destinatario no está en esta sala.")
        return

    key = f"tip:{actor.user_id}:{client_ref}" if client_ref else None

    def do_tip(db: Session) -> Optional[str]:
        try:
            ledger.transfer(db, actor.user_id, target_id, amount, "live_tip",
                            reference=f"room:{room_id}", idempotency_key=key, room_id=room_id)
        except ledger.InsufficientFunds:
            return "Saldo insuficiente de $ALPHA."
        except ledger.DuplicateOperation:
            return "dup"
        return None

    err = await in_db(do_tip)
    if err == "dup":
        return
    if err:
        await _send_error(ws, err)
        return
    await get_hub().publish(channel, {
        "type": "live_tip_alert", "room_id": room_id, "sender_id": actor.user_id,
        "sender_name": actor.name, "streamer_id": target_id, "amount": amount,
    })


# ======================================================================= WS: señalización

@router.websocket("/video/rooms/{room_id}/signal")
async def room_signal_ws(ws: WebSocket, room_id: str, ticket: str = Query(...)):
    admitted = await _admit(ws, room_id, ticket)
    if not admitted:
        return
    actor, room = admitted
    hub = get_hub()
    s = get_settings()
    room_channel = f"room:{room_id}:signal"
    my_channel = f"sig:{room_id}:{actor.user_id}"
    pub_key = f"{room_id}:publishers"
    bucket = TokenBucket(rate=60, per=10)  # ICE genera ráfagas
    publishing = False

    await hub.subscribe(room_channel, ws)
    await hub.subscribe(my_channel, ws)
    await hub.presence_touch(f"{room_id}:signal", actor.user_id)
    await ws.send_json({"type": "signal_ready", "room_id": room_id,
                        "publishers": await hub.presence_members(pub_key),
                        "mesh_max_publishers": s.mesh_max_publishers})
    try:
        while True:
            frame = _parse_frame(await ws.receive_text(), MAX_FRAME_SIGNAL)
            if frame is None or not bucket.allow():
                continue
            kind = frame.get("type")

            if kind == "ping":
                await hub.presence_touch(f"{room_id}:signal", actor.user_id)
                if publishing:
                    await hub.presence_touch(pub_key, actor.user_id)
                continue

            if kind == "join_video":
                if not actor.is_admin and actor.access_level < room.min_broadcast_level:
                    await _send_error(ws, "Tu rango no puede transmitir en esta sala.", "tier_error")
                    continue
                current = await hub.presence_members(pub_key)
                if actor.user_id not in current and len(current) >= s.mesh_max_publishers:
                    await _send_error(ws, "Sala llena para video P2P. Usa el modo SFU.", "mesh_full")
                    continue
                publishing = True
                await hub.presence_touch(pub_key, actor.user_id)
                await hub.publish(room_channel, {"type": "radar_update", "room_id": room_id,
                                                 "user_id": actor.user_id, "name": actor.name, "status": "live"})
            elif kind == "leave_video":
                publishing = False
                await hub.presence_leave(pub_key, actor.user_id)
                await hub.publish(room_channel, {"type": "radar_update", "room_id": room_id,
                                                 "user_id": actor.user_id, "name": actor.name, "status": "online"})
            elif kind in SIGNAL_TYPES:
                try:
                    target = int(frame.get("target_id"))
                except (TypeError, ValueError):
                    continue
                if target not in await hub.presence_members(f"{room_id}:signal"):
                    continue
                await hub.publish(f"sig:{room_id}:{target}", {
                    "type": kind, "room_id": room_id, "caller_id": actor.user_id,
                    "caller_name": actor.name,
                    "sdp": frame.get("sdp"), "candidate": frame.get("candidate"),
                })
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unsubscribe(room_channel, ws)
        await hub.unsubscribe(my_channel, ws)
        await hub.presence_leave(f"{room_id}:signal", actor.user_id)
        if publishing:
            await hub.presence_leave(pub_key, actor.user_id)
            try:
                await hub.publish(room_channel, {"type": "radar_update", "room_id": room_id,
                                                 "user_id": actor.user_id, "status": "offline"})
            except Exception:
                pass


# ======================================================================= WS: DMs

@router.websocket("/chat/dm")
async def dm_ws(ws: WebSocket, ticket: str = Query(...)):
    auth = await _authenticate_ws(ws, ticket)
    if not auth:
        return
    user_id, _ = auth
    actor = await in_db(lambda db: _load_actor(db, user_id))
    if not actor:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub = get_hub()
    my_channel = f"user:{actor.user_id}:dm"
    bucket = TokenBucket(rate=10, per=10)
    await hub.subscribe(my_channel, ws)
    try:
        while True:
            frame = _parse_frame(await ws.receive_text(), MAX_FRAME_TEXT)
            if frame is None or not bucket.allow():
                await _send_error(ws, "Mensaje inválido o demasiado rápido.")
                continue
            kind = frame.get("type", "dm")
            try:
                target = int(frame.get("target_id"))
            except (TypeError, ValueError):
                await _send_error(ws, "Destinatario inválido.")
                continue
            if target == actor.user_id:
                continue

            if kind == "mark_read":
                await in_db(lambda db: db.execute(
                    update(ChatMessage).where(ChatMessage.user_id == target,
                                              ChatMessage.recipient_id == actor.user_id,
                                              ChatMessage.is_read.is_(False)).values(is_read=True)))
                await hub.publish(f"user:{target}:dm", {"type": "messages_read", "reader_id": actor.user_id})
                continue

            def persist(db: Session) -> Optional[dict[str, Any]]:
                if not db.execute(select(User.user_id).where(User.user_id == target)).first():
                    return None
                fresh = _load_actor(db, actor.user_id)
                verdict = moderate(frame.get("text"), frame.get("media_url"),
                                   privileged=bool(fresh and fresh.is_admin),
                                   access_level=fresh.access_level if fresh else 0)
                if not verdict.ok:
                    return {"error": verdict.reason}
                msg = ChatMessage(user_id=actor.user_id, recipient_id=target, author_name=actor.name,
                                  author_role=actor.role, access_level=actor.access_level, is_system=False,
                                  content=json.dumps({"text": verdict.text, "media_url": verdict.media_url},
                                                     ensure_ascii=False))
                db.add(msg)
                db.flush()
                db.refresh(msg)
                return {"payload": _msg_payload(msg, None)}

            result = await in_db(persist)
            if result is None:
                await _send_error(ws, "Usuario no encontrado.")
            elif "error" in result:
                await _send_error(ws, result["error"])
            else:
                await hub.publish(f"user:{target}:dm", result["payload"])
                await hub.publish(my_channel, result["payload"])
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unsubscribe(my_channel, ws)


# ======================================================================= estrategia de video

@router.post("/video/rooms/{room_id}/session")
def video_session(room_id: str, principal: Principal = Depends(get_current_principal),
                  db: Session = Depends(get_db)):
    """Decide CÓMO se hace el video en esta sala para este cliente:
       1. TMA + sala con grupo de Telegram → Video Chat nativo (no se puede embeber
          en la Mini App: el cliente lo abre con openTelegramLink).
       2. LiveKit configurado → SFU (escala a decenas de participantes).
       3. Si no, mesh P2P limitado a MESH_MAX_PUBLISHERS emisores."""
    room = _load_room(db, room_id) if ROOM_ID_RE.match(room_id) else None
    if not room or not room.is_active:
        raise HTTPException(status_code=404, detail="Sala no encontrada.")
    if not principal.is_admin and principal.access_level < room.min_access_level:
        raise HTTPException(status_code=403, detail="Rango insuficiente.")
    can_publish = principal.is_admin or principal.access_level >= room.min_broadcast_level
    s = get_settings()

    if principal.auth_mode == "telegram" and room.telegram_videochat_link:
        return {"mode": "telegram_native", "url": room.telegram_videochat_link, "can_publish": can_publish}

    if s.livekit_enabled:
        now = int(time.time())
        token = pyjwt.encode({
            "iss": s.livekit_api_key, "sub": str(principal.user_id), "nbf": now, "exp": now + 3600,
            "video": {"room": room_id, "roomJoin": True, "canSubscribe": True,
                      "canPublish": can_publish, "canPublishData": True},
        }, s.livekit_api_secret, algorithm="HS256")
        return {"mode": "sfu", "provider": "livekit", "url": s.livekit_url, "token": token,
                "can_publish": can_publish}

    return {"mode": "mesh", "max_publishers": s.mesh_max_publishers, "can_publish": can_publish,
            "ice_servers": [{"urls": "stun:stun.l.google.com:19302"}]}
