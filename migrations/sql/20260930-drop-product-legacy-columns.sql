-- ============================================================
--  DROP LEGACY PRODUCT COLUMNS
--  Location: migrations/sql/20260930-drop-product-legacy-columns.sql
--
-- Removes four columns that are no longer used by any admin
-- surface:
--
--    products.discount_percent  — discount is now set per variant
--    products.rating            — ratings come from product_reviews
--    products.contact           — contacts live on the business row
--    products.shipping          — shipping lives on the business row
--
--  Every DROP uses IF EXISTS so the file can be re-run safely
--  and so a fresh database (where the baseline may not have
--  created these) does not abort the migration.
-- ============================================================

ALTER TABLE products DROP COLUMN IF EXISTS discount_percent;
ALTER TABLE products DROP COLUMN IF EXISTS rating;
ALTER TABLE products DROP COLUMN IF EXISTS contact;
ALTER TABLE products DROP COLUMN IF EXISTS shipping;

-- ============================================================
--  VERIFY
-- ============================================================

DO $$
DECLARE
    still_there INTEGER;
BEGIN
    SELECT COUNT(*) INTO still_there
    FROM information_schema.columns
    WHERE table_name = 'products'
      AND column_name IN ('discount_percent', 'rating', 'contact', 'shipping');

    RAISE NOTICE 'legacy product columns still present (must be 0): %', still_there;
END $$;