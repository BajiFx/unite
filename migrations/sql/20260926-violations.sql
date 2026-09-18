-- ============================================================
--  VIOLATIONS & CLAIMS
--  Location: migrations/sql/20260926-violations.sql
--
--  Purpose:
--   Record every rule-breaking incident on the platform so a
--   super admin can review, warn, suspend, or dismiss it.
--
--   Two things share this one table because they are
--   structurally identical: a report with a reporter, a
--   subject, a description, and a resolution.
--
--     kind = 'violation'
--       Something a customer or a business did that breaks
--       the Terms and Conditions.
--
--     kind = 'claim'
--       A customer claiming a business did something to them,
--       or a business claiming a customer did something to it.
--
--   The difference is only in how the admin reads the row. The
--   storage, the workflow, and the audit trail are the same.
--
--  Design notes:
--   - subject_type is 'customer' or 'business'.
--   - reported_by_type is 'admin', 'customer', 'business',
--     or 'system'. The 'system' value is a placeholder for
--     future automatic detection; nothing writes it today.
--   - severity is 'low' | 'medium' | 'high' | 'critical'.
--   - status is 'pending' | 'under_review' | 'resolved' |
--     'dismissed' | 'escalated'.
--   - action_taken is 'none' | 'warned' | 'suspended' |
--     'scheduled_deletion' | 'deleted' | 'restored'.
--   - source_complaint_id links a violation back to the
--     admin_messages row it was escalated from, if any.
--   - Every statement is idempotent so the file can be
--     re-run safely.
-- ============================================================


-- ============================================================
--  1. THE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS violations (
    id                      SERIAL PRIMARY KEY,

    kind                    VARCHAR(20) NOT NULL DEFAULT 'violation'
        CHECK (kind IN ('violation', 'claim')),

    subject_type            VARCHAR(20) NOT NULL
        CHECK (subject_type IN ('customer', 'business')),

    subject_id              INTEGER NOT NULL,

    subject_label           VARCHAR(255),

    reported_by_type        VARCHAR(20) NOT NULL DEFAULT 'admin'
        CHECK (reported_by_type IN ('admin', 'customer', 'business', 'system')),

    reported_by_id          INTEGER,

    reporter_label          VARCHAR(255),

    category                VARCHAR(80),

    title                   VARCHAR(255) NOT NULL,

    description             TEXT,

    evidence_url            VARCHAR(500),

    related_order_id        INTEGER,

    related_business_id     INTEGER,

    severity                VARCHAR(20) NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'under_review', 'resolved', 'dismissed', 'escalated')),

    action_taken            VARCHAR(30) NOT NULL DEFAULT 'none'
        CHECK (action_taken IN ('none', 'warned', 'suspended', 'scheduled_deletion', 'deleted', 'restored')),

    action_note             TEXT,

    resolved_by_admin_id    INTEGER,

    resolved_at             TIMESTAMP,

    source_complaint_id     INTEGER,

    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
--  2. IDEMPOTENT COLUMN GUARDS
--  In case an earlier draft created a narrower table, add any
--  missing columns without touching existing rows.
-- ============================================================

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS subject_label VARCHAR(255);

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS reporter_label VARCHAR(255);

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS category VARCHAR(80);

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS evidence_url VARCHAR(500);

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS related_order_id INTEGER;

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS related_business_id INTEGER;

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS action_note TEXT;

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS resolved_by_admin_id INTEGER;

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;

ALTER TABLE violations
    ADD COLUMN IF NOT EXISTS source_complaint_id INTEGER;


-- ============================================================
--  3. INDEXES
--  The hot queries are: "show me all pending", "show me all
--  for this customer", "show me all for this business", "show
--  me all claims". Each gets its own index.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_violations_subject
    ON violations (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_violations_status
    ON violations (status);

CREATE INDEX IF NOT EXISTS idx_violations_kind
    ON violations (kind);

CREATE INDEX IF NOT EXISTS idx_violations_severity
    ON violations (severity);

CREATE INDEX IF NOT EXISTS idx_violations_created
    ON violations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_violations_pending
    ON violations (created_at DESC)
    WHERE status IN ('pending', 'under_review');

CREATE INDEX IF NOT EXISTS idx_violations_source_complaint
    ON violations (source_complaint_id)
    WHERE source_complaint_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_violations_related_order
    ON violations (related_order_id)
    WHERE related_order_id IS NOT NULL;


-- ============================================================
--  4. AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_violations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_violations_updated_at ON violations;
CREATE TRIGGER trg_violations_updated_at
BEFORE UPDATE ON violations
FOR EACH ROW
EXECUTE FUNCTION set_violations_updated_at();


-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    table_exists     BOOLEAN;
    index_count      INTEGER;
    trigger_exists   BOOLEAN;
    check_count      INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'violations'
    ) INTO table_exists;

    SELECT COUNT(*) INTO index_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'violations';

    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_violations_updated_at'
    ) INTO trigger_exists;

    SELECT COUNT(*) INTO check_count
    FROM pg_constraint
    WHERE conrelid = 'violations'::regclass
      AND contype = 'c';

    RAISE NOTICE 'violations table exists:      %', table_exists;
    RAISE NOTICE 'violations indexes:           %', index_count;
    RAISE NOTICE 'violations updated_at trigger:%', trigger_exists;
    RAISE NOTICE 'violations check constraints: %', check_count;

    IF table_exists AND index_count >= 8 AND trigger_exists AND check_count >= 5 THEN
        RAISE NOTICE 'Violations schema is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the violations schema did not land. Please investigate.';
    END IF;
END $$;