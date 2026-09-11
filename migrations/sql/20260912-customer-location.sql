-- ============================================================
--  SECTION G.3 — CUSTOMER LOCATION COLUMNS
--  Location: migrations/sql/20260912-customer-location.sql
--
--  Purpose:
--    Adds the fields the Section D customer-side features need:
--      D.2  — persist the customer's own GPS coordinates
--      D.10 — support turning location sharing off
--      D.12 — support refreshing the coordinates when the
--             customer has moved
--
--  All statements use IF NOT EXISTS so the file can be
--  re-run safely without breaking an already-migrated database.
--
--  Privacy (D.11):
--    These columns exist only so the server can compute
--    distance between the requesting customer and each business.
--    No endpoint in the codebase returns these values to a
--    business or to another customer.
-- ============================================================

-- ============================================================
--  1. ADD COLUMNS TO CUSTOMERS
-- ============================================================

-- Customer latitude / longitude, stored as strings to match the
-- convention already used by the businesses table.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS latitude VARCHAR(50);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS longitude VARCHAR(50);

-- Browser-reported accuracy in metres. Nullable.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS location_accuracy VARCHAR(20);

-- Whether the customer has an active location on file.
-- Defaults to FALSE so pre-existing rows stay opted out.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS location_activated BOOLEAN NOT NULL DEFAULT FALSE;

-- When the location was most recently activated or refreshed.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS location_activated_at TIMESTAMP;

-- How the coordinates were obtained: 'browser' | 'pin' | 'geocode'.
-- Matches the same convention used on the businesses table.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS location_source VARCHAR(20);

-- Row-level updated_at so profile edits and location saves can be
-- ordered consistently. The customers table currently only has
-- created_at and last_login_at, so we add it here.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
--  2. INDEXES
-- ============================================================

-- Small but useful when the marketplace filters by "customers
-- who have an activated location", and when the server checks a
-- single customer's activation state during a nearby search.
CREATE INDEX IF NOT EXISTS idx_customers_location_activated
    ON customers(location_activated);

-- ============================================================
--  3. BACKFILL SAFETY
--  Existing rows get location_activated = FALSE (already the
--  default) and updated_at = created_at so nothing is NULL.
-- ============================================================

UPDATE customers
SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
WHERE updated_at IS NULL;

-- ============================================================
--  4. VERIFY
-- ============================================================

DO $$
DECLARE
    activated_count INTEGER;
    total_count INTEGER;
    has_latitude BOOLEAN;
    has_longitude BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO total_count     FROM customers;
    SELECT COUNT(*) INTO activated_count FROM customers WHERE location_activated = TRUE;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'latitude'
    ) INTO has_latitude;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'longitude'
    ) INTO has_longitude;

    RAISE NOTICE 'customers total:        %', total_count;
    RAISE NOTICE 'location activated:     %', activated_count;
    RAISE NOTICE 'customers.latitude  →   %', has_latitude;
    RAISE NOTICE 'customers.longitude →   %', has_longitude;
END $$;