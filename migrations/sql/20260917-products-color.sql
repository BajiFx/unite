-- ============================================================
--  PRODUCTS.COLOR — parent colour
--  Location: migrations/sql/20260917-products-color.sql
--
--  Purpose:
--   The products table has never carried a colour column. The
--   customer-facing product detail page needs a colour to show
--   as the FIRST swatch in the colour strip — the primary
--   colour of the product itself. Every additional colour
--   lives in a row of product_variants.
--
--   This migration adds that column so the admin form can
--   declare the parent colour, and so the API can return it to
--   the customer page.
--
--  What it does:
--   1. Adds products.color as a nullable VARCHAR(80).
--   2. Backfills existing rows to NULL (they simply have no
--      colour declared yet; the client will fall back to the
--      variant name or "Default" as before).
--   3. Adds a small index on color so future "filter by colour"
--      queries are fast without a follow-up migration.
--
--  Idempotent:
--   Every statement uses IF NOT EXISTS, so the file can be
--   re-run safely.
-- ============================================================


-- ============================================================
--  1. ADD THE COLUMN
-- ============================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS color VARCHAR(80);


-- ============================================================
--  2. INDEX
--
--  A btree index on the parent colour. The current code does
--  not query by colour yet, but the marketplace will want to
--  in a follow-up, and this saves a second migration.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_color
    ON products (color)
    WHERE color IS NOT NULL;


-- ============================================================
--  3. VERIFY
-- ============================================================

DO $$
DECLARE
    has_column  BOOLEAN;
    has_index   BOOLEAN;
    total_rows  INTEGER;
    null_rows   INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'color'
    ) INTO has_column;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_products_color'
    ) INTO has_index;

    SELECT COUNT(*) INTO total_rows FROM products;
    SELECT COUNT(*) INTO null_rows FROM products WHERE color IS NULL;

    RAISE NOTICE 'products.color column →      %', has_column;
    RAISE NOTICE 'idx_products_color index →   %', has_index;
    RAISE NOTICE 'products total →             %', total_rows;
    RAISE NOTICE 'products with NULL color →   %', null_rows;

    IF has_column AND has_index THEN
        RAISE NOTICE 'products.color migration is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the migration did not land. Please investigate.';
    END IF;
END $$;