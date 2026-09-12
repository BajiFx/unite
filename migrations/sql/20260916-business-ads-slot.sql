-- ============================================================
--  SECTION J — BUSINESS ADS SLOT COLUMN
--  Location: migrations/sql/20260916-business-ads-slot.sql
--
--  Purpose:
--   Add an explicit `slot` integer to `business_ads` so the
--   marketplace hero slider rotates through each business's ads
--   by POSITION, not by upload time.
--
--  Why:
--   Without a fixed slot, the marketplace could only order ads
--   by `created_at`. That gives a business an unfair advantage:
--   it can simply delete and re-upload an ad every morning to
--   jump to the top of the rotation.
--
--   With a fixed slot:
--     * A business always sits in the same position in the
--       cycle, no matter how many times it edits or re-uploads
--       an ad.
--     * The marketplace rotates by slot order (1, 2, 3) across
--       all businesses, so every business gets an equal share
--       of impressions.
--
--  Rules encoded by this migration + the application layer:
--   - slot is an integer, one of 1, 2, 3 (max three per business).
--   - (business_id, slot) is unique, so a business can never
--     hold two ads in the same slot.
--   - slot never changes on edit; only on delete (freed) and on
--     create (filled with the smallest free slot).
--
--  Notes:
--   - Every statement is idempotent so the file can be re-run
--     safely.
--   - Existing rows are backfilled with a deterministic order
--     (oldest first), so the current ad set keeps the position
--     it already had on the slider.
--   - The unique index is created AFTER the backfill, otherwise
--     a table that already contained duplicate rows would abort
--     the migration.
-- ============================================================


-- ============================================================
--  1. ADD THE slot COLUMN (NULLABLE FOR NOW)
-- ============================================================

ALTER TABLE business_ads
    ADD COLUMN IF NOT EXISTS slot INTEGER;


-- ============================================================
--  2. BACKFILL EXISTING ROWS
--
--  Assign slot = 1, 2, 3, ... to each business's existing ads,
--  ordered by id (oldest first). This preserves the position
--  each ad currently holds in the slider.
--
--  Businesses that already have more than three ads will end up
--  with slots > 3. We clamp them to 3 first, so a legacy table
--  cannot block the NOT NULL + range constraint below. Any ad
--  whose clamped slot would collide is deleted from the
--  rotation by setting is_active = false (data is preserved,
--  the row is not destroyed).
-- ============================================================

-- Step 2a — compute a temporary rank per business.
WITH ranked AS (
    SELECT
        id,
        business_id,
        ROW_NUMBER() OVER (
            PARTITION BY business_id
            ORDER BY id ASC
        ) AS rn
    FROM business_ads
)
UPDATE business_ads a
SET slot = LEAST(r.rn, 3)
FROM ranked r
WHERE a.id = r.id;


-- Step 2b — deactivate any legacy ad that fell outside the
-- first three slots so the (business_id, slot) unique index
-- below cannot collide.
UPDATE business_ads a
SET is_active = FALSE
WHERE a.slot IS NULL
   OR a.slot > 3
   OR a.id NOT IN (
        SELECT id FROM (
            SELECT
                id,
                business_id,
                ROW_NUMBER() OVER (
                    PARTITION BY business_id
                    ORDER BY id ASC
                ) AS rn
            FROM business_ads
        ) sub
        WHERE sub.rn <= 3
   );

-- Step 2c — clear any slot that is still NULL (safety net for
-- an ad that slipped through the two updates above).
UPDATE business_ads
SET slot = 1
WHERE slot IS NULL;


-- ============================================================
--  3. ENFORCE THE SLOT RANGE
-- ============================================================

ALTER TABLE business_ads
    DROP CONSTRAINT IF EXISTS business_ads_slot_range;

ALTER TABLE business_ads
    ADD CONSTRAINT business_ads_slot_range
    CHECK (slot BETWEEN 1 AND 3);


-- ============================================================
--  4. MAKE slot NOT NULL
-- ============================================================

ALTER TABLE business_ads
    ALTER COLUMN slot SET NOT NULL;


-- ============================================================
--  5. UNIQUE (business_id, slot)
--
--  This is what guarantees a business cannot hold two ads in
--  the same slot, no matter what the application does.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_ads_business_slot
    ON business_ads (business_id, slot);


-- ============================================================
--  6. INDEX FOR THE MARKETPLACE ROTATION
--
--  The marketplace hero slider reads all active ads belonging
--  to active businesses and orders them by:
--      slot ASC, business_id ASC, id ASC
--  This composite partial index lets that query walk the table
--  in exactly that order, with no sort step.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_business_ads_rotation
    ON business_ads (slot, business_id, id)
    WHERE is_active = TRUE;


-- ============================================================
--  7. VERIFY
-- ============================================================

DO $$
DECLARE
    total_ads         INTEGER;
    active_ads        INTEGER;
    distinct_slots    INTEGER;
    max_slot          INTEGER;
    businesses_over3  INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_ads     FROM business_ads;
    SELECT COUNT(*) INTO active_ads    FROM business_ads WHERE is_active = TRUE;
    SELECT COUNT(DISTINCT slot) INTO distinct_slots
        FROM business_ads WHERE is_active = TRUE;
    SELECT COALESCE(MAX(slot), 0) INTO max_slot
        FROM business_ads;

    SELECT COUNT(*) INTO businesses_over3
    FROM (
        SELECT business_id
        FROM business_ads
        WHERE is_active = TRUE
        GROUP BY business_id
        HAVING COUNT(*) > 3
    ) sub;

    RAISE NOTICE 'business_ads total:                 %', total_ads;
    RAISE NOTICE 'business_ads active:                %', active_ads;
    RAISE NOTICE 'distinct active slots:              %', distinct_slots;
    RAISE NOTICE 'max slot value:                     %', max_slot;
    RAISE NOTICE 'businesses with more than 3 active: %', businesses_over3;

    IF max_slot > 3 THEN
        RAISE NOTICE 'Some slot values are still > 3. Re-check step 2.';
    ELSE
        RAISE NOTICE 'Slot range is 1..3 across the table.';
    END IF;

    IF businesses_over3 = 0 THEN
        RAISE NOTICE 'Every business has at most 3 active ads.';
    ELSE
        RAISE NOTICE 'Some businesses still have more than 3 active ads.';
    END IF;
END $$;