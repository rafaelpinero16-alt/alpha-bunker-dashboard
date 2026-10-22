"""
services/telegram_community.py — Ciclo de vida de membresías en canales/grupos VIP.

Modelo de acceso: enlaces con creates_join_request=True.
  * Un enlace compartido no da acceso a nadie más: cada solicitud de unión se
    APRUEBA solo si el Telegram ID solicitante tiene una membresía activa para
    ese chat. (member_limit=1 y creates_join_request son excluyentes en la API;
    preferimos la verificación por identidad.)
  * El enlace caduca a las 48 h y se revoca al usarse o al expirar la membresía.
  * Al expirar: ban + unban inmediato (= expulsión sin baneo permanente).

Bugs v1 corregidos:
  * name del enlace > 32 caracteres ("Acceso VIP ICON-LEGEND - 8269470905" = 35)
    → la API devolvía 400 justo en el tier más caro y el fan nunca recibía acceso.
  * parse_mode="Markdown" con enlaces que contienen "_" rompía el mensaje.
  * Sin verificación de permisos del bot ni revocación al vencer.
"""
from __future__ import annotations

import asyncio
import html
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from aiogram import Bot
from aiogram.enums import ChatMemberStatus
from aiogram.exceptions import (
    TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter,
)
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from core.settings import get_settings
from database.db import SessionLocal
from database.models import User
from database.models_v2 import Membership
from services.fulfillment import recompute_access_level
from services.identity import telegram_id_for_user, user_id_for_telegram

log = logging.getLogger("alpha.community")

INVITE_TTL = timedelta(hours=48)
MAX_INVITE_ATTEMPTS = 8
WORKER_ADVISORY_LOCK_ID = 7_310_442_001  # constante arbitraria compartida por réplicas


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class ChatPermissionReport:
    chat_id: int
    ok: bool
    is_admin: bool
    can_invite_users: bool
    can_restrict_members: bool
    detail: str


