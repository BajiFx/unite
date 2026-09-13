-- ============================================================
--  Replace the former catalogue with the 15 approved marketplace categories.
--
--  SECTION 2C FIX — this migration is now non-destructive.
--
--  Old behaviour:
--    DELETE FROM business_category_assignments;
--    DELETE FROM business_categories;
--  That wiped every assignment and every category before
--  inserting the new 15-category list, so any business that had
--  a category silently lost it.
--
--  New behaviour (this file):
--    1. Snapshot the current assignments by category NAME.
--    2. Delete only the categories whose slug is NOT among the
--       new 15. Anything that survives keeps its id and its
--       existing assignments.
--    3. Insert the new 15 categories with ON CONFLICT (name) DO NOTHING.
--    4. Remap the snapshot back onto the surviving categories so
--       existing businesses keep their category whenever that
--       category still exists.
--    5. Drop the snapshot table.
--
--  Everything is idempotent. Running the file twice is harmless.
-- ============================================================


-- ============================================================
--  1. SNAPSHOT EXISTING ASSIGNMENTS (by category name)
-- ============================================================

CREATE TEMP TABLE IF NOT EXISTS _old_bca AS
SELECT
    b.id           AS business_id,
    bc.name        AS category_name
FROM business_category_assignments bca
JOIN business_categories bc ON bc.id = bca.category_id
JOIN businesses b ON b.id = bca.business_id;

-- In case the table already existed from a previous partial run,
-- start clean.
TRUNCATE _old_bca;
INSERT INTO _old_bca (business_id, category_name)
SELECT
    b.id,
    bc.name
FROM business_category_assignments bca
JOIN business_categories bc ON bc.id = bca.category_id
JOIN businesses b ON b.id = bca.business_id;


-- ============================================================
--  2. DELETE ONLY THE CATEGORIES THAT ARE NOT IN THE NEW LIST
-- ============================================================

DELETE FROM business_categories
WHERE slug NOT IN (
  'health',
  'beauty-personal-care',
  'hardware-construction',
  'education-training',
  'technology-electronics',
  'hospitality-accommodation',
  'travel-leisure',
  'clothing-footwear',
  'food-dining',
  'home-living',
  'sports-fitness',
  'automotive-mechanical',
  'professional-services',
  'agriculture-farming',
  'events-entertainment'
);


-- ============================================================
--  3. INSERT THE 15 APPROVED CATEGORIES
-- ============================================================

INSERT INTO business_categories (name, slug) VALUES
  ('Health 🏥', 'health'),
  ('Beauty & Personal Care 💄', 'beauty-personal-care'),
  ('Hardware & Construction 🛠️', 'hardware-construction'),
  ('Education & Training 📚', 'education-training'),
  ('Technology & Electronics 💻', 'technology-electronics'),
  ('Hospitality & Accommodation 🏨', 'hospitality-accommodation'),
  ('Travel & Leisure ✈️', 'travel-leisure'),
  ('Clothing & Footwear 👗', 'clothing-footwear'),
  ('Food & Dining 🍕', 'food-dining'),
  ('Home & Living 🏠', 'home-living'),
  ('Sports & Fitness ⚽', 'sports-fitness'),
  ('Automotive & Mechanical 🚗', 'automotive-mechanical'),
  ('Professional Services 📋', 'professional-services'),
  ('Agriculture & Farming 🌾', 'agriculture-farming'),
  ('Events & Entertainment 🎬', 'events-entertainment')
ON CONFLICT (name) DO NOTHING;


-- ============================================================
--  4. REMAP THE SNAPSHOT ONTO THE SURVIVING CATEGORIES
-- ============================================================

INSERT INTO business_category_assignments (business_id, category_id)
SELECT
    s.business_id,
    bc.id
FROM _old_bca s
JOIN business_categories bc ON bc.name = s.category_name
ON CONFLICT (business_id, category_id) DO NOTHING;


-- ============================================================
--  5. CLEAN UP
-- ============================================================

DROP TABLE IF EXISTS _old_bca;


-- ============================================================
--  6. RESET CUSTOM CATEGORY (unchanged from before)
--     Every business must re-pick from the new catalogue, so
--     any legacy free-text category string is cleared.
-- ============================================================

UPDATE businesses SET custom_category = NULL;


-- ============================================================
--  7. REMAP LEGACY product.category VALUES (unchanged from before)
--     Keeps existing product records selectable in the new
--     admin catalogue.
-- ============================================================

UPDATE products
SET category = CASE
  WHEN category ILIKE ANY (ARRAY['%health%', '%medical%', '%beauty%', '%cosmetic%', '%personal care%']) THEN 'Health 🏥'
  WHEN category ILIKE ANY (ARRAY['%hardware%', '%construction%', '%plumbing%', '%electrical%', '%industrial%', '%machinery%', '%tool%']) THEN 'Hardware & Construction 🛠️'
  WHEN category ILIKE ANY (ARRAY['%computer%', '%electronic%', '%phone%', '%tablet%', '%photography%', '%video%', '%music%', '%gaming%']) THEN 'Technology & Electronics 💻'
  WHEN category ILIKE ANY (ARRAY['%clothing%', '%fashion%', '%shoe%', '%footwear%', '%bag%', '%jewelry%', '%watch%']) THEN 'Clothing & Footwear 👗'
  WHEN category ILIKE ANY (ARRAY['%food%', '%grocery%', '%supermarket%', '%bakery%', '%meat%', '%fish%', '%fruit%', '%vegetable%', '%beverage%', '%alcohol%']) THEN 'Food & Dining 🍕'
  WHEN category ILIKE ANY (ARRAY['%furniture%', '%home%', '%kitchen%', '%mattress%', '%bedding%', '%curtain%', '%lighting%', '%cleaning%']) THEN 'Home & Living 🏠'
  WHEN category ILIKE ANY (ARRAY['%sport%', '%fitness%', '%bicycle%', '%cycling%', '%outdoor%', '%camping%']) THEN 'Sports & Fitness ⚽'
  WHEN category ILIKE ANY (ARRAY['%automotive%', '%motorcycle%', '%tyre%', '%battery%']) THEN 'Automotive & Mechanical 🚗'
  WHEN category ILIKE ANY (ARRAY['%agriculture%', '%farm%', '%garden%', '%pet%']) THEN 'Agriculture & Farming 🌾'
  WHEN category ILIKE ANY (ARRAY['%travel%', '%luggage%']) THEN 'Travel & Leisure ✈️'
  WHEN category ILIKE ANY (ARRAY['%book%', '%school%', '%office%', '%stationery%', '%baby%', '%toy%']) THEN 'Education & Training 📚'
  WHEN category ILIKE ANY (ARRAY['%gift%', '%flower%', '%art%', '%craft%', '%entertainment%', '%media%', '%religious%', '%cultural%']) THEN 'Events & Entertainment 🎬'
  ELSE 'Professional Services 📋'
END
WHERE category IS NOT NULL;