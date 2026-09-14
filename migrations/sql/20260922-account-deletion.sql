-- ============================================================
--  SECTION 11 — ACCOUNT DELETION (CUSTOMER + BUSINESS)
--  Location: migrations/sql/20260922-account-deletion.sql
--
--  Purpose:
--   Adds the schema needed for the two-stage deletion flow
--   described in Section 11 of the fix plan:
--
--   11.A — Customer deletion
--     customers.deletion_scheduled_at   — when the grace
--                                          period ends
--     customers.deletion_reason         — why the customer
--                                          is leaving
--
--   11.B — Business deletion
--     businesses.deletion_scheduled_at  — when the grace
--                                          period ends
--     businesses.deletion_reason        — why the owner
--                                          is leaving
--     admin_users.is_active             — so a deactivated
--                                          business admin
--                                          cannot log in
--                                          during the grace
--                                          period
--
--  Design notes:
--   - No row is ever hard-deleted. Orders, chats, payments,
--     and returns all reference customers and businesses by
--     foreign key, so the rows must survive. Deletion means
--     "anonymize and deactivate", not "DELETE FROM".
--   - The columns are nullable. NULL means "no deletion is
--     scheduled". This lets the login handlers use a single
--     check — `IS NOT NULL` — to auto-cancel.
--   - deletion_reason is VARCHAR(100) because the UI only
--     offers a fixed set of short reasons.
--   - All statements are idempotent. The file can be re-run
--     safely; every ADD COLUMN uses IF NOT EXISTS.
--   - The partial indexes keep the cron job fast without
--     paying the cost of indexing the vast majority of rows
--     that will never be scheduled for deletion.
--
--  Verification is at the bottom of the file. It prints a
--  short report so the operator can confirm the columns and
--  indexes landed without having to open a psql session.
-- ============================================================


-- ============================================================
--  1. CUSTOMERS — scheduled-deletion columns
-- ============================================================

-- When the 30-day customer grace period ends.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMP;

-- Why the customer asked to leave. Short fixed string, so
-- VARCHAR(100) is plenty. NULL when no deletion is pending.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(100);


-- ============================================================
--  2. BUSINESSES — scheduled-deletion columns
-- ============================================================

-- When the 60-day business grace period ends.
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMP;

-- Why the business owner asked to leave.
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS deletion_reason VARCHAR(100);


-- ============================================================
--  3. ADMIN USERS — activation flag
--
--  A business admin whose business is pending deletion must
--  not be able to log in during the grace period. Rather than
--  overloading business_id = NULL (which is already used for
--  "no business assigned yet"), we add an explicit flag.
--
--  Existing rows default to TRUE so nothing changes for
--  accounts that are not being deleted.
-- ============================================================

ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;


-- ============================================================
--  4. PARTIAL INDEXES FOR THE FINALIZATION CRON
--
--  The daily cron job runs two queries:
--    SELECT id FROM customers
--     WHERE deletion_scheduled_at IS NOT NULL
--       AND deletion_scheduled_at < NOW();
--    SELECT id FROM businesses
--     WHERE deletion_scheduled_at IS NOT NULL
--       AND deletion_scheduled_at < NOW();
--
--  A partial index on the non-null subset keeps both lookups
--  fast even as the tables grow, and costs almost nothing to
--  maintain because the vast majority of rows have NULL in
--  that column.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_customers_deletion_scheduled
    ON customers (deletion_scheduled_at)
    WHERE deletion_scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_businesses_deletion_scheduled
    ON businesses (deletion_scheduled_at)
    WHERE deletion_scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_users_is_active
    ON admin_users (is_active);


-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    has_customer_sched   BOOLEAN;
    has_customer_reason  BOOLEAN;
    has_business_sched   BOOLEAN;
    has_business_reason  BOOLEAN;
    has_admin_active     BOOLEAN;
    idx_customer         BOOLEAN;
    idx_business         BOOLEAN;
    idx_admin_active     BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'deletion_scheduled_at'
    ) INTO has_customer_sched;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'deletion_reason'
    ) INTO has_customer_reason;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'businesses' AND column_name = 'deletion_scheduled_at'
    ) INTO has_business_sched;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'businesses' AND column_name = 'deletion_reason'
    ) INTO has_business_reason;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'admin_users' AND column_name = 'is_active'
    ) INTO has_admin_active;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_customers_deletion_scheduled'
    ) INTO idx_customer;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_businesses_deletion_scheduled'
    ) INTO idx_business;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'idx_admin_users_is_active'
    ) INTO idx_admin_active;

    RAISE NOTICE 'customers.deletion_scheduled_at   → %', has_customer_sched;
    RAISE NOTICE 'customers.deletion_reason         → %', has_customer_reason;
    RAISE NOTICE 'businesses.deletion_scheduled_at  → %', has_business_sched;
    RAISE NOTICE 'businesses.deletion_reason        → %', has_business_reason;
    RAISE NOTICE 'admin_users.is_active             → %', has_admin_active;
    RAISE NOTICE 'idx_customers_deletion_scheduled  → %', idx_customer;
    RAISE NOTICE 'idx_businesses_deletion_scheduled → %', idx_business;
    RAISE NOTICE 'idx_admin_users_is_active         → %', idx_admin_active;

    IF has_customer_sched AND has_customer_reason
       AND has_business_sched AND has_business_reason
       AND has_admin_active
       AND idx_customer AND idx_business AND idx_admin_active
    THEN
        RAISE NOTICE 'Section 11 schema is ready.';
    ELSE
        RAISE NOTICE 'One or more Section 11 changes did not land. Please investigate.';
    END IF;
END $$;