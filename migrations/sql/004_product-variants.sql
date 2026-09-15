-- ============================================================
--  PHASE 1 — PRODUCT VARIANTS
--  Location: migrations/sql/004_product-variants.sql
--
--  [ ... every comment block from the original file stays here,
--    unchanged ... ]
-- ============================================================

-- ============================================================
--  0. DEFENSIVE CLEANUP OF A HALF-BUILT TABLE
--
--  Earlier development runs of this migration may have created
--  product_variants without one or more of the columns this file
--  now declares. Because CREATE TABLE IF NOT EXISTS silently
--  skips an existing table, the rest of the migration would then
--  fail on the first column it does not find.
--
--  This block drops product_variants only when it is missing the
--  is_active column, which can only happen on a half-built table
--  that never carried real variant data.
--
--  If the table is present and already has is_active, this block
--  does nothing, so re-running the migration on a healthy
--  database is safe.
-- ============================================================

DO $$
DECLARE
    table_exists        BOOLEAN;
    has_is_active       BOOLEAN;
    variant_row_count   INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'product_variants'
    ) INTO table_exists;

    IF NOT table_exists THEN
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_variants'
          AND column_name = 'is_active'
    ) INTO has_is_active;

    IF has_is_active THEN
        -- Healthy table. Leave it alone.
        RETURN;
    END IF;

    -- Half-built table: no is_active column. Confirm it is empty
    -- before dropping, so we never discard real data.
    SELECT COUNT(*) INTO variant_row_count FROM product_variants;

    IF variant_row_count > 0 THEN
        RAISE EXCEPTION
            'product_variants exists without is_active but contains % row(s). Please back up and inspect before re-running the migration.',
            variant_row_count;
    END IF;

    RAISE NOTICE 'Dropping half-built product_variants table (no is_active, 0 rows).';
    DROP TABLE product_variants CASCADE;
END $$;


-- ============================================================
--  1. ADD THE PARENT-LEVEL VARIANT AXIS COLUMNS
-- ============================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS variant_axis_kind VARCHAR(20);

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS variant_axis_label VARCHAR(40);


-- ============================================================
--  2. CREATE product_variants
-- ============================================================

