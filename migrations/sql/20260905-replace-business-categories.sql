-- Replace the former catalogue with the 15 approved marketplace categories.
-- Assignments are cleared because the prior categories do not map one-to-one to
-- the new catalogue; business admins can select the appropriate new category.
DELETE FROM business_category_assignments;
DELETE FROM business_categories;

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
  ('Events & Entertainment 🎬', 'events-entertainment');

UPDATE businesses SET custom_category = NULL;

-- Keep existing product records selectable in the new admin catalogue.
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