class TelegramCommunityService:
    def __init__(self, bot: Bot):
        self.bot = bot
        self._bot_id: Optional[int] = None

    async def _me(self) -> int:
        if self._bot_id is None:
            self._bot_id = (await self.bot.get_me()).id
        return self._bot_id

    async def _call(self, coro_factory, retries: int = 3):
        """Ejecuta una llamada a la Bot API respetando flood-wait (429)."""
        for attempt in range(retries):
            try:
                return await coro_factory()
            except TelegramRetryAfter as exc:
                await asyncio.sleep(min(exc.retry_after + 1, 60))
        return await coro_factory()

    # ------------------------------------------------------------------ permisos
    async def verify_bot_permissions(self) -> list[ChatPermissionReport]:
        reports: list[ChatPermissionReport] = []
        bot_id = await self._me()
        for slug, chat_id in get_settings().tier_chat_ids.items():
            try:
                m = await self._call(lambda: self.bot.get_chat_member(chat_id, bot_id))
                is_admin = m.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR)
                can_invite = bool(getattr(m, "can_invite_users", False)) or m.status == ChatMemberStatus.CREATOR
                can_restrict = bool(getattr(m, "can_restrict_members", False)) or m.status == ChatMemberStatus.CREATOR
                ok = is_admin and can_invite and can_restrict
                reports.append(ChatPermissionReport(chat_id, ok, is_admin, can_invite, can_restrict,
                                                    f"{slug}: {'OK' if ok else 'FALTAN PERMISOS'}"))
            except (TelegramBadRequest, TelegramForbiddenError) as exc:
                reports.append(ChatPermissionReport(chat_id, False, False, False, False, f"{slug}: {exc}"))
        for r in reports:
            (log.info if r.ok else log.error)("[COMMUNITY] %s", r.detail)
        return reports

    # ------------------------------------------------------------------ invitaciones
    async def issue_invite(self, db: Session, membership: Membership) -> Optional[str]:
        """Crea el enlace de unión y lo envía por DM. Idempotente: si ya hay enlace vigente, no crea otro."""
        if membership.status != "active" or not membership.chat_id:
            return None
        now = _utcnow()
        if membership.invite_link and membership.invite_link_expires_at and membership.invite_link_expires_at > now:
            return membership.invite_link

        tg_id = telegram_id_for_user(db, membership.user_id)
        if tg_id is None:
            return None  # cuenta Standalone sin Telegram vinculado: se reintenta cuando vincule

        expire = now + INVITE_TTL
        name = f"VIP {membership.tier_slug[:12]} {membership.user_id}"[:32]
        membership.invite_attempts = (membership.invite_attempts or 0) + 1
        try:
            link = await self._call(lambda: self.bot.create_chat_invite_link(
                chat_id=membership.chat_id, name=name,
                expire_date=expire, creates_join_request=True,
            ))
        except (TelegramBadRequest, TelegramForbiddenError) as exc:
            log.error("[COMMUNITY] create_chat_invite_link falló chat=%s: %s", membership.chat_id, exc)
            return None

        membership.invite_link = link.invite_link
        membership.invite_link_expires_at = expire
        db.commit()

        text_msg = (
            "🎟️ <b>Acceso VIP activado</b>\n\n"
            f"Rango: <b>{html.escape(membership.tier_slug.upper())}</b>\n"
            "Pulsa el enlace y solicita unirte; el bot te aprobará al instante:\n"
            f"{html.escape(link.invite_link)}\n\n"
            "El enlace caduca en 48 h y es personal: solo tu cuenta será aprobada."
        )
        try:
            await self._call(lambda: self.bot.send_message(tg_id, text_msg, parse_mode="HTML"))
        except TelegramForbiddenError:
            log.warning("[COMMUNITY] El usuario %s no ha iniciado el bot; el enlace queda visible en la app.", tg_id)
        return link.invite_link

    # ------------------------------------------------------------------ join requests
    async def handle_join_request(self, db: Session, chat_join_request: dict) -> None:
        chat_id = int(chat_join_request["chat"]["id"])
        tg_user_id = int(chat_join_request["from"]["id"])
        user_id = user_id_for_telegram(db, tg_user_id)

        allowed = False
        if user_id is not None:
            allowed = db.execute(
                select(Membership.id).where(
                    Membership.user_id == user_id,
                    Membership.chat_id == chat_id,
                    Membership.status == "active",
                )
            ).first() is not None

        try:
            if allowed:
                await self._call(lambda: self.bot.approve_chat_join_request(chat_id, tg_user_id))
                link = (chat_join_request.get("invite_link") or {}).get("invite_link")
                if link:
                    await self._safe_revoke(chat_id, link)
            else:
                await self._call(lambda: self.bot.decline_chat_join_request(chat_id, tg_user_id))
        except TelegramBadRequest as exc:
            # HIDE_REQUESTER_MISSING / USER_ALREADY_PARTICIPANT: inofensivos.
            log.info("[COMMUNITY] join_request chat=%s user=%s: %s", chat_id, tg_user_id, exc)

    async def _safe_revoke(self, chat_id: int, invite_link: str) -> None:
        try:
            await self._call(lambda: self.bot.revoke_chat_invite_link(chat_id, invite_link))
        except TelegramBadRequest:
            pass

    # ------------------------------------------------------------------ expulsión
    async def remove_member(self, chat_id: int, tg_user_id: int) -> None:
        try:
            m = await self._call(lambda: self.bot.get_chat_member(chat_id, tg_user_id))
            if m.status in (ChatMemberStatus.ADMINISTRATOR, ChatMemberStatus.CREATOR):
                return  # nunca expulsar staff
            await self._call(lambda: self.bot.ban_chat_member(chat_id, tg_user_id, revoke_messages=False))
            await self._call(lambda: self.bot.unban_chat_member(chat_id, tg_user_id, only_if_banned=True))
        except (TelegramBadRequest, TelegramForbiddenError) as exc:
            log.warning("[COMMUNITY] No se pudo expulsar %s de %s: %s", tg_user_id, chat_id, exc)

    # ------------------------------------------------------------------ worker
    async def run_cycle(self) -> None:
        """Un ciclo: expira membresías vencidas y reintenta invitaciones pendientes.

        Exclusión entre réplicas con pg_try_advisory_xact_lock en una sesión
        DEDICADA cuya transacción se mantiene abierta durante el ciclo: el lock
        se libera solo al hacer rollback, sin depender del pool de conexiones.
        """
        lock_db = SessionLocal()
        db = SessionLocal()
        try:
            got_lock = lock_db.execute(text("SELECT pg_try_advisory_xact_lock(:k)"),
                                       {"k": WORKER_ADVISORY_LOCK_ID}).scalar()
            if not got_lock:
                return  # otra réplica está ejecutando el ciclo
            await self._expire_due(db)
            await self._retry_pending_invites(db)
        finally:
            db.close()
            lock_db.rollback()
            lock_db.close()

    async def _expire_due(self, db: Session) -> None:
        now = _utcnow()
        due = db.execute(
            select(Membership).where(
                Membership.status == "active",
                Membership.expires_at.is_not(None),
                Membership.expires_at <= now,
            ).limit(200).with_for_update(skip_locked=True)
        ).scalars().all()
        to_kick: list[tuple[int, int, Optional[str]]] = []
        for m in due:
            m.status = "expired"
            user = db.execute(select(User).where(User.user_id == m.user_id).with_for_update()).scalar_one_or_none()
            if user:
                recompute_access_level(db, user)
            tg_id = telegram_id_for_user(db, m.user_id)
            if m.chat_id and tg_id:
                to_kick.append((m.chat_id, tg_id, m.invite_link))
            m.invite_link = None
        db.commit()  # primero BD, luego Telegram (si Telegram falla, el acceso en app ya está cerrado)

        for chat_id, tg_id, link in to_kick:
            if link:
                await self._safe_revoke(chat_id, link)
            await self.remove_member(chat_id, tg_id)
            try:
                await self._call(lambda: self.bot.send_message(
                    tg_id, "⌛ Tu membresía VIP ha expirado. Renueva desde la app para recuperar el acceso."))
            except (TelegramForbiddenError, TelegramBadRequest):
                pass

    async def _retry_pending_invites(self, db: Session) -> None:
        pending = db.execute(
            select(Membership).where(
                Membership.status == "active",
                Membership.chat_id.is_not(None),
                Membership.invite_link.is_(None),
                Membership.invite_attempts < MAX_INVITE_ATTEMPTS,
            ).limit(100)
        ).scalars().all()
        for m in pending:
            await self.issue_invite(db, m)
        db.commit()


async def membership_worker(service: TelegramCommunityService, stop: asyncio.Event) -> None:
    interval = get_settings().membership_worker_interval_s
    while not stop.is_set():
        try:
            await service.run_cycle()
        except Exception:  # el worker nunca debe morir
            log.exception("[COMMUNITY] Ciclo del worker falló")
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
