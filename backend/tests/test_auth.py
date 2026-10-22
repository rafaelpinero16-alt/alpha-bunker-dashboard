"""
tests/test_auth.py — Pruebas de initData y JWT (solo stdlib + PyJWT).

    cd backend && python -m pytest tests/test_auth.py -q
    # o sin pytest:  python tests/test_auth.py
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.update({
    "TELEGRAM_BOT_TOKEN": "123456:TEST-TOKEN",
    "TELEGRAM_BOT_USERNAME": "alpha_test_bot",
    "TELEGRAM_WEBHOOK_SECRET": "x" * 40,
    "MINI_APP_URL": "https://app.example.com",
    "PUBLIC_BACKEND_URL": "https://api.example.com",
    "JWT_SECRET": "j" * 48,
    "DATABASE_URL": "postgresql://localhost/test",
    "CORS_ORIGINS": "https://app.example.com",
})

from auth.jwt_tokens import (  # noqa: E402
    TokenError, decode_access_token, decode_ws_ticket, issue_access_token, issue_ws_ticket,
)
from auth.telegram_init_data import (  # noqa: E402
    InitDataError, sign_init_data_for_tests, verify_init_data,
)

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
NOW = int(time.time())
USER = json.dumps({"id": 8000001, "first_name": "Ana", "username": "ana"}, separators=(",", ":"))


def _fields(**over):
    base = {"auth_date": str(NOW), "query_id": "AAH", "user": USER}
    base.update(over)
    return base


def _raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc:
        return
    raise AssertionError(f"Se esperaba {exc.__name__}")


def test_valid_init_data():
    v = verify_init_data(sign_init_data_for_tests(_fields(), TOKEN), TOKEN, 3600, now=NOW)
    assert v.user.id == 8000001 and v.user.username == "ana"


def test_tampered_user_rejected():
    signed = sign_init_data_for_tests(_fields(), TOKEN)
    forged = signed.replace("8000001", "8269470905")
    _raises(InitDataError, verify_init_data, forged, TOKEN, 3600, now=NOW)


def test_wrong_bot_token_rejected():
    signed = sign_init_data_for_tests(_fields(), "999:OTHER")
    _raises(InitDataError, verify_init_data, signed, TOKEN, 3600, now=NOW)


def test_expired_rejected():
    signed = sign_init_data_for_tests(_fields(auth_date=str(NOW - 7200)), TOKEN)
    _raises(InitDataError, verify_init_data, signed, TOKEN, 3600, now=NOW)


def test_duplicate_keys_rejected():
    signed = sign_init_data_for_tests(_fields(), TOKEN)
    _raises(InitDataError, verify_init_data, signed + "&user=%7B%22id%22%3A1%7D", TOKEN, 3600, now=NOW)


def test_missing_hash_rejected():
    from urllib.parse import urlencode
    _raises(InitDataError, verify_init_data, urlencode(_fields()), TOKEN, 3600, now=NOW)


def test_access_token_roundtrip_and_tamper():
    tok, _ = issue_access_token(42, "standalone", "sid1")
    c = decode_access_token(tok)
    assert c.user_id == 42 and c.auth_mode == "standalone"
    head, body, sig = tok.split(".")
    _raises(TokenError, decode_access_token, f"{head}.{body}.{sig[:-2]}AA")


def test_ws_ticket_not_accepted_as_access():
    ticket, _ = issue_ws_ticket(7, "telegram")
    assert decode_ws_ticket(ticket)[0] == 7
    _raises(TokenError, decode_access_token, ticket)


def test_alg_none_rejected():
    import base64
    def b64(d): return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    forged = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': '1', 'typ': 'access'})}."
    _raises(TokenError, decode_access_token, forged)


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    for t in tests:
        t()
        print(f"OK  {t.__name__}")
    print(f"{len(tests)} tests superados")
