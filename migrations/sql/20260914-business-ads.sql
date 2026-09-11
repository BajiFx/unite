-- ============================================================
--  SECTION J — BUSINESS ADS (HERO SLIDER ON MARKETPLACE)
--  Location: migrations/sql/20260914-business-ads.sql
--
--  Purpose:
--   J.1 — Create the business_ads table that stores ad media,
--         the link target, the display duration, and the
--         analytics counters used by the marketplace hero
--         slider.
--   J.7 — views, clicks, and click_through_rate live on this
--         table so the business admin can see performance
--         per ad (J.3).
--
--  Notes:
--   - `link_type` is either 'profile' (the ad points at the
--     business profile page) or 'product' (the ad points at a
--     specific product detail page).
--   - When `link_type = 'product'`, `link_target_id` must
--     reference a real product owned by the same business.
--     This is enforced at the application layer so a broken
--     product link can never leave the slider pointing at a
--     404. The FK below is a safety net.
--   - `display_duration` is optional. When NULL, the slider
--     falls back to the defaults from Section J.5:
--       images → 10 seconds
--       videos → 120 seconds
--   - `click_through_rate` is a percent (0-100, 2 decimals),
--     derived from views and clicks. It is recalculated by the
--     view / click endpoints rather than by a trigger, so the
--     application stays the single source of truth for the
--     formula.
--   - All statements use IF NOT EXISTS / IF EXISTS so the file
--     can be re-run safely.
-- ============================================================

-- ============================================================
--  1. TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS business_ads (
    id SERIAL PRIMARY KEY,

    business_id INTEGER NOT NULL
        REFERENCES businesses(id) ON DELETE CASCADE,

    media_type VARCHAR(20) NOT NULL
        CHECK (media_type IN ('image', 'video')),

    media_url VARCHAR(500) NOT NULL,

    title VARCHAR(200),
    description TEXT,

    link_type VARCHAR(20) NOT NULL DEFAULT 'profile'
        CHECK (link_type IN ('profile', 'product')),

    link_target_id INTEGER,

    display_duration INTEGER,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    views INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    click_through_rate DECIMAL(5,2) NOT NULL DEFAULT 0,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
--  2. IDEMPOTENT COLUMN GUARDS
--  In case an earlier draft of this table already existed with
--  a narrower shape (e.g. from 004_location_and_payment_updates),
--  add any missing columns without touching existing data.
-- ============================================================

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS display_duration INTEGER;

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS views INTEGER NOT NULL DEFAULT 0;

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS clicks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS click_through_rate DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================================
--  3. INDEXES
--  The marketplace only ever fetches active ads belonging to
--  active businesses, sorted by recency. That is the one hot
--  query, so it gets a covering composite index.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_business_ads_active
    ON business_ads(is_active, business_id);

CREATE INDEX IF NOT EXISTS idx_business_ads_business_id
    ON business_ads(business_id);

CREATE INDEX IF NOT EXISTS idx_business_ads_media_type
    ON business_ads(media_type);

-- ============================================================
--  4. AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_business_ads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_business_ads_updated_at ON business_ads;
CREATE TRIGGER trg_business_ads_updated_at
BEFORE UPDATE ON business_ads
FOR EACH ROW
EXECUTE FUNCTION set_business_ads_updated_at();

-- ============================================================
--  5. SAFETY CHECK FOR PRODUCT TARGETS
--  A NULL link_target_id is always allowed (profile link).
--  A non-NULL link_target_id must reference a product that
--  belongs to the same business as the ad. This keeps the
--  data model honest even if a caller bypasses the app layer.
--
--  We implement this as a trigger instead of a FK because a
--  plain FK cannot also assert that product.business_id equals
--  business_ads.business_id.
-- ============================================================

CREATE OR REPLACE FUNCTION check_business_ads_target()
RETURNS TRIGGER AS $$
DECLARE
    target_business_id INTEGER;
BEGIN
    IF NEW.link_type = 'product' AND NEW.link_target_id IS NOT NULL THEN
        SELECT business_id
          INTO target_business_id
          FROM products
         WHERE id = NEW.link_target_id;

        IF target_business_id IS NULL THEN
            RAISE EXCEPTION
                'business_ads.link_target_id % does not reference an existing product',
                NEW.link_target_id;
        END IF;

        IF target_business_id <> NEW.business_id THEN
            RAISE EXCEPTION
                'business_ads.link_target_id % belongs to business %, not to ad business %',
                NEW.link_target_id, target_business_id, NEW.business_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_business_ads_target ON business_ads;
CREATE TRIGGER trg_business_ads_target
BEFORE INSERT OR UPDATE OF link_type, link_target_id, business_id
ON business_ads
FOR EACH ROW
EXECUTE FUNCTION check_business_ads_target();

-- ============================================================
--  6. VERIFY
-- ============================================================

DO $$
DECLARE
    total_ads INTEGER;
    active_ads INTEGER;
    video_ads INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_ads  FROM business_ads;
    SELECT COUNT(*) INTO active_ads FROM business_ads WHERE is_active = TRUE;
    SELECT COUNT(*) INTO video_ads  FROM business_ads WHERE media_type = 'video';

    RAISE NOTICE 'business_ads total:   %', total_ads;
    RAISE NOTICE 'business_ads active:  %', active_ads;
    RAISE NOTICE 'business_ads videos:  %', video_ads;
END $$;