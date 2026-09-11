-- ============================================================
--  SECTION C — BUSINESS LOCATION ACTIVATION
--  Location: migrations/sql/20260912-business-location-activation.sql
--
--  Purpose:
--    Adds the fields required so a business admin can activate
--    their location from the browser (Section C):
--      C.1 — Manual lat/lng no longer required
--      C.4 — Coordinates are fetched and stored automatically
--      C.5 — A map preview is shown and the pin can be adjusted
--      C.6 — Re-activation is allowed whenever the business moves
--      C.8 — A clear "Location Activated" status
--      C.9 — A warning when the location is missing / incomplete
--
--  Notes:
--   - `latitude` and `longitude` already exist on `businesses`
--     (added in 004_location_and_payment_updates.sql). This
--     migration only adds the activation-related columns.
--   - All statements use IF NOT EXISTS so the file can be
--     re-run safely.
-- ============================================================

-- ============================================================
--  1. ACTIVATION FLAG AND TIMESTAMPS
-- ============================================================

-- C.4 / C.8 — marks the business as having an activated location
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_activated BOOLEAN NOT NULL DEFAULT FALSE;

-- C.4 — when the activation last succeeded
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_activated_at TIMESTAMP;

-- C.5 — when the pin was last adjusted / confirmed by the admin
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_pin_updated_at TIMESTAMP;

-- C.4 — how the coordinates were obtained: 'browser' | 'pin' | 'geocode'
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_source VARCHAR(20);

-- C.3 — accuracy reported by the browser, in metres
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_accuracy VARCHAR(20);

-- C.9 — whether the business has enough location data to be found
ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS location_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
--  2. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_businesses_location_activated
    ON businesses(location_activated);

CREATE INDEX IF NOT EXISTS idx_businesses_location_complete
    ON businesses(location_complete);

-- ============================================================
--  3. ONE-TIME BACKFILL
--  Any business that already has usable coordinates is treated
--  as activated so admins do not have to re-activate manually.
-- ============================================================

UPDATE businesses
SET
    location_activated      = TRUE,
    location_activated_at   = COALESCE(location_activated_at, updated_at, created_at),
    location_source         = COALESCE(location_source, 'geocode')
WHERE
    location_activated = FALSE
    AND latitude IS NOT NULL
    AND longitude IS NOT NULL
    AND BTRIM(latitude)  <> ''
    AND BTRIM(longitude) <> ''
    AND latitude  ~ '^-?[0-9]+(\.[0-9]+)?$'
    AND longitude ~ '^-?[0-9]+(\.[0-9]+)?$';

-- Mark location as "complete" when both coordinates AND at least
-- one human-readable name are present.
UPDATE businesses
SET location_complete = TRUE
WHERE
    location_complete = FALSE
    AND location_activated = TRUE
    AND (
        NULLIF(BTRIM(county), '')       IS NOT NULL
        OR NULLIF(BTRIM(town), '')      IS NOT NULL
        OR NULLIF(BTRIM(specific_area),'') IS NOT NULL
        OR NULLIF(BTRIM(country), '')   IS NOT NULL
    );

-- ============================================================
--  4. KEEP location_complete IN SYNC
--  A trigger keeps `location_complete` accurate whenever any
--  relevant column changes, so C.9 always shows the right state.
-- ============================================================

CREATE OR REPLACE FUNCTION set_business_location_complete()
RETURNS TRIGGER AS $$
BEGIN
    -- Coordinates present?
    IF NEW.latitude IS NOT NULL
       AND NEW.longitude IS NOT NULL
       AND BTRIM(NEW.latitude)  <> ''
       AND BTRIM(NEW.longitude) <> ''
       AND NEW.latitude  ~ '^-?[0-9]+(\.[0-9]+)?$'
       AND NEW.longitude ~ '^-?[0-9]+(\.[0-9]+)?$'
    THEN
        NEW.location_activated := TRUE;
        NEW.location_activated_at := COALESCE(NEW.location_activated_at, NOW());
    END IF;

    -- Coordinates AND at least one human-readable name?
    IF NEW.location_activated = TRUE
       AND (
            NULLIF(BTRIM(NEW.county), '')        IS NOT NULL
         OR NULLIF(BTRIM(NEW.town), '')          IS NOT NULL
         OR NULLIF(BTRIM(NEW.specific_area), '') IS NOT NULL
         OR NULLIF(BTRIM(NEW.country), '')       IS NOT NULL
       )
    THEN
        NEW.location_complete := TRUE;
    ELSE
        NEW.location_complete := FALSE;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_businesses_location_complete ON businesses;
CREATE TRIGGER trg_businesses_location_complete
BEFORE INSERT OR UPDATE OF
    latitude, longitude,
    country, county, sub_county, ward, town, specific_area,
    location_activated
ON businesses
FOR EACH ROW
EXECUTE FUNCTION set_business_location_complete();

-- ============================================================
--  5. VERIFY
-- ============================================================

DO $$
DECLARE
    activated_count INTEGER;
    complete_count  INTEGER;
    total_count     INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_count     FROM businesses;
    SELECT COUNT(*) INTO activated_count FROM businesses WHERE location_activated = TRUE;
    SELECT COUNT(*) INTO complete_count  FROM businesses WHERE location_complete  = TRUE;
    RAISE NOTICE 'businesses total:      %', total_count;
    RAISE NOTICE 'location activated:    %', activated_count;
    RAISE NOTICE 'location complete:     %', complete_count;
END $$;