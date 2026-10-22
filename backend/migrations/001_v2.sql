-- =====================================================================
-- 001_v2.sql — Migración ÚNICA de la v2 (ejecutar UNA vez, fuera de la app)
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_v2.sql
-- Sustituye a ensure_user_schema / ensure_chat_schema / ensure_db_schema,
-- que ejecutaban ALTER/CREATE en cada request (bloqueo ACCESS EXCLUSIVE).
-- Recomendado: incorporarla como revisión de Alembic.
-- =====================================================================
BEGIN;

-- ---------- Columnas heredadas que antes se creaban "en caliente" ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_live_video BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS warnings_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_referral_discount BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS videocall_price_alpha INTEGER DEFAULT 0;

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_id BIGINT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT FALSE;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS room_id VARCHAR(50);
CREATE INDEX IF NOT EXISTS ix_chat_messages_room_created ON chat_messages (room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_chat_messages_dm ON chat_messages (user_id, recipient_id, created_at DESC);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS room_id VARCHAR(50);

CREATE TABLE IF NOT EXISTS video_rooms (
    id SERIAL PRIMARY KEY,
    room_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    description VARCHAR(255),
    host_id BIGINT,
    min_access_level INTEGER DEFAULT 0,
    min_broadcast_level INTEGER DEFAULT 1,
    is_private BOOLEAN DEFAULT FALSE,
    price_alpha INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Enlace al Video Chat nativo del grupo de Telegram asociado a la sala (modo TMA).
ALTER TABLE video_rooms ADD COLUMN IF NOT EXISTS telegram_videochat_link TEXT;

CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    follower_id BIGINT NOT NULL,
    following_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_visits (
    id SERIAL PRIMARY KEY,
    visit_date DATE UNIQUE NOT NULL,
    visits_count INT DEFAULT 0
);

-- ---------- Integridad: duplicados imposibles ----------
-- Si alguno falla, primero deduplica (consultas al final del archivo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_follows_pair ON follows (follower_id, following_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_unlocked_posts_pair ON unlocked_posts (user_id, post_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallets_user ON wallets (user_id);

-- Saldo nunca negativo. NOT VALID: no bloquea si hay filas antiguas negativas;
-- corrígelas y ejecuta: ALTER TABLE wallets VALIDATE CONSTRAINT ck_wallet_nonnegative;
DO $$ BEGIN
    ALTER TABLE wallets ADD CONSTRAINT ck_wallet_nonnegative CHECK (alpha_balance >= 0) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- IDs de cuentas Standalone ----------
-- Rango [2^52, 2^53): disjunto de los IDs de Telegram (< 2^52 según la Bot API)
-- y representable exactamente como Number en JavaScript (<= 2^53-1).
-- El esquema anterior ("99" + 6 dígitos aleatorios) colisionaba con IDs reales
-- de Telegram y era adivinable.
CREATE SEQUENCE IF NOT EXISTS standalone_user_id_seq
    START WITH 4503599627370496 MINVALUE 4503599627370496 MAXVALUE 9007199254740991 NO CYCLE;

-- ---------- Identidad y sesiones ----------
CREATE TABLE IF NOT EXISTS auth_identities (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    provider VARCHAR(16) NOT NULL,
    provider_uid VARCHAR(255) NOT NULL,
    secret_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_identity_provider_uid UNIQUE (provider, provider_uid),
    CONSTRAINT uq_identity_user_provider UNIQUE (user_id, provider)
);
CREATE INDEX IF NOT EXISTS ix_auth_identities_user ON auth_identities (user_id);

-- Backfill: los usuarios TMA existentes usan su Telegram ID como user_id.
-- Excluye los IDs falsos "99xxxxxx" generados por el front Standalone antiguo
-- SOLO si sabes distinguirlos; revisa manualmente antes de ejecutar en prod.
INSERT INTO auth_identities (user_id, provider, provider_uid)
SELECT u.user_id, 'telegram', u.user_id::text
FROM users u
WHERE u.user_id > 0 AND u.user_id < 4503599627370496
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    family_id VARCHAR(32) NOT NULL,
    auth_mode VARCHAR(16) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    user_agent VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_refresh_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS ix_refresh_family ON refresh_tokens (family_id);

CREATE TABLE IF NOT EXISTS telegram_link_nonces (
    nonce_hash VARCHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
);

-- ---------- Pagos ----------
CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL,
    package_slug VARCHAR(32) NOT NULL,
    provider VARCHAR(16) NOT NULL,
    currency VARCHAR(8) NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    alpha_amount INTEGER NOT NULL,
    discount_applied BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(16) NOT NULL DEFAULT 'created',
    provider_ref VARCHAR(255) UNIQUE,
    payer_telegram_id BIGINT,
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_orders_user ON payment_orders (user_id);
CREATE INDEX IF NOT EXISTS ix_orders_status_provider ON payment_orders (status, provider);

CREATE TABLE IF NOT EXISTS stars_payments (
    telegram_payment_charge_id VARCHAR(255) PRIMARY KEY,
    order_id UUID NOT NULL UNIQUE REFERENCES payment_orders(id),
    payer_telegram_id BIGINT NOT NULL,
    total_amount INTEGER NOT NULL,
    raw JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_processed_updates (
    update_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Ledger inmutable ----------
CREATE TABLE IF NOT EXISTS ledger_entries (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    delta BIGINT NOT NULL CHECK (delta <> 0),
    balance_after BIGINT NOT NULL,
    entry_type VARCHAR(32) NOT NULL,
    counterparty_id BIGINT,
    reference VARCHAR(128),
    idempotency_key VARCHAR(160) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ledger_user_created ON ledger_entries (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION ledger_block_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger_entries es append-only (% bloqueado)', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_immutable ON ledger_entries;
CREATE TRIGGER trg_ledger_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION ledger_block_mutation();

-- ---------- Membresías VIP ----------
CREATE TABLE IF NOT EXISTS memberships (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    tier_slug VARCHAR(32) NOT NULL,
    level INTEGER NOT NULL,
    chat_id BIGINT,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    invite_link TEXT,
    invite_link_expires_at TIMESTAMPTZ,
    invite_attempts INTEGER NOT NULL DEFAULT 0,
    last_order_id UUID,
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_membership_user_tier UNIQUE (user_id, tier_slug)
);
CREATE INDEX IF NOT EXISTS ix_membership_status_expires ON memberships (status, expires_at);

-- ---------- KYC ----------
CREATE TABLE IF NOT EXISTS kyc_submissions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    legal_name VARCHAR(200) NOT NULL,
    document_key VARCHAR(512) NOT NULL,
    selfie_key VARCHAR(512) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    reviewer_id BIGINT,
    review_note TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_kyc_user ON kyc_submissions (user_id);
CREATE INDEX IF NOT EXISTS ix_kyc_status ON kyc_submissions (status);

COMMIT;

-- ---------- Consultas de diagnóstico previas (si fallan los UNIQUE) ----------
-- SELECT user_id, count(*) FROM wallets GROUP BY 1 HAVING count(*) > 1;
-- SELECT follower_id, following_id, count(*) FROM follows GROUP BY 1,2 HAVING count(*) > 1;
-- SELECT user_id, post_id, count(*) FROM unlocked_posts GROUP BY 1,2 HAVING count(*) > 1;
-- SELECT user_id, alpha_balance FROM wallets WHERE alpha_balance < 0;
