-- ============================================================
--  SECTION 13 — PRODUCT MEDIA TYPE
--  Location: migrations/sql/20260930-product-media-type.sql
--
--  Purpose:
--   Give every product an explicit media classification so the
--   customer-facing listing can offer three filter tabs
--   (All | Images | Videos) and so the product detail page can
--   render the correct media (image vs video) with the correct
--   poster for the grid thumbnail.
--
--  What this migration does:
--   1. Adds products.media_type      — 'image' | 'video'
--   2. Adds products.video_poster_url — still frame for the grid
--   3. Backfills every existing row:
--        * video is present AND image is missing  → 'video'
--        * otherwise                              → 'image'
--   4. Sets media_type NOT NULL with a default of 'image'
--   5. Adds a CHECK constraint so only the two values are
--      allowed
--   6. Adds a btree index on media_type so the three-tab filter
--      on a business profile stays fast at scale
--
--  Idempotent:
--   Every statement uses IF NOT EXISTS / IF EXISTS, so the file
--   can be re-run safely on an already-migrated database.
--
--  Notes:
--   - `products.images` (JSONB) and `products.videos` (JSONB)
--     already exist from 20260905-business-admin-enhancements.sql
--     and are unchanged. They remain the source of the
--     additional media (extra angles, extra clips). This
--     migration only adds the classification of the PRIMARY
--     media, which is what the grid thumbnail and the
--     customer-facing tab filter use.
--   - `products.image` and `products.video` (VARCHAR) already
--     exist and are unchanged. They keep holding the primary
--     image URL and the primary video URL respectively, as they
--     do today.
-- ============================================================


-- ============================================================
--  1. ADD THE COLUMNS
-- ============================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS media_type VARCHAR(10);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS video_poster_url VARCHAR(500);


-- ============================================================
--  2. BACKFILL EXISTING ROWS
--
--  Rule:
--    - A row whose only media is a video  → 'video'
--    - Every other row                    → 'image'
--
--  This makes the migration safe on any existing dataset. A
--  product with no media at all ends up as 'image', which is the
--  same behaviour the customer-facing grid has today (it renders
--  the fallback placeholder).
-- ============================================================

UPDATE products
SET media_type = CASE
    WHEN video IS NOT NULL
         AND BTRIM(video) <> ''
         AND (image IS NULL OR BTRIM(image) = '')
        THEN 'video'
    ELSE 'image'
END
WHERE media_type IS NULL;


-- ============================================================
--  3. SET NOT NULL AND DEFAULT
--
--  Order matters:
--    a) set the default so future inserts are safe
--    b) set NOT NULL now that every row has a value
-- ============================================================

ALTER TABLE products
    ALTER COLUMN media_type SET DEFAULT 'image';

ALTER TABLE products
    ALTER COLUMN media_type SET NOT NULL;


-- ============================================================
--  4. CHECK CONSTRAINT
--
--  Guarantees the column can only ever hold one of two values,
--  no matter what any future writer tries to do.
-- ============================================================

ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_media_type_check;

ALTER TABLE products
    ADD CONSTRAINT products_media_type_check
    CHECK (media_type IN ('image', 'video'));


-- ============================================================
--  5. INDEX
--
--  The three-tab filter on the business profile runs, for the
--  Videos tab, essentially:
--      SELECT * FROM products
--      WHERE business_id = $1
--        AND is_active = true
--        AND media_type = 'video'
--  The existing partial index on (business_id) WHERE
--  is_active = true already narrows the scan. This new index
--  adds media_type to the same partial set so the planner can
--  use a single index for both the Images and the Videos tabs.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_products_business_media_active
    ON products (business_id, media_type)
    WHERE is_active = true;


-- ============================================================
--  6. VERIFY
-- ============================================================

DO $$
DECLARE
    total_products     INTEGER;
    image_products     INTEGER;
    video_products     INTEGER;
    missing_media_type INTEGER;
    has_poster_column  BOOLEAN;
    has_check          BOOLEAN;
    has_index          BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO total_products     FROM products;
    SELECT COUNT(*) INTO image_products     FROM products WHERE media_type = 'image';
    SELECT COUNT(*) INTO video_products     FROM products WHERE media_type = 'video';
    SELECT COUNT(*) INTO missing_media_type FROM products WHERE media_type IS NULL;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products'
          AND column_name = 'video_poster_url'
    ) INTO has_poster_column;

    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'products_media_type_check'
    ) INTO has_check;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_products_business_media_active'
    ) INTO has_index;

    RAISE NOTICE 'products total:                 %', total_products;
    RAISE NOTICE 'products classified as image:   %', image_products;
    RAISE NOTICE 'products classified as video:   %', video_products;
    RAISE NOTICE 'products with NULL media_type:  % (must be 0)', missing_media_type;
    RAISE NOTICE 'products.video_poster_url →     %', has_poster_column;
    RAISE NOTICE 'products_media_type_check  →    %', has_check;
    RAISE NOTICE 'idx_products_business_media_active → %', has_index;

    IF missing_media_type = 0 AND has_poster_column AND has_check AND has_index THEN
        RAISE NOTICE 'Section 13 product media migration is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the Section 13 migration did not land. Please investigate.';
    END IF;
END $$;