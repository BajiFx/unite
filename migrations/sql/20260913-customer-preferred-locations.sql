-- ============================================================
--  SECTION E.2 / G.3 — CUSTOMER PREFERRED LOCATIONS
--  Location: migrations/sql/20260913-customer-preferred-locations.sql
--
--  Purpose:
--    Adds optional, customer-scoped "preferred area" fields. A
--    customer who chooses not to share GPS can still tell the
--    marketplace which area they want to shop in. These names are
--    used by the search handler (E.4) as a soft anchor when the
--    customer has no coordinates, so results are still ranked
--    sensibly without revealing the customer's location to any
--    business (D.11).
--
--    This file also closes the only remaining gap in Section G:
--    G.3 asks for customer latitude/longitude (already present
--    from 20260912-customer-location.sql) plus preferred location
--    names (added here).
--
--  Notes:
--   - All statements are idempotent. The file can be re-run
--     safely; every ADD COLUMN uses IF NOT EXISTS.
--   - No data is backfilled. Every existing customer starts with
--     NULL preferred names, which the search handler treats as
--     "no soft anchor" — identical to today's behaviour.
--   - These columns are never returned on a business-facing
--     endpoint. GET /customer/verify continues to omit them; the
--     only way to read them is GET /customer/preferred-locations,
--     which is scoped to the requesting customer.
-- ============================================================

-- ============================================================
--  1. ADD COLUMNS TO CUSTOMERS
-- ============================================================

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_continent VARCHAR(100);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_country VARCHAR(100);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_county VARCHAR(100);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_sub_county VARCHAR(100);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_ward VARCHAR(100);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_town VARCHAR(100);

-- Timestamp so the account page can show "Preferred area set on …"
-- and so search caching can be invalidated cleanly if ever needed.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS preferred_locations_updated_at TIMESTAMP;

-- ============================================================
--  2. INDEXES
-- ============================================================

-- A partial index keeps the footprint tiny: only customers who
-- actually saved a preferred area are indexed. This is enough for
-- the search handler's "does this customer have a soft anchor?"
-- lookup, which is a single-row read by primary key anyway.
CREATE INDEX IF NOT EXISTS idx_customers_preferred_county
    ON customers(preferred_county)
    WHERE preferred_county IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_preferred_town
    ON customers(preferred_town)
    WHERE preferred_town IS NOT NULL;

-- ============================================================
--  3. VERIFY
-- ============================================================

DO $$
DECLARE
    total_customers      INTEGER;
    with_preferred       INTEGER;
    has_continent        BOOLEAN;
    has_country          BOOLEAN;
    has_county           BOOLEAN;
    has_sub_county       BOOLEAN;
    has_ward             BOOLEAN;
    has_town             BOOLEAN;
    has_updated_at       BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO total_customers FROM customers;
    SELECT COUNT(*) INTO with_preferred
        FROM customers
        WHERE preferred_county IS NOT NULL
           OR preferred_town   IS NOT NULL;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_continent'
    ) INTO has_continent;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_country'
    ) INTO has_country;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_county'
    ) INTO has_county;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_sub_county'
    ) INTO has_sub_county;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_ward'
    ) INTO has_ward;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_town'
    ) INTO has_town;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'preferred_locations_updated_at'
    ) INTO has_updated_at;

    RAISE NOTICE 'customers total:                    %', total_customers;
    RAISE NOTICE 'customers with a preferred area:    %', with_preferred;
    RAISE NOTICE 'customers.preferred_continent  →    %', has_continent;
    RAISE NOTICE 'customers.preferred_country    →    %', has_country;
    RAISE NOTICE 'customers.preferred_county     →    %', has_county;
    RAISE NOTICE 'customers.preferred_sub_county →    %', has_sub_county;
    RAISE NOTICE 'customers.preferred_ward       →    %', has_ward;
    RAISE NOTICE 'customers.preferred_town       →    %', has_town;
    RAISE NOTICE 'customers.preferred_locations_updated_at → %', has_updated_at;
END $$;