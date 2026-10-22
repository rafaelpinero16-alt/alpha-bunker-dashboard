"""
database/models_v2.py — Tablas nuevas de la v2. Se crean con migrations/001_v2.sql
(NUNCA con CREATE/ALTER dentro de una ruta).

Ajusta el import de Base si en tu proyecto vive en database/models.py.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Column, DateTime, ForeignKey, Index,
    Integer, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID

from database.db import Base  # noqa: ajusta si tu Base está en otro módulo


class AuthIdentity(Base):
    """Vincula proveedores de identidad con users.user_id.
    provider: 'telegram' | 'password' (email) | 'phone' (futuro)."""
    __tablename__ = "auth_identities"
    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    provider = Column(String(16), nullable=False)
    provider_uid = Column(String(255), nullable=False)
    secret_hash = Column(Text, nullable=True)  # argon2 para 'password'
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    __table_args__ = (
        UniqueConstraint("provider", "provider_uid", name="uq_identity_provider_uid"),
        UniqueConstraint("user_id", "provider", name="uq_identity_user_provider"),
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True)
    family_id = Column(String(32), nullable=False, index=True)
    auth_mode = Column(String(16), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    user_agent = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class TelegramLinkNonce(Base):
    """Deep link t.me/<bot>?start=link_<nonce> para vincular Telegram a una cuenta Standalone."""
    __tablename__ = "telegram_link_nonces"
    nonce_hash = Column(String(64), primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)


class PaymentOrder(Base):
    """Orden creada por el SERVIDOR antes de cobrar. El payload de la factura es su UUID."""
    __tablename__ = "payment_orders"
    id = Column(UUID(as_uuid=True), primary_key=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    package_slug = Column(String(32), nullable=False)
    provider = Column(String(16), nullable=False)          # 'stars' | 'ton'
    currency = Column(String(8), nullable=False)           # 'XTR' | 'TON'
    amount = Column(BigInteger, nullable=False)            # estrellas o nanoTON
    alpha_amount = Column(Integer, nullable=False)
    discount_applied = Column(Boolean, nullable=False, default=False)
    status = Column(String(16), nullable=False, default="created")  # created|paid|expired|refunded|failed
    provider_ref = Column(String(255), nullable=True, unique=True)  # charge_id o hash de tx TON
    payer_telegram_id = Column(BigInteger, nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    paid_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_order_amount_positive"),
        Index("ix_orders_status_provider", "status", "provider"),
    )


class StarsPayment(Base):
    """Registro inmutable de cada successful_payment. La UNIQUE sobre el charge_id
    es la barrera de idempotencia definitiva frente a reintentos del webhook."""
    __tablename__ = "stars_payments"
    telegram_payment_charge_id = Column(String(255), primary_key=True)
    order_id = Column(UUID(as_uuid=True), ForeignKey("payment_orders.id"), nullable=False, unique=True)
    payer_telegram_id = Column(BigInteger, nullable=False)
    total_amount = Column(Integer, nullable=False)
    raw = Column(JSONB, nullable=False)
    received_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class LedgerEntry(Base):
    """Libro mayor append-only de $ALPHA. Un trigger en BD prohíbe UPDATE/DELETE."""
    __tablename__ = "ledger_entries"
    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    delta = Column(BigInteger, nullable=False)
    balance_after = Column(BigInteger, nullable=False)
    entry_type = Column(String(32), nullable=False)
    counterparty_id = Column(BigInteger, nullable=True)
    reference = Column(String(128), nullable=True)
    idempotency_key = Column(String(160), nullable=True, unique=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    __table_args__ = (CheckConstraint("delta <> 0", name="ck_ledger_delta_nonzero"),)


class Membership(Base):
    __tablename__ = "memberships"
    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False)
    tier_slug = Column(String(32), nullable=False)
    level = Column(Integer, nullable=False)
    chat_id = Column(BigInteger, nullable=True)
    status = Column(String(16), nullable=False, default="active")  # active|expired|revoked
    starts_at = Column(DateTime(timezone=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=True)     # NULL = vitalicia
    invite_link = Column(Text, nullable=True)
    invite_link_expires_at = Column(DateTime(timezone=True), nullable=True)
    invite_attempts = Column(Integer, nullable=False, default=0)
    last_order_id = Column(UUID(as_uuid=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    __table_args__ = (
        UniqueConstraint("user_id", "tier_slug", name="uq_membership_user_tier"),
        Index("ix_membership_status_expires", "status", "expires_at"),
    )


class ProcessedUpdate(Base):
    """Deduplicación de update_id del webhook de Telegram."""
    __tablename__ = "telegram_processed_updates"
    update_id = Column(BigInteger, primary_key=True)
    processed_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class KycSubmission(Base):
    """Metadatos KYC. Los binarios viven en un bucket privado (S3/R2), NUNCA en Postgres."""
    __tablename__ = "kyc_submissions"
    id = Column(BigInteger, primary_key=True)
    user_id = Column(BigInteger, nullable=False, index=True)
    legal_name = Column(String(200), nullable=False)
    document_key = Column(String(512), nullable=False)
    selfie_key = Column(String(512), nullable=False)
    status = Column(String(16), nullable=False, default="pending")  # pending|verified|rejected
    reviewer_id = Column(BigInteger, nullable=True)
    review_note = Column(Text, nullable=True)
    submitted_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
