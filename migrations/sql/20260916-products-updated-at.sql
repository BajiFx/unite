-- ============================================================
--  PRODUCTS.updated_at
--  Location: migrations/sql/20260916-products-updated-at.sql
--
--  Purpose:
--   The products table was created in multi-vendor-schema.sql
--   without an updated_at column. Every other first-class row in
--   the marketplace (businesses, orders, carts, product_variants,
--   product_categories, business_ads, customers) already has one.
--   products was missed.
--
--   The variant service (src/services/variantService.js) writes
--   to products.updated_at every time it detects or stores the
--   variant axis on a parent product:
--
--       UPDATE products
--          SET variant_axis_kind = $1,
--              variant_axis_label = $2,
--              updated_at = NOW()
--        WHERE id = $3
--
--   Because the column did not exist, every save of a product
--   with variants failed with:
--
--       column "updated_at" of relation "products" does not exist
--
--   which the API surfaced as HTTP 500 on
--   POST /api/business-admin/products and PUT /api/business-admin/products/:id.
--
--  What this migration does:
--   1. Adds products.updated_at as a nullable TIMESTAMP.
--   2. Backfills every existing row to its created_at so no row
--      is left with NULL.
--   3. Sets the default to CURRENT_TIMESTAMP so future inserts
--      populate it automatically.
--   4. Adds a trigger that keeps updated_at fresh on every
--      UPDATE, mirroring the same pattern already used by
--      product_variants and product_categories.
--
--  Idempotent:
--   Every statement uses IF NOT EXISTS / IF EXISTS, so the file
--   can be re-run safely.
-- ============================================================


-- ============================================================
--  1. ADD THE COLUMN
-- ============================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;


-- ============================================================
--  2. BACKFILL EXISTING ROWS
--
--  Use created_at when it is present, otherwise NOW(). The
--  products table has always had created_at, so the fallback
--  only exists as a safety net.
-- ============================================================

UPDATE products
SET updated_at = COALESCE(created_at, NOW())
WHERE updated_at IS NULL;


-- ============================================================
--  3. DEFAULT FOR FUTURE INSERTS
-- ============================================================

ALTER TABLE products
    ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;


-- ============================================================
--  4. KEEP updated_at FRESH ON UPDATE
--
--  Same pattern already used by product_variants and
--  product_categories. The trigger is dropped first so a
--  re-run never leaves two competing versions.
-- ============================================================

CREATE OR REPLACE FUNCTION set_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION set_products_updated_at();


-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    has_column      BOOLEAN;
    has_trigger     BOOLEAN;
    null_rows       INTEGER;
    total_rows      INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products' AND column_name = 'updated_at'
    ) INTO has_column;

    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_products_updated_at'
    ) INTO has_trigger;

    SELECT COUNT(*) INTO total_rows FROM products;
    SELECT COUNT(*) INTO null_rows FROM products WHERE updated_at IS NULL;

    RAISE NOTICE 'products.updated_at column →    %', has_column;
    RAISE NOTICE 'updated_at trigger exists →     %', has_trigger;
    RAISE NOTICE 'products total →                %', total_rows;
    RAISE NOTICE 'products with NULL updated_at → % (must be 0)', null_rows;

    IF has_column AND has_trigger AND null_rows = 0 THEN
        RAISE NOTICE 'products.updated_at migration is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the migration did not land. Please investigate.';
    END IF;
END $$;