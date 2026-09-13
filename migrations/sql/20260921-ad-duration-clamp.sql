-- ============================================================
--  SECTION 2D — AD DURATION CLAMP
--  Location: migrations/sql/20260921-ad-duration-clamp.sql
--
--  Purpose:
--   Enforce the new uniform caps for ad display durations.
--
--   The marketplace hero slider rotates on a wall-clock cycle.
--   When every ad obeys the same cap per media type, the cycle
--   is predictable and no single business can dominate the
--   slider by setting an arbitrarily large display_duration.
--
--   New caps:
--     image  →  4 seconds maximum
--     video  →  20 seconds maximum
--
--   For any existing row that is NULL or above its cap, this
--   migration rewrites display_duration to the matching default.
--   Rows already at or below the cap are left untouched.
--
--  Idempotent:
--   Running the migration twice changes nothing on the second
--   pass, because after the first pass every row already sits
--   at or below its cap.
--
--  Notes:
--   - Only touches business_ads.display_duration.
--   - No schema change. No index change. No trigger change.
--   - Safe to apply on a live database: the UPDATE only rewrites
--     rows that are outside the new range.
-- ============================================================

-- ============================================================
--  1. CLAMP VIDEOS TO 20 SECONDS
-- ============================================================

UPDATE business_ads
SET display_duration = LEAST(COALESCE(display_duration, 20), 20),
    updated_at = NOW()
WHERE media_type = 'video'
  AND (display_duration IS NULL OR display_duration > 20);


-- ============================================================
--  2. CLAMP IMAGES TO 4 SECONDS
-- ============================================================

UPDATE business_ads
SET display_duration = LEAST(COALESCE(display_duration, 4), 4),
    updated_at = NOW()
WHERE media_type <> 'video'
  AND (display_duration IS NULL OR display_duration > 4);


-- ============================================================
--  3. VERIFY
-- ============================================================

DO $$
DECLARE
    video_rows  INTEGER;
    image_rows  INTEGER;
    video_over  INTEGER;
    image_over  INTEGER;
BEGIN
    SELECT COUNT(*) INTO video_rows FROM business_ads WHERE media_type = 'video';
    SELECT COUNT(*) INTO image_rows FROM business_ads WHERE media_type <> 'video';

    SELECT COUNT(*) INTO video_over
        FROM business_ads
        WHERE media_type = 'video' AND display_duration > 20;

    SELECT COUNT(*) INTO image_over
        FROM business_ads
        WHERE media_type <> 'video' AND display_duration > 4;

    RAISE NOTICE 'business_ads video rows:        %', video_rows;
    RAISE NOTICE 'business_ads image rows:        %', image_rows;
    RAISE NOTICE 'video ads still > 20s:          %', video_over;
    RAISE NOTICE 'image ads still > 4s:           %', image_over;

    IF video_over = 0 AND image_over = 0 THEN
        RAISE NOTICE 'All ad durations are within their caps.';
    ELSE
        RAISE NOTICE 'Some rows are still above their cap — please investigate.';
    END IF;
END $$;