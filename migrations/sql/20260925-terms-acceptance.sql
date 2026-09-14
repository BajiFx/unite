-- ============================================================
--  SECTION 22 — TERMS AND PRIVACY ACCEPTANCE
--  Location: migrations/sql/20260925-terms-acceptance.sql
--
--  Purpose:
--   Record, for every customer and every business admin, the
--   exact moment at which they accepted the Terms and Conditions
--   and the Privacy Policy, plus the technical context of that
--   acceptance (version, IP, user-agent).
--
--  Why a table and not two columns on the users:
--   The welcome splash accepts, and the registration accepts, are
--   two different events with two different contexts. A row per
--   acceptance captures both without overwriting. It also gives
--   us the same kind of audit trail that admin_logs already
--   provides for admin actions.
--
--  Notes:
--   - The user identifier is stored twice: an integer column for
--     the row id in customers or admin_users, and a text column
--     for the login identity (email or phone) at the time of
--     acceptance. The email/phone is kept even after the customer
--     anonymizes their account, so the acceptance record survives
--     the anonymisation described in Section 11.A of the fix plan.
--   - user_type is 'customer' or 'business_admin'. A guest who
--     only accepted the splash is not recorded here, because there
--     is no account yet. Guests are covered by the cookie the
--     splash already sets.
--   - The version column lets us match an acceptance to the exact
--     wording that was live at the time. When the Terms change,
--     the version string in terms.html changes with it.
--   - All statements are idempotent. The file can be re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS terms_acceptances (
    id              SERIAL PRIMARY KEY,

    user_type       VARCHAR(20) NOT NULL
        CHECK (user_type IN ('customer', 'business_admin')),

    user_id         INTEGER,
    user_identity   VARCHAR(255),

    terms_version   VARCHAR(20) NOT NULL,
    privacy_version VARCHAR(20) NOT NULL,

    accepted_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    ip_address      VARCHAR(45),
    user_agent      TEXT,

    context         VARCHAR(50) DEFAULT 'registration',
    notes           TEXT
);

-- Fast lookup for "show me every acceptance for this user".
CREATE INDEX IF NOT EXISTS idx_terms_acceptances_user
    ON terms_acceptances (user_type, user_id);

-- Fast lookup for "show me every acceptance of version X".
CREATE INDEX IF NOT EXISTS idx_terms_acceptances_version
    ON terms_acceptances (terms_version, privacy_version);

-- Recent-first pagination on the admin audit screen.
CREATE INDEX IF NOT EXISTS idx_terms_acceptances_accepted_at
    ON terms_acceptances (accepted_at DESC);

-- Verify.
DO $$
DECLARE
    table_exists BOOLEAN;
    index_count  INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'terms_acceptances'
    ) INTO table_exists;

    SELECT COUNT(*) INTO index_count
    FROM pg_indexes
    WHERE tablename = 'terms_acceptances';

    RAISE NOTICE 'terms_acceptances exists: %', table_exists;
    RAISE NOTICE 'terms_acceptances indexes: %', index_count;

    IF table_exists AND index_count >= 3 THEN
        RAISE NOTICE 'Section 22 acceptance table is ready.';
    ELSE
        RAISE NOTICE 'Section 22 acceptance table is missing or incomplete.';
    END IF;
END $$;