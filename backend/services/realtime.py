"""
services/realtime.py — Bus de tiempo real con escalado horizontal.

Canales lógicos (estrictamente separados):
    room:{room_id}:text     mensajes de chat de texto (persistidos)
    room:{room_id}:signal   señalización WebRTC / presencia de video (NUNCA persistida)
    user:{user_id}          DMs y señales dirigidas a un usuario

Con REDIS_URL: cada réplica se suscribe en Redis solo a los canales que tienen
sockets locales y reenvía. Sin REDIS_URL: modo en memoria (UNA sola réplica).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any, Optional

from fastapi import WebSocket

log = logging.getLogger("alpha.realtime")
SEND_TIMEOUT_S = 5.0
PRESENCE_WINDOW_S = 90


class LocalHub:
    def __init__(self) -> None:
        self._subs: dict[str, set[WebSocket]] = defaultdict(set)
        self._presence: dict[str, dict[int, float]] = defaultdict(dict)
        self._claims: dict[str, float] = {}

    async def start(self) -> None: ...
    async def stop(self) -> None: ...

    # -------- suscripción local
    async def subscribe(self, channel: str, ws: WebSocket) -> None:
        self._subs[channel].add(ws)

    async def unsubscribe(self, channel: str, ws: WebSocket) -> None:
        subs = self._subs.get(channel)
        if subs:
            subs.discard(ws)
            if not subs:
                self._subs.pop(channel, None)

    def local_count(self, channel: str) -> int:
        return len(self._subs.get(channel, ()))

    # -------- publicación
    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        await self._deliver_local(channel, json.dumps(message, ensure_ascii=False, default=str))

    async def _deliver_local(self, channel: str, raw: str) -> None:
        targets = list(self._subs.get(channel, ()))
        if not targets:
            return

        async def _send(ws: WebSocket) -> None:
            try:
                await asyncio.wait_for(ws.send_text(raw), SEND_TIMEOUT_S)
            except Exception:
                # Cliente lento o muerto: se retira para no frenar al resto.
                await self.unsubscribe(channel, ws)

        await asyncio.gather(*(_send(ws) for ws in targets))

    # -------- presencia
    async def presence_touch(self, room_id: str, user_id: int) -> None:
        self._presence[room_id][user_id] = time.time()

    async def presence_leave(self, room_id: str, user_id: int) -> None:
        self._presence[room_id].pop(user_id, None)

    async def presence_members(self, room_id: str) -> list[int]:
        cutoff = time.time() - PRESENCE_WINDOW_S
        return [u for u, ts in self._presence[room_id].items() if ts >= cutoff]

    # -------- un solo uso (tickets WS)
    async def claim_once(self, key: str, ttl_s: int) -> bool:
        now = time.time()
        for k in [k for k, exp in self._claims.items() if exp < now]:
            self._claims.pop(k, None)
        if key in self._claims:
            return False
        self._claims[key] = now + ttl_s
        return True


class RedisHub(LocalHub):
    PREFIX = "ab:"

    def __init__(self, url: str) -> None:
        super().__init__()
        self._url = url
        self._redis = None
        self._pubsub = None
        self._reader: Optional[asyncio.Task] = None

    async def start(self) -> None:
        import redis.asyncio as aioredis

        self._redis = aioredis.from_url(self._url, decode_responses=True)
        self._pubsub = self._redis.pubsub()
        # Canal ancla para que get_message tenga algo suscrito desde el inicio.
        await self._pubsub.subscribe(self.PREFIX + "_ctl")
        self._reader = asyncio.create_task(self._read_loop())

    async def stop(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._pubsub:
            await self._pubsub.close()
        if self._redis:
            await self._redis.close()

    async def _read_loop(self) -> None:
        while True:
            try:
                msg = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if msg and msg.get("type") == "message":
                    channel = msg["channel"][len(self.PREFIX):]
                    await self._deliver_local(channel, msg["data"])
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("[REALTIME] Error leyendo Redis; reintentando")
                await asyncio.sleep(1)

    async def subscribe(self, channel: str, ws: WebSocket) -> None:
        first = self.local_count(channel) == 0
        await super().subscribe(channel, ws)
        if first:
            await self._pubsub.subscribe(self.PREFIX + channel)

    async def unsubscribe(self, channel: str, ws: WebSocket) -> None:
        await super().unsubscribe(channel, ws)
        if self.local_count(channel) == 0:
            try:
                await self._pubsub.unsubscribe(self.PREFIX + channel)
            except Exception:
                pass

    async def publish(self, channel: str, message: dict[str, Any]) -> None:
        await self._redis.publish(self.PREFIX + channel,
                                  json.dumps(message, ensure_ascii=False, default=str))

    async def presence_touch(self, room_id: str, user_id: int) -> None:
        await self._redis.zadd(f"{self.PREFIX}presence:{room_id}", {str(user_id): time.time()})

    async def presence_leave(self, room_id: str, user_id: int) -> None:
        await self._redis.zrem(f"{self.PREFIX}presence:{room_id}", str(user_id))

    async def presence_members(self, room_id: str) -> list[int]:
        key = f"{self.PREFIX}presence:{room_id}"
        cutoff = time.time() - PRESENCE_WINDOW_S
        await self._redis.zremrangebyscore(key, 0, cutoff)
        return [int(u) for u in await self._redis.zrange(key, 0, -1)]

    async def claim_once(self, key: str, ttl_s: int) -> bool:
        return bool(await self._redis.set(f"{self.PREFIX}once:{key}", "1", nx=True, ex=ttl_s))


_hub: Optional[LocalHub] = None


def get_hub() -> LocalHub:
    if _hub is None:
        raise RuntimeError("Hub de tiempo real no inicializado (llama a init_hub en el lifespan).")
    return _hub


async def init_hub(redis_url: str) -> LocalHub:
    global _hub
    _hub = RedisHub(redis_url) if redis_url else LocalHub()
    await _hub.start()
    if not redis_url:
        log.warning("[REALTIME] Sin REDIS_URL: modo memoria, NO escalar a más de 1 réplica.")
    return _hub
