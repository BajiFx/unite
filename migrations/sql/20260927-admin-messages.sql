-- ============================================================
--  ADMIN MESSAGES (COMPLAINTS INBOX)
--  Location: migrations/sql/20260927-admin-messages.sql
--
--  Purpose:
--   Give customers and businesses a direct way to send a
--   message to the platform super admin. This is the inbox
--   where complaints, questions, and reports arrive, separate
--   from the structured `violations` table.
--
--   The two are linked: a message can be escalated into a
--   violation with one click, and the link is stored in
--   `escalated_to_violation_id`.
--
--  Design notes:
--   - sender_type is 'customer' or 'business'.
--   - sender_id is the customer_id for a customer, or the
--     business_id for a business. The same integer column is
--     used for both, and the interpretation depends on
--     sender_type.
--   - sender_label is the display name at the time the
--     message was sent, so the admin can still read the
--     message after an account is anonymised (Section 11.A
--     and 11.B).
--   - category is a short free-form string. The frontend
--     offers a fixed set of choices; the column itself is
--     not constrained so new categories can be added without
--     a migration.
--   - status is 'unread' | 'read' | 'replied' | 'escalated'
--     | 'closed'.
--   - v1 supports ONE admin reply per message. If threading
--     is needed later, a separate admin_message_replies
--     table can be added without changing this one.
--   - Every statement is idempotent so the file can be
--     re-run safely.
-- ============================================================


-- ============================================================
--  1. THE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_messages (
    id                          SERIAL PRIMARY KEY,

    sender_type                 VARCHAR(20) NOT NULL
        CHECK (sender_type IN ('customer', 'business')),

    sender_id                   INTEGER NOT NULL,

    sender_label                VARCHAR(255),

    subject                     VARCHAR(255) NOT NULL,

    body                        TEXT NOT NULL,

    category                    VARCHAR(80),

    related_order_id            INTEGER,

    related_business_id         INTEGER,

    attachment_url              VARCHAR(500),

    status                      VARCHAR(20) NOT NULL DEFAULT 'unread'
        CHECK (status IN ('unread', 'read', 'replied', 'escalated', 'closed')),

    admin_reply                 TEXT,

    replied_by_admin_id         INTEGER,

    replied_at                  TIMESTAMP,

    escalated_to_violation_id   INTEGER,

    created_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
--  2. IDEMPOTENT COLUMN GUARDS
-- ============================================================

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS sender_label VARCHAR(255);

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS category VARCHAR(80);

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS related_order_id INTEGER;

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS related_business_id INTEGER;

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS attachment_url VARCHAR(500);

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS admin_reply TEXT;

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS replied_by_admin_id INTEGER;

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;

ALTER TABLE admin_messages
    ADD COLUMN IF NOT EXISTS escalated_to_violation_id INTEGER;


-- ============================================================
--  3. INDEXES
--  The hot queries are: "unread count for the badge", "list
--  unread first", "list everything from one sender", "list
--  everything about one order". Each gets its own index.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_admin_messages_status
    ON admin_messages (status);

CREATE INDEX IF NOT EXISTS idx_admin_messages_sender
    ON admin_messages (sender_type, sender_id);

CREATE INDEX IF NOT EXISTS idx_admin_messages_created
    ON admin_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_messages_unread
    ON admin_messages (created_at DESC)
    WHERE status = 'unread';

CREATE INDEX IF NOT EXISTS idx_admin_messages_related_order
    ON admin_messages (related_order_id)
    WHERE related_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_messages_related_business
    ON admin_messages (related_business_id)
    WHERE related_business_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_messages_escalated
    ON admin_messages (escalated_to_violation_id)
    WHERE escalated_to_violation_id IS NOT NULL;


-- ============================================================
--  4. AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_admin_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_messages_updated_at ON admin_messages;
CREATE TRIGGER trg_admin_messages_updated_at
BEFORE UPDATE ON admin_messages
FOR EACH ROW
EXECUTE FUNCTION set_admin_messages_updated_at();


-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    table_exists    BOOLEAN;
    index_count     INTEGER;
    trigger_exists  BOOLEAN;
    check_count     INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'admin_messages'
    ) INTO table_exists;

    SELECT COUNT(*) INTO index_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'admin_messages';

    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_admin_messages_updated_at'
    ) INTO trigger_exists;

    SELECT COUNT(*) INTO check_count
    FROM pg_constraint
    WHERE conrelid = 'admin_messages'::regclass
      AND contype = 'c';

    RAISE NOTICE 'admin_messages table exists:        %', table_exists;
    RAISE NOTICE 'admin_messages indexes:             %', index_count;
    RAISE NOTICE 'admin_messages updated_at trigger:  %', trigger_exists;
    RAISE NOTICE 'admin_messages check constraints:   %', check_count;

    IF table_exists AND index_count >= 7 AND trigger_exists AND check_count >= 2 THEN
        RAISE NOTICE 'Admin messages schema is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the admin messages schema did not land. Please investigate.';
    END IF;
END $$;