-- ============================================================
-- MIGRATION: Location & Payment Enhancements
-- ============================================================

-- 1. LOCATION FIELDS (User-Entered, No Hardcoded Values)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS continent VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS country VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS county VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sub_county VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ward VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS town VARCHAR(100);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS specific_area TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS location_geocoded BOOLEAN DEFAULT FALSE;

-- 2. PAYMENT FIELDS (Enhanced M-Pesa)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS mpesa_till_number VARCHAR(50);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS mpesa_paybill_number VARCHAR(50);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS mpesa_paybill_account VARCHAR(50);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS mpesa_payment_type VARCHAR(20) DEFAULT 'paybill';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pochi_la_biashara_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pochi_la_biashara_number VARCHAR(50);

-- 3. ORDER VISIBILITY SETTINGS
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS show_cart_when_disabled BOOLEAN DEFAULT FALSE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS order_disabled_message TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS ad_media_enabled BOOLEAN DEFAULT FALSE;

-- 4. ADVERTISEMENT TABLE
CREATE TABLE IF NOT EXISTS business_ads (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    media_type VARCHAR(20) NOT NULL,
    media_url VARCHAR(500) NOT NULL,
    title VARCHAR(200),
    description TEXT,
    link_type VARCHAR(20) DEFAULT 'profile',
    link_target_id INTEGER,
    display_duration INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    views INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    click_through_rate DECIMAL(5,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_business_ads_active ON business_ads(is_active, business_id);

-- 5. INDEXES FOR LOCATION SEARCH
CREATE INDEX IF NOT EXISTS idx_businesses_country ON businesses(country);
CREATE INDEX IF NOT EXISTS idx_businesses_county ON businesses(county);
CREATE INDEX IF NOT EXISTS idx_businesses_sub_county ON businesses(sub_county);
CREATE INDEX IF NOT EXISTS idx_businesses_town ON businesses(town);
CREATE INDEX IF NOT EXISTS idx_businesses_continent ON businesses(continent);
CREATE INDEX IF NOT EXISTS idx_businesses_location_combined ON businesses(continent, country, county, sub_county, town);

-- 6. VIEW FOR LOCATION DISTANCE CALCULATION
CREATE OR REPLACE VIEW business_location_view AS
SELECT 
    b.id,
    b.business_name,
    b.slug,
    b.latitude,
    b.longitude,
    b.continent,
    b.country,
    b.county,
    b.sub_county,
    b.ward,
    b.town,
    b.specific_area,
    b.address,
    b.postal_code,
    b.is_active,
    b.is_verified,
    b.location_geocoded,
    (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
    (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating
FROM businesses b
WHERE b.is_active = true;
