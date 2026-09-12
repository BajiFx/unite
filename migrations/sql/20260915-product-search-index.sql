-- ============================================================
--  SECTION K — PRODUCT-NAME SEARCH INDEX
--  Location: migrations/sql/20260915-product-search-index.sql
--
--  Purpose:
--    Speeds up the product-name search that Section K added to
--    GET /api/businesses. When a customer types "shoes",
--    "laptop", "cloth", etc. the server now runs a
--    case-insensitive word-boundary regex against products.name
--    and products.description across every active business.
--
--    Without an index, that regex does a sequential scan on the
--    products table. Fine for a few thousand rows; painful at
--    100k+. A trigram GIN index makes the same query return in
--    milliseconds at any scale.
--
--  What it does:
--    1. Enables the `pg_trgm` extension (idempotent).
--    2. Creates a GIN trigram index on products.name.
--    3. Creates a GIN trigram index on products.description.
--    4. Creates a partial index on products(business_id) for
--       active products only, so the join can narrow the scan
--       before the trigram filter runs.
--
--  Notes:
--    - Every statement uses IF NOT EXISTS / IF EXISTS so the file
--      can be re-run safely.
--    - No data is modified. The migration only adds the extension
--      and the indexes, so it is safe to apply to a live database.
--    - On databases where the migration runner already grants
--      superuser, `CREATE EXTENSION` succeeds directly. On
--      managed PostgreSQL (Aiven, Neon, Supabase) pg_trgm is
--      already whitelisted, so the same statement works.
-- ============================================================

-- ============================================================
--  1. ENABLE pg_trgm
--
--  Idempotent. Wrapped so a lack of CREATE privilege only logs a
--  warning instead of aborting the whole migration — the indexes
--  below can still be created if pg_trgm is already present
--  (which it is on every managed PostgreSQL provider we target).
-- ============================================================

DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    RAISE NOTICE 'pg_trgm extension is available';
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'pg_trgm could not be created (insufficient privilege). The indexes below will only succeed if pg_trgm is already installed.';
    WHEN undefined_file THEN
        RAISE NOTICE 'pg_trgm extension is not available on this server. Product search will fall back to a sequential scan.';
END $$;

-- ============================================================
--  2. GIN TRIGRAM INDEX ON products.name
--
--  This is the primary index for Section K. It accelerates
--  `p.name ~* '<word-boundary-regex>'` and any `ILIKE '%…%'`
--  query on the product name.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
    ON products
    USING gin (name gin_trgm_ops);

-- ============================================================
--  3. GIN TRIGRAM INDEX ON products.description
--
--  The Section K query also matches against the description. This
--  index keeps that side fast without any change to the query.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_description_trgm
    ON products
    USING gin (description gin_trgm_ops);

-- ============================================================
--  4. PARTIAL INDEX FOR ACTIVE PRODUCTS PER BUSINESS
--
--  The product-search query always joins products to businesses
--  on products.business_id and filters products.is_active = true.
--  A partial index on the active rows narrows the scan before the
--  trigram filter runs, which is a small but real win.
--
--  Note: the (business_id) index may already exist as a full
--  index from an earlier migration. A partial index with the same
--  name cannot coexist, so we use a distinct name here.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_active_business
    ON products (business_id)
    WHERE is_active = true;

-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    trgm_installed   BOOLEAN;
    total_products   INTEGER;
    active_products  INTEGER;
    has_name_idx     BOOLEAN;
    has_desc_idx     BOOLEAN;
    has_active_idx   BOOLEAN;
BEGIN
    -- Is pg_trgm available?
    SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
    ) INTO trgm_installed;

    -- Row counts
    SELECT COUNT(*) INTO total_products  FROM products;
    SELECT COUNT(*) INTO active_products FROM products WHERE is_active = true;

    -- Are the indexes present?
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_products_name_trgm'
    ) INTO has_name_idx;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_products_description_trgm'
    ) INTO has_desc_idx;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_products_active_business'
    ) INTO has_active_idx;

    RAISE NOTICE 'pg_trgm installed:                       %', trgm_installed;
    RAISE NOTICE 'products total:                          %', total_products;
    RAISE NOTICE 'products active:                         %', active_products;
    RAISE NOTICE 'idx_products_name_trgm exists:           %', has_name_idx;
    RAISE NOTICE 'idx_products_description_trgm exists:    %', has_desc_idx;
    RAISE NOTICE 'idx_products_active_business exists:     %', has_active_idx;

    IF trgm_installed AND has_name_idx AND has_desc_idx AND has_active_idx THEN
        RAISE NOTICE 'Section K product-search indexes are ready.';
    ELSE
        RAISE NOTICE 'One or more Section K indexes were not created. Product search will still work but may be slower on large tables.';
    END IF;
END $$;