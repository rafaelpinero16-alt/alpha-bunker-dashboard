"""
services/moderation.py — Sanitización y moderación en SERVIDOR.

Principios:
  * Se guarda el texto normalizado, NO escapado a HTML: el cliente lo pinta
    con textContent. (v1 escapaba en el cliente ANTES de enviar → doble
    escape y, peor, cualquiera que hablara directo con el WS se lo saltaba.)
  * La lista de términos vive fuera del código (MODERATION_TERMS_FILE, un
    término por línea) para poder ajustarla sin redeploy y sin publicarla.
    Revisa los términos genéricos de v1 ("pizza", "map", "blood", "kill"…):
    con \\b multaban conversaciones normales.
  * media_url: solo https y solo hosts de tu almacenamiento (MEDIA_ALLOWED_HOSTS).
    Nunca data:/base64 por el WebSocket.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional
from urllib.parse import urlparse

from core.settings import get_settings

MAX_TEXT_LEN = 1000
_CONTROL_CHARS = re.compile(r"[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]")
LINK_RE = re.compile(
    r"(?i)(?:https?://|www\.|t\.me/|telegram\.me/)\S+"
    r"|(?:\b[a-z0-9-]+\.)+(?:com|net|org|me|io|tm|co|tv|app|ly|gl|xyz|link|site)\b"
)


@dataclass(frozen=True)
class ModerationResult:
    ok: bool
    text: str
    media_url: Optional[str]
    reason: Optional[str] = None
    penalize: bool = False


@lru_cache(maxsize=1)
def _banned_re() -> Optional[re.Pattern]:
    path = get_settings().moderation_terms_file
    if not path:
        return None
    with open(path, encoding="utf-8") as fh:
        terms = [t.strip().lower() for t in fh if t.strip() and not t.startswith("#")]
    if not terms:
        return None
    return re.compile(r"(?i)\b(?:" + "|".join(map(re.escape, terms)) + r")\b")


def _fold(s: str) -> str:
    """Normaliza homoglifos/acentos simples para la detección (no para almacenar)."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.translate(str.maketrans("013457@$", "oieastas")).lower()


def normalize_text(raw: object) -> str:
    if not isinstance(raw, str):
        return ""
    text = unicodedata.normalize("NFC", raw)
    text = _CONTROL_CHARS.sub("", text).strip()
    return text[:MAX_TEXT_LEN]


def validate_media_url(raw: object) -> Optional[str]:
    if not raw:
        return None
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("media_url inválida")
    u = urlparse(raw)
    allowed = get_settings().media_allowed_hosts
    if u.scheme != "https" or not u.hostname or (allowed and u.hostname.lower() not in allowed):
        raise ValueError("media_url no permitida")
    return raw


def moderate(raw_text: object, raw_media: object, *, privileged: bool, access_level: int) -> ModerationResult:
    text = normalize_text(raw_text)
    try:
        media = validate_media_url(raw_media)
    except ValueError as exc:
        return ModerationResult(False, text, None, str(exc))

    if not text and not media:
        return ModerationResult(False, "", None, "Mensaje vacío.")
    if privileged:
        return ModerationResult(True, text, media)

    folded = _fold(text)
    banned = _banned_re()
    if banned and (banned.search(folded) or banned.search(text)):
        return ModerationResult(False, text, None, "Contenido prohibido.", penalize=True)

    # Enlaces: permitidos desde nivel 3 (Legend), bloqueados y multados por debajo.
    if access_level < 3 and LINK_RE.search(folded):
        return ModerationResult(False, text, None, "Enlaces no permitidos en tu rango.", penalize=True)

    return ModerationResult(True, text, media)


class TokenBucket:
    """Rate limit por conexión: `rate` mensajes cada `per` segundos."""

    def __init__(self, rate: int, per: float):
        import time
        self._time = time.monotonic
        self.capacity = float(rate)
        self.tokens = float(rate)
        self.refill = rate / per
        self.last = self._time()

    def allow(self) -> bool:
        now = self._time()
        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.refill)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False