CREATE TABLE IF NOT EXISTS product_variants (
    id SERIAL PRIMARY KEY,

    product_id INTEGER NOT NULL
        REFERENCES products(id) ON DELETE CASCADE,

    name VARCHAR(80) NOT NULL,

    image VARCHAR(500),
    video VARCHAR(500),
    video_poster_url VARCHAR(500),

    price VARCHAR(50),
    old_price VARCHAR(50),
    discount_percent VARCHAR(10),

    stock INTEGER,

    color_code VARCHAR(20),

    display_order INTEGER NOT NULL DEFAULT 0,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
--  3. CONSTRAINTS
-- ============================================================

ALTER TABLE product_variants
    DROP CONSTRAINT IF EXISTS product_variants_name_not_empty;
ALTER TABLE product_variants
    ADD CONSTRAINT product_variants_name_not_empty
    CHECK (LENGTH(BTRIM(name)) BETWEEN 1 AND 80);

ALTER TABLE product_variants
    DROP CONSTRAINT IF EXISTS product_variants_stock_non_negative;
ALTER TABLE product_variants
    ADD CONSTRAINT product_variants_stock_non_negative
    CHECK (stock IS NULL OR stock >= 0);

ALTER TABLE product_variants
    DROP CONSTRAINT IF EXISTS product_variants_color_code_format;
ALTER TABLE product_variants
    ADD CONSTRAINT product_variants_color_code_format
    CHECK (
        color_code IS NULL
        OR color_code ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$'
    );

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_unique_name
    ON product_variants (product_id, LOWER(BTRIM(name)));

ALTER TABLE products
    DROP CONSTRAINT IF EXISTS products_variant_axis_kind_check;
ALTER TABLE products
    ADD CONSTRAINT products_variant_axis_kind_check
    CHECK (
        variant_axis_kind IS NULL
        OR variant_axis_kind IN ('colour', 'size', 'material', 'variant')
    );


-- ============================================================
--  4. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_product_variants_product_active_order
    ON product_variants (product_id, is_active, display_order, id);

CREATE INDEX IF NOT EXISTS idx_product_variants_product
    ON product_variants (product_id);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_image
    ON product_variants (product_id)
    WHERE is_active = TRUE AND image IS NOT NULL AND BTRIM(image) <> '';

CREATE INDEX IF NOT EXISTS idx_product_variants_product_video
    ON product_variants (product_id)
    WHERE is_active = TRUE AND video IS NOT NULL AND BTRIM(video) <> '';


-- ============================================================
--  5. updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION set_product_variants_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_variants_updated_at
    ON product_variants;

CREATE TRIGGER trg_product_variants_updated_at
BEFORE UPDATE ON product_variants
FOR EACH ROW
EXECUTE FUNCTION set_product_variants_updated_at();


-- ============================================================
--  6. BACKFILL EXISTING PRODUCTS WITH AN IMPLICIT VARIANT
-- ============================================================

DO $$
DECLARE
    inserted_count INTEGER := 0;
    candidate RECORD;
BEGIN
    FOR candidate IN
        SELECT p.id
        FROM products p
        WHERE NOT EXISTS (
            SELECT 1
            FROM product_variants v
            WHERE v.product_id = p.id
        )
    LOOP
        INSERT INTO product_variants (
            product_id,
            name,
            display_order,
            is_active
        )
        VALUES (
            candidate.id,
            'Default',
            0,
            TRUE
        );
        inserted_count := inserted_count + 1;
    END LOOP;

    RAISE NOTICE 'Backfilled % implicit Default variant(s).', inserted_count;
END $$;


-- ============================================================
--  7. VERIFY
-- ============================================================

DO $$
DECLARE
    total_products          INTEGER;
    total_variants          INTEGER;
    products_without_variant INTEGER;
    products_with_default   INTEGER;
    duplicate_variant_names INTEGER;
    has_axis_columns        BOOLEAN;
    has_table               BOOLEAN;
    has_updated_trigger     BOOLEAN;
BEGIN
    SELECT COUNT(*) INTO total_products FROM products;
    SELECT COUNT(*) INTO total_variants FROM product_variants;

    SELECT COUNT(*) INTO products_without_variant
    FROM products p
    WHERE NOT EXISTS (
        SELECT 1 FROM product_variants v WHERE v.product_id = p.id
    );

    SELECT COUNT(*) INTO products_with_default
    FROM product_variants
    WHERE LOWER(BTRIM(name)) = 'default';

    SELECT COUNT(*) INTO duplicate_variant_names
    FROM (
        SELECT product_id, LOWER(BTRIM(name)) AS n
        FROM product_variants
        GROUP BY product_id, LOWER(BTRIM(name))
        HAVING COUNT(*) > 1
    ) d;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'products'
          AND column_name = 'variant_axis_kind'
    ) INTO has_axis_columns;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'product_variants'
    ) INTO has_table;

    SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_product_variants_updated_at'
    ) INTO has_updated_trigger;

    RAISE NOTICE 'products total:                       %', total_products;
    RAISE NOTICE 'product_variants total:               %', total_variants;
    RAISE NOTICE 'products with no variant (must be 0): %', products_without_variant;
    RAISE NOTICE 'implicit "Default" variants:          %', products_with_default;
    RAISE NOTICE 'duplicate variant names (must be 0):  %', duplicate_variant_names;
    RAISE NOTICE 'products.variant_axis_kind column:    %', has_axis_columns;
    RAISE NOTICE 'product_variants table exists:        %', has_table;
    RAISE NOTICE 'updated_at trigger exists:            %', has_updated_trigger;

    IF products_without_variant = 0
       AND duplicate_variant_names = 0
       AND has_axis_columns
       AND has_table
       AND has_updated_trigger
    THEN
        RAISE NOTICE 'Phase 1 product variants migration is ready.';
    ELSE
        RAISE NOTICE 'One or more pieces of the Phase 1 migration did not land. Please investigate.';
    END IF;
END $$;