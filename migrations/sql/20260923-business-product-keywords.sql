-- ============================================================
--  BUSINESS PRODUCT KEYWORDS
--  Location: migrations/sql/20260923-business-product-keywords.sql
--
--  Purpose:
--   Adds a small, free-text "what we sell" list to every
--   business. The list is typed by the business admin in
--   Business Admin → My Shop → Business Profile, under a new
--   section called "What You Sell (card ticker)".
--
--   The marketplace renders this list as a slow upward-moving
--   ticker inside every business card (both the flat grid card
--   and the category-block card), giving a browsing customer an
--   instant overview of what a shop offers without having to
--   open the profile.
--
--  Design notes:
--   - Stored as JSONB on the businesses table. This is a
--     display-only, low-cardinality list, so a separate table
--     would be overkill.
--   - Each entry is a short string. The server trims each entry
--     and caps it at 20 characters. The list has a soft target
--     of at least 5 entries, but the field is optional, so the
--     server never refuses an empty or short list. The admin UI
--     shows a warning instead.
--   - The default is an empty JSON array, so existing rows are
--     valid the moment the column is added, and no backfill is
--     required.
--   - When the admin list is empty, the marketplace falls back
--     to the first 5 names from the business's own products
--     table, so a card is never empty. If neither exists, the
--     ticker is hidden entirely and the description comes back.
--
--  Idempotent:
--   Every statement uses IF NOT EXISTS, so the file can be run
--   on an already-migrated database without any effect.
-- ============================================================


-- ============================================================
--  1. ADD COLUMN TO businesses
-- ============================================================

ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS product_keywords JSONB NOT NULL DEFAULT '[]'::jsonb;


-- ============================================================
--  2. ENFORCE THE SHAPE
--
--  The column must always be a JSON array. A simple CHECK
--  constraint stops a bad writer (a script, a manual query, a
--  future route) from ever putting a string or an object in
--  there, which would break the marketplace renderer.
--
--  The constraint is guarded so re-running the file does not
--  attempt to add it twice.
-- ============================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'businesses_product_keywords_is_array'
    ) THEN
        ALTER TABLE businesses
            ADD CONSTRAINT businesses_product_keywords_is_array
            CHECK (jsonb_typeof(product_keywords) = 'array');
    END IF;
END $$;


-- ============================================================
--  3. INDEX
--
--  The marketplace list query already selects every business
--  row, so a plain btree index on this column would never be
--  used by the current code. The only reason to index it is to
--  make future "shop by keyword" queries fast without a
--  follow-up migration.
--
--  A GIN index lets `product_keywords @> '["Bedsheets"]'::jsonb`
--  run in milliseconds even at a large row count, and costs
--  almost nothing to maintain for a small array on each row.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_businesses_product_keywords
    ON businesses
    USING gin (product_keywords);


-- ============================================================
--  4. VERIFY
-- ============================================================

DO $$
DECLARE
    has_column      BOOLEAN;
    has_check       BOOLEAN;
    has_index       BOOLEAN;
    total_rows      INTEGER;
    empty_rows      INTEGER;
    non_empty_rows  INTEGER;
    bad_type_rows   INTEGER;
BEGIN
    -- Column present?
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'businesses'
          AND column_name = 'product_keywords'
    ) INTO has_column;

    -- Check constraint present?
    SELECT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'businesses_product_keywords_is_array'
    ) INTO has_check;

    -- GIN index present?
    SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_businesses_product_keywords'
    ) INTO has_index;

    -- Row counts
    SELECT COUNT(*) INTO total_rows FROM businesses;

    IF has_column THEN
        SELECT COUNT(*) INTO empty_rows
            FROM businesses
            WHERE jsonb_array_length(product_keywords) = 0;

        SELECT COUNT(*) INTO non_empty_rows
            FROM businesses
            WHERE jsonb_array_length(product_keywords) > 0;

        -- Should always be zero: the CHECK constraint guarantees it.
        SELECT COUNT(*) INTO bad_type_rows
            FROM businesses
            WHERE jsonb_typeof(product_keywords) <> 'array';
    ELSE
        empty_rows := 0;
        non_empty_rows := 0;
        bad_type_rows := 0;
    END IF;

    RAISE NOTICE 'businesses.product_keywords column  →  %', has_column;
    RAISE NOTICE 'check constraint is_array           →  %', has_check;
    RAISE NOTICE 'gin index                           →  %', has_index;
    RAISE NOTICE 'businesses total                    →  %', total_rows;
    RAISE NOTICE 'businesses with empty keyword list  →  %', empty_rows;
    RAISE NOTICE 'businesses with keyword list filled →  %', non_empty_rows;
    RAISE NOTICE 'businesses with non-array value     →  % (must be 0)', bad_type_rows;

    IF has_column AND has_check AND has_index AND bad_type_rows = 0 THEN
        RAISE NOTICE 'Business product keywords migration is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the migration did not land. Please investigate.';
    END IF;
END $$;