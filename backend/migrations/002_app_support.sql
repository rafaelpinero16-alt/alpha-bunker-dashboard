-- 002_app_support.sql — Soporte para el app.js v2 (ejecutar después de 001_v2.sql)
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ton_address VARCHAR(80);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE posts ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0;

-- Likes por usuario (v1: contador sin dueño, inflable con un bucle)
CREATE TABLE IF NOT EXISTS post_likes (
    user_id BIGINT NOT NULL,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS ix_post_likes_post ON post_likes (post_id);
-- Los likes v1 no tienen dueño: se recalculan desde cero.
UPDATE posts SET likes_count = 0;

-- Retiros: el saldo queda retenido en el ledger (payout_hold) hasta que admin pague o rechace.
CREATE TABLE IF NOT EXISTS payout_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    amount_alpha BIGINT NOT NULL CHECK (amount_alpha > 0),
    method VARCHAR(20) NOT NULL,
    destination VARCHAR(200) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',   -- pending|paid|rejected
    admin_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_payout_status ON payout_requests (status, created_at);

-- Ajusta el nombre si tu modelo TipMenuSlot usa otra tabla (__tablename__).
DO $$ BEGIN
    IF to_regclass('tip_menu_slots') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tip_menu_slot ON tip_menu_slots (creator_id, slot_number);
    END IF;
END $$;

COMMIT;
