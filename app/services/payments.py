"""Pasarelas de pago: Telegram Stars, PayPal REST v2 y Binance Pay.

Incluye además el orquestador de checkout (`create_checkout`), la entrega del
producto (`fulfill_transaction`) y la verificación manual (`verify_transaction`).
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from html import escape
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional, Tuple
from uuid import uuid4

import httpx  # type: ignore[reportMissingImports]

if TYPE_CHECKING:
    from aiogram import Bot  # type: ignore[reportMissingImports]
    from aiogram.exceptions import TelegramAPIError  # type: ignore[reportMissingImports]
    from aiogram.types import LabeledPrice  # type: ignore[reportMissingImports]
else:
    try:
        from aiogram import Bot  # type: ignore[import-not-found]
        from aiogram.exceptions import TelegramAPIError  # type: ignore[import-not-found]
        from aiogram.types import LabeledPrice  # type: ignore[import-not-found]
    except ImportError:  # pragma: no cover - optional dependency in local/dev envs
        class Bot:  # type: ignore[override]
            def __getattr__(self, name: str) -> Any:
                raise ImportError("aiogram is not installed")

        class TelegramAPIError(Exception):
            pass

        class LabeledPrice:
            def __init__(self, label: str, amount: int) -> None:
                self.label = label
                self.amount = amount

try:
    from pydantic import BaseModel  # type: ignore[reportMissingImports]
except ImportError:  # pragma: no cover - optional dependency in local/dev envs
    class BaseModel:  # type: ignore[override]
        def __init__(self, **data: Any) -> None:
            for key, value in data.items():
                setattr(self, key, value)

from app.config import settings
from app.services.database import GatewayName, Transaction, db

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Catálogo de planes
# ---------------------------------------------------------------------------
class Plan(BaseModel):
    id: str
    level: int
    name: str
    emoji: str
    price_usd: float
    description: str
    features: List[str]


PLANS: Dict[str, Plan] = {
    "starter": Plan(
        id="starter",
        level=1,
        name="Pack de Arranque",
        emoji="🚀",
        price_usd=150.0,
        description="Blindaje base para una comunidad que empieza a crecer.",
        features=["Captcha anti-bots", "Bienvenida personalizada", "Lista negra de palabras"],
    ),
    "paid_channels": Plan(
        id="paid_channels",
        level=2,
        name="Canales de Pago",
        emoji="💎",
        price_usd=250.0,
        description="Monetiza tu canal con accesos VIP automáticos.",
        features=["Muro de pago con Stars, PayPal y Binance", "Invitaciones de un solo uso", "Todo lo del nivel 1"],
    ),
    "ecommerce_pro": Plan(
        id="ecommerce_pro",
        level=3,
        name="E-Commerce Pro",
        emoji="🛒",
        price_usd=500.0,
        description="Tienda y automatizaciones por bloques dentro de Telegram.",
        features=["Bloques lógicos ilimitados", "Catálogo y respuestas automáticas", "Todo lo del nivel 2"],
    ),
    "enterprise": Plan(
        id="enterprise",
        level=4,
        name="Enterprise Blindaje Total",
        emoji="🛡️",
        price_usd=950.0,
        description="Protección y automatización a medida para redes de comunidades.",
        features=["Despliegue dedicado", "Soporte prioritario 24/7", "Todo lo del nivel 3"],
    ),
}

GATEWAYS: Tuple[str, ...] = ("stars", "paypal", "binance", "global66", "payoneer")
MANUAL_GATEWAYS: Tuple[str, ...] = ("global66", "payoneer")


class PaymentError(Exception):
    """Error controlado de una pasarela de pago."""

    def __init__(self, message: str, gateway: str = "", details: Optional[Any] = None) -> None:
        super().__init__(message)
        self.message = message
        self.gateway = gateway
        self.details = details


def get_plan(plan_id: str) -> Plan:
    plan = PLANS.get(plan_id)
    if plan is None:
        raise PaymentError(f"Plan desconocido: {plan_id}")
    return plan


def sorted_plans() -> List[Plan]:
    return sorted(PLANS.values(), key=lambda p: p.price_usd)


def gateway_availability() -> Dict[str, bool]:
    return {
        "stars": True,
        "paypal": settings.paypal_enabled,
        "binance": settings.binance_enabled,
        "global66": bool(settings.GLOBAL66_ACCOUNT),
        "payoneer": bool(settings.PAYONEER_EMAIL),
    }


# ---------------------------------------------------------------------------
# Servicio de pasarelas
# ---------------------------------------------------------------------------
class PaymentService:
    BINANCE_BASE_URL = "https://bpay.binanceapi.com"

    def __init__(self) -> None:
        self._client: Optional[httpx.AsyncClient] = None
        self._paypal_token: Optional[str] = None
        self._paypal_token_expires_at: float = 0.0
        self._token_lock = asyncio.Lock()

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
        return self._client

    async def close(self) -> None:
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()

    # --- Telegram Stars --------------------------------------------------------
    @staticmethod
    def usd_to_stars(amount_usd: float) -> int:
        return max(1, int(round(amount_usd * settings.STARS_PER_USD)))

    @staticmethod
    def build_invoice_payload(plan_id: str, transaction_id: str) -> str:
        return f"ab:{plan_id}:{transaction_id}"

    @staticmethod
    def parse_invoice_payload(payload: str) -> Optional[Tuple[str, str]]:
        parts = payload.split(":")
        if len(parts) != 3 or parts[0] != "ab" or parts[1] not in PLANS:
            return None
        return parts[1], parts[2]

    def _stars_invoice_kwargs(self, plan: Plan, transaction_id: str) -> Dict[str, Any]:
        return {
            "title": plan.name[:32],
            "description": f"{plan.description} — {', '.join(plan.features)}"[:255],
            "payload": self.build_invoice_payload(plan.id, transaction_id),
            "provider_token": "",
            "currency": "XTR",
            "prices": [LabeledPrice(label=plan.name[:32], amount=self.usd_to_stars(plan.price_usd))],
        }

    async def create_stars_invoice_link(self, bot: Bot, plan: Plan, transaction_id: str) -> str:
        try:
            return await bot.create_invoice_link(**self._stars_invoice_kwargs(plan, transaction_id))
        except TelegramAPIError as exc:
            raise PaymentError("No se pudo crear la factura en Stars", "stars", str(exc)) from exc

    async def send_stars_invoice(self, bot: Bot, chat_id: int, plan: Plan, transaction_id: str) -> None:
        try:
            await bot.send_invoice(chat_id=chat_id, **self._stars_invoice_kwargs(plan, transaction_id))
        except TelegramAPIError as exc:
            raise PaymentError("No se pudo enviar la factura en Stars", "stars", str(exc)) from exc

    # --- PayPal ----------------------------------------------------------------
    async def _paypal_access_token(self, force_refresh: bool = False) -> str:
        if not settings.paypal_enabled:
            raise PaymentError("PayPal no está configurado en el servidor", "paypal")
        async with self._token_lock:
            if (
                not force_refresh
                and self._paypal_token
                and time.monotonic() < self._paypal_token_expires_at - 60
            ):
                return self._paypal_token
            try:
                response = await self.client.post(
                    f"{settings.paypal_base_url}/v1/oauth2/token",
                    data={"grant_type": "client_credentials"},
                    auth=(settings.PAYPAL_CLIENT_ID, settings.PAYPAL_CLIENT_SECRET),
                    headers={"Accept": "application/json"},
                )
            except httpx.HTTPError as exc:
                raise PaymentError("PayPal no responde", "paypal", str(exc)) from exc
            if response.status_code != 200:
                raise PaymentError("Credenciales de PayPal rechazadas", "paypal", response.text)
            payload = response.json()
            self._paypal_token = str(payload["access_token"])
            self._paypal_token_expires_at = time.monotonic() + float(payload.get("expires_in", 3000))
            return self._paypal_token

    async def _paypal_request(
        self,
        method: str,
        path: str,
        json_body: Optional[Dict[str, Any]] = None,
        extra_headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        for attempt in range(2):
            token = await self._paypal_access_token(force_refresh=attempt > 0)
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                **(extra_headers or {}),
            }
            try:
                response = await self.client.request(
                    method, f"{settings.paypal_base_url}{path}", json=json_body, headers=headers
                )
            except httpx.HTTPError as exc:
                raise PaymentError("Error de red con PayPal", "paypal", str(exc)) from exc
            if response.status_code == 401 and attempt == 0:
                continue
            if response.status_code >= 400:
                try:
                    details: Any = response.json()
                except ValueError:
                    details = response.text
                raise PaymentError(f"PayPal respondió {response.status_code}", "paypal", details)
            return response.json() if response.content else {}
        raise PaymentError("PayPal rechazó la autenticación", "paypal")

    async def create_paypal_order(
        self,
        amount: float,
        currency: str,
        plan_name: str,
        return_url: str,
        cancel_url: str,
        custom_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        purchase_unit: Dict[str, Any] = {
            "reference_id": (custom_id or "alpha-bunker")[:256],
            "description": plan_name[:127],
            "amount": {"currency_code": currency.upper(), "value": f"{amount:.2f}"},
        }
        if custom_id:
            purchase_unit["custom_id"] = custom_id[:127]
        body = {
            "intent": "CAPTURE",
            "purchase_units": [purchase_unit],
            "payment_source": {
                "paypal": {
                    "experience_context": {
                        "brand_name": "Alpha Bunker",
                        "user_action": "PAY_NOW",
                        "shipping_preference": "NO_SHIPPING",
                        "return_url": return_url,
                        "cancel_url": cancel_url,
                    }
                }
            },
        }
        data = await self._paypal_request(
            "POST",
            "/v2/checkout/orders",
            body,
            {"PayPal-Request-Id": custom_id or uuid4().hex},
        )
        approve_url = next(
            (link["href"] for link in data.get("links", []) if link.get("rel") in ("payer-action", "approve")),
            None,
        )
        if not approve_url:
            raise PaymentError("PayPal no devolvió URL de aprobación", "paypal", data)
        return {"order_id": data["id"], "status": data.get("status"), "approve_url": approve_url}

    @staticmethod
    def _summarize_paypal_order(data: Dict[str, Any]) -> Dict[str, Any]:
        unit = (data.get("purchase_units") or [{}])[0]
        captures = (unit.get("payments") or {}).get("captures") or []
        capture = captures[0] if captures else {}
        return {
            "order_id": data.get("id"),
            "status": data.get("status"),
            "custom_id": unit.get("custom_id") or capture.get("custom_id"),
            "capture_id": capture.get("id"),
            "capture_status": capture.get("status"),
            "amount": (capture.get("amount") or unit.get("amount") or {}).get("value"),
        }

    async def get_paypal_order(self, order_id: str) -> Dict[str, Any]:
        data = await self._paypal_request("GET", f"/v2/checkout/orders/{order_id}")
        return self._summarize_paypal_order(data)

    async def capture_paypal_order(self, order_id: str) -> Dict[str, Any]:
        try:
            data = await self._paypal_request(
                "POST",
                f"/v2/checkout/orders/{order_id}/capture",
                {},
                {"Prefer": "return=representation", "PayPal-Request-Id": f"cap-{order_id}"},
            )
        except PaymentError as exc:
            if "ORDER_ALREADY_CAPTURED" in json.dumps(exc.details, default=str):
                return await self.get_paypal_order(order_id)
            raise
        return self._summarize_paypal_order(data)

    async def verify_paypal_webhook(self, headers: Mapping[str, str], event: Dict[str, Any]) -> bool:
        if not settings.PAYPAL_WEBHOOK_ID:
            return False
        body = {
            "auth_algo": headers.get("paypal-auth-algo"),
            "cert_url": headers.get("paypal-cert-url"),
            "transmission_id": headers.get("paypal-transmission-id"),
            "transmission_sig": headers.get("paypal-transmission-sig"),
            "transmission_time": headers.get("paypal-transmission-time"),
            "webhook_id": settings.PAYPAL_WEBHOOK_ID,
            "webhook_event": event,
        }
        if not all(body.values()):
            return False
        result = await self._paypal_request("POST", "/v1/notifications/verify-webhook-signature", body)
        return result.get("verification_status") == "SUCCESS"

    # --- Binance Pay -----------------------------------------------------------
    @staticmethod
    def _binance_signature(timestamp: str, nonce: str, body: str, secret: str) -> str:
        payload = f"{timestamp}\n{nonce}\n{body}\n"
        return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha512).hexdigest().upper()

    async def _binance_post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        if not settings.binance_enabled:
            raise PaymentError("Binance Pay no está configurado en el servidor", "binance")
        raw_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        timestamp = str(int(time.time() * 1000))
        nonce = secrets.token_hex(16)  # 32 caracteres alfanuméricos
        headers = {
            "Content-Type": "application/json",
            "BinancePay-Timestamp": timestamp,
            "BinancePay-Nonce": nonce,
            "BinancePay-Certificate-SN": settings.BINANCE_API_KEY,
            "BinancePay-Signature": self._binance_signature(
                timestamp, nonce, raw_body, settings.BINANCE_API_SECRET
            ),
        }
        try:
            response = await self.client.post(
                f"{self.BINANCE_BASE_URL}{path}", content=raw_body.encode("utf-8"), headers=headers
            )
        except httpx.HTTPError as exc:
            raise PaymentError("Error de red con Binance Pay", "binance", str(exc)) from exc
        try:
            data: Dict[str, Any] = response.json()
        except ValueError as exc:
            raise PaymentError("Respuesta inválida de Binance Pay", "binance", response.text) from exc
        if response.status_code >= 400 or data.get("status") != "SUCCESS":
            raise PaymentError(
                f"Binance Pay rechazó la operación: {data.get('errorMessage', 'error desconocido')}",
                "binance",
                data,
            )
        return data.get("data") or {}

    async def create_binance_order(
        self,
        amount: float,
        currency: str,
        plan_name: str,
        merchant_trade_no: Optional[str] = None,
        return_url: Optional[str] = None,
        reference_goods_id: str = "alpha-bunker",
    ) -> Dict[str, Any]:
        trade_no = "".join(ch for ch in (merchant_trade_no or uuid4().hex) if ch.isalnum())[:32]
        body: Dict[str, Any] = {
            "env": {"terminalType": "WEB"},
            "merchantTradeNo": trade_no,
            "orderAmount": round(float(amount), 2),
            "currency": currency.upper(),
            "goods": {
                "goodsType": "02",
                "goodsCategory": "Z000",
                "referenceGoodsId": reference_goods_id[:64],
                "goodsName": plan_name[:256],
            },
        }
        if return_url:
            body["returnUrl"] = return_url
        data = await self._binance_post("/binancepay/openapi/v2/order", body)
        return {
            "merchant_trade_no": trade_no,
            "prepay_id": data.get("prepayId"),
            "checkout_url": data.get("checkoutUrl"),
            "universal_url": data.get("universalUrl"),
            "qr_content": data.get("qrContent"),
            "expire_time": data.get("expireTime"),
        }

    async def query_binance_order(self, merchant_trade_no: str) -> Dict[str, Any]:
        return await self._binance_post(
            "/binancepay/openapi/v2/order/query", {"merchantTradeNo": merchant_trade_no}
        )


payment_service = PaymentService()


# ---------------------------------------------------------------------------
# Orquestación de checkout
# ---------------------------------------------------------------------------
def _manual_instructions(gateway: str, plan: Plan, transaction_id: str) -> str:
    reference = transaction_id[:8].upper()
    if gateway == "global66":
        destination = settings.GLOBAL66_ACCOUNT
        label = "Global66"
    else:
        destination = settings.PAYONEER_EMAIL
        label = "Payoneer"
    return (
        f"Envía {plan.price_usd:.2f} USD por {label} a {destination} "
        f"indicando la referencia AB-{reference}. Un administrador confirmará tu pago "
        f"y recibirás el acceso en el bot."
    )


async def create_checkout(
    bot: Bot,
    user_id: int,
    plan_id: str,
    gateway: str,
    send_invoice_to: Optional[int] = None,
) -> Dict[str, Any]:
    """Crea la transacción y la orden en la pasarela indicada."""
    plan = get_plan(plan_id)
    if gateway not in GATEWAYS:
        raise PaymentError(f"Pasarela no soportada: {gateway}", gateway)
    if not gateway_availability()[gateway]:
        raise PaymentError("Esta pasarela no está habilitada todavía", gateway)

    if gateway == "stars":
        amount: float = float(payment_service.usd_to_stars(plan.price_usd))
        currency = "XTR"
    elif gateway == "binance":
        amount, currency = plan.price_usd, "USDT"
    else:
        amount, currency = plan.price_usd, "USD"

    gateway_name: GatewayName = gateway  # type: ignore[assignment]
    transaction = await db.save_transaction(
        user_id=user_id,
        plan_id=plan.id,
        plan_name=plan.name,
        amount=amount,
        currency=currency,
        gateway=gateway_name,
    )
    result: Dict[str, Any] = {
        "transaction_id": transaction.id,
        "gateway": gateway,
        "plan": plan.model_dump(),
        "amount": amount,
        "currency": currency,
    }

    try:
        if gateway == "stars":
            if send_invoice_to is not None:
                await payment_service.send_stars_invoice(bot, send_invoice_to, plan, transaction.id)
                result["invoice_sent"] = True
            else:
                result["invoice_link"] = await payment_service.create_stars_invoice_link(
                    bot, plan, transaction.id
                )
        elif gateway == "paypal":
            order = await payment_service.create_paypal_order(
                amount=plan.price_usd,
                currency="USD",
                plan_name=f"Alpha Bunker - {plan.name}",
                return_url=f"{settings.public_base_url}/api/v1/payments/paypal/return",
                cancel_url=f"{settings.public_base_url}/api/v1/payments/paypal/cancel",
                custom_id=transaction.id,
            )
            await db.set_transaction_external_id(transaction.id, order["order_id"])
            result["payment_url"] = order["approve_url"]
            result["external_id"] = order["order_id"]
        elif gateway == "binance":
            order = await payment_service.create_binance_order(
                amount=plan.price_usd,
                currency="USDT",
                plan_name=f"Alpha Bunker - {plan.name}",
                merchant_trade_no=transaction.id,
                return_url=settings.DASHBOARD_URL,
                reference_goods_id=plan.id,
            )
            await db.set_transaction_external_id(transaction.id, order["merchant_trade_no"])
            result["payment_url"] = order["universal_url"] or order["checkout_url"]
            result["checkout_url"] = order["checkout_url"]
            result["external_id"] = order["merchant_trade_no"]
        else:
            instructions = _manual_instructions(gateway, plan, transaction.id)
            result["instructions"] = instructions
            await notify_admin(
                bot,
                f"🧾 <b>Pago manual pendiente</b>\n"
                f"Pasarela: {gateway}\nPlan: {escape(plan.name)} (${plan.price_usd:.0f})\n"
                f"Usuario: <code>{user_id}</code>\nTransacción: <code>{transaction.id}</code>",
            )
    except PaymentError:
        await db.update_transaction_status(transaction.id, "failed")
        raise

    return result


async def notify_admin(bot: Bot, text: str) -> None:
    try:
        await bot.send_message(settings.ADMIN_TELEGRAM_ID, text)
    except TelegramAPIError as exc:
        logger.warning("No se pudo notificar al administrador: %s", exc)


async def fulfill_transaction(
    bot: Bot,
    transaction_id: str,
    external_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Transaction]:
    """Marca la transacción como completada (idempotente) y entrega el acceso VIP."""
    transaction = await db.update_transaction_status(
        transaction_id,
        "completed",
        external_id=external_id,
        metadata=metadata,
        expected_status="pending",
    )
    if transaction is None:
        return await db.get_transaction(transaction_id)

    access_text = ""
    if settings.VIP_CHAT_ID:
        try:
            invite = await bot.create_chat_invite_link(
                chat_id=settings.VIP_CHAT_ID,
                name=f"AB-{transaction.id[:8]}",
                member_limit=1,
                expire_date=datetime.now(timezone.utc) + timedelta(days=7),
            )
            access_text = (
                f"\n\n🔑 Tu acceso VIP (un solo uso, válido 7 días):\n{invite.invite_link}"
            )
            await db.update_transaction_status(
                transaction.id, "completed", metadata={"invite_link": invite.invite_link}
            )
        except TelegramAPIError as exc:
            logger.error("No se pudo crear el enlace de invitación: %s", exc)
            access_text = "\n\nUn administrador te enviará el acceso en breve."

    try:
        await bot.send_message(
            transaction.user_id,
            f"✅ <b>Pago confirmado</b>\nPlan: <b>{escape(transaction.plan_name)}</b>\n"
            f"Transacción: <code>{transaction.id}</code>{access_text}",
        )
    except TelegramAPIError as exc:
        logger.warning("No se pudo avisar al usuario %s: %s", transaction.user_id, exc)

    await notify_admin(
        bot,
        f"💰 <b>Nuevo pago completado</b>\nPlan: {escape(transaction.plan_name)}\n"
        f"Monto: {transaction.amount:g} {transaction.currency} vía {transaction.gateway}\n"
        f"Usuario: <code>{transaction.user_id}</code>",
    )
    return transaction


async def verify_transaction(bot: Bot, transaction: Transaction) -> Transaction:
    """Consulta el estado en la pasarela (PayPal/Binance) y completa si procede."""
    if transaction.status != "pending" or not transaction.external_id:
        return transaction

    if transaction.gateway == "paypal":
        order = await payment_service.get_paypal_order(transaction.external_id)
        if order["status"] == "APPROVED":
            order = await payment_service.capture_paypal_order(transaction.external_id)
        if order["status"] == "COMPLETED":
            completed = await fulfill_transaction(
                bot, transaction.id, metadata={"paypal_capture_id": order.get("capture_id")}
            )
            return completed or transaction
    elif transaction.gateway == "binance":
        data = await payment_service.query_binance_order(transaction.external_id)
        status = str(data.get("status", "")).upper()
        if status == "PAID":
            completed = await fulfill_transaction(
                bot, transaction.id, metadata={"binance_transaction_id": data.get("transactionId")}
            )
            return completed or transaction
        if status in ("CANCELED", "EXPIRED", "ERROR"):
            failed = await db.update_transaction_status(transaction.id, "failed", expected_status="pending")
            return failed or transaction
    return transaction
