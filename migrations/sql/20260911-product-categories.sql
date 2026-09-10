-- ============================================================
--  PRODUCT CATEGORIES MIGRATION
--  Location: migrations/sql/20260911-product-categories.sql
--
--  Section B.1 — Defined product category list (no free text)
--  Section B.2 — Separate from business categories, but linked
--  Section B.3 — Each product category belongs to one business
--                category so the admin dropdown can be filtered
--  Section B.6 — Requests table for new product categories
--  Section B.8 — Single source of truth used everywhere
--
--  Notes:
--   - The final INSERT uses `ON CONFLICT DO NOTHING` (no column list)
--     so that a row is skipped if it collides with either the `slug`
--     unique constraint OR the `name` unique constraint. Listing only
--     one column would let the other constraint abort the whole
--     statement.
--   - Rows with business_slug = NULL are generic categories and are
--     visible to every business, regardless of its own business
--     category. Rows with a business_slug are only visible to
--     businesses assigned to that category.
-- ============================================================

-- ============================================================
--  1. PRODUCT CATEGORIES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS product_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    slug VARCHAR(140) NOT NULL UNIQUE,
    icon VARCHAR(50),
    description TEXT,

    -- B.2 + B.3 — the business category this product category belongs to.
    -- NULL means the product category is generic (all businesses).
    business_category_id INTEGER REFERENCES business_categories(id) ON DELETE SET NULL,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    is_requested BOOLEAN NOT NULL DEFAULT FALSE,
    requested_by_business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT product_categories_name_unique UNIQUE (name)
);

-- ============================================================
--  2. ADD PRODUCT CATEGORY FK TO PRODUCTS
-- ============================================================

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS product_category_id INTEGER
        REFERENCES product_categories(id) ON DELETE SET NULL;

-- ============================================================
--  3. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_product_categories_business_category
    ON product_categories(business_category_id);

CREATE INDEX IF NOT EXISTS idx_product_categories_active
    ON product_categories(is_active);

CREATE INDEX IF NOT EXISTS idx_product_categories_slug
    ON product_categories(slug);

CREATE INDEX IF NOT EXISTS idx_products_product_category
    ON products(product_category_id);

-- ============================================================
--  4. AUTO-UPDATE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_product_categories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_categories_updated_at ON product_categories;
CREATE TRIGGER trg_product_categories_updated_at
BEFORE UPDATE ON product_categories
FOR EACH ROW
EXECUTE FUNCTION set_product_categories_updated_at();

-- ============================================================
--  5. SEED
--  One single INSERT statement. Every row has 4 columns:
--  name, slug, icon, business_slug. business_slug = NULL means
--  the category is generic and visible to every business.
-- ============================================================

INSERT INTO product_categories (name, slug, icon, business_category_id)
SELECT v.name, v.slug, v.icon, bc.id
FROM (VALUES
    -- ============================================================
    -- GENERIC (visible to every business, business_category_id = NULL)
    -- ============================================================
    ('Beddings & Bed Sheets',         'generic-beddings',              '🛏️', NULL),
    ('Towels & Bathrobes',            'generic-towels',                '🧻', NULL),
    ('Blankets & Comforters',         'generic-blankets',              '🧣', NULL),
    ('Pillows & Cushions',            'generic-pillows',               '🛋️', NULL),
    ('Kitchen & Dining',              'generic-kitchen-dining',        '🍽️', NULL),
    ('Cookware & Bakeware',           'generic-cookware',              '🍳', NULL),
    ('Tableware & Cutlery',           'generic-tableware',             '🥄', NULL),
    ('Home Decor & Ornaments',        'generic-home-decor',            '🖼️', NULL),
    ('Curtains & Window Treatments',  'generic-curtains',              '🪟', NULL),
    ('Rugs & Carpets',                'generic-rugs',                  '🧶', NULL),
    ('Lighting & Lamps',              'generic-lighting',              '💡', NULL),
    ('Storage & Organization',        'generic-storage',               '📦', NULL),
    ('Cleaning Supplies',             'generic-cleaning',              '🧽', NULL),
    ('Laundry & Ironing',             'generic-laundry',               '🧺', NULL),
    ('Personal Care & Hygiene',       'generic-personal-care',         '🧼', NULL),
    ('Body Lotions & Creams',         'generic-body-lotions',          '🧴', NULL),
    ('Bath & Shower Products',        'generic-bath-shower',           '🚿', NULL),
    ('Hair Care & Styling',           'generic-hair-care',             '💇', NULL),
    ('Skin Care',                     'generic-skin-care',             '🧴', NULL),
    ('Fragrances & Perfumes (Body)',  'generic-fragrances',            '🌸', NULL),
    ('Makeup & Cosmetics (Body)',     'generic-makeup',                '💄', NULL),
    ('Nail Care & Polish',            'generic-nail-care',             '💅', NULL),
    ('Mens Grooming (Body)',          'generic-mens-grooming',         '🧔', NULL),
    ('Gift Sets & Hampers',           'generic-gift-sets',             '🎁', NULL),
    ('Baby & Toddler Products',       'generic-baby',                  '🍼', NULL),
    ('Toys & Games',                  'generic-toys',                  '🧸', NULL),
    ('Books & Magazines',             'generic-books',                 '📚', NULL),
    ('Stationery & Office',           'generic-stationery',            '✏️', NULL),
    ('Art & Craft Supplies',          'generic-art-craft',             '🎨', NULL),
    ('Food & Beverages',              'generic-food-beverages',        '🍱', NULL),
    ('Snacks & Confectionery',        'generic-snacks',                '🍫', NULL),
    ('Cakes & Pastries',              'generic-cakes',                 '🧁', NULL),
    ('Fresh Produce',                 'generic-produce',               '🥬', NULL),
    ('Meat, Poultry & Fish',          'generic-meat-fish',             '🥩', NULL),
    ('Dairy & Eggs',                  'generic-dairy',                 '🥚', NULL),
    ('Grains, Rice & Cereals',        'generic-grains',                '🌾', NULL),
    ('Cooking Oils & Spices',         'generic-oils-spices',           '🧂', NULL),
    ('Beverages & Drinks',            'generic-beverages',             '🥤', NULL),
    ('Alcoholic Beverages',           'generic-alcohol',               '🍷', NULL),
    ('Tobacco & Smoking',             'generic-tobacco',               '🚬', NULL),
    ('Electronics & Gadgets',         'generic-electronics',           '🔌', NULL),
    ('Mobile Phones & Accessories',   'generic-phones',                '📱', NULL),
    ('Computers & Laptops',           'generic-computers',             '💻', NULL),
    ('Computer Accessories',          'generic-computer-accessories',  '🖱️', NULL),
    ('Audio & Headphones',            'generic-audio',                 '🎧', NULL),
    ('TVs & Home Theatre',            'generic-tv',                    '📺', NULL),
    ('Cameras & Photography',         'generic-cameras',               '📷', NULL),
    ('Gaming & Consoles',             'generic-gaming',                '🎮', NULL),
    ('Smart Watches & Wearables',     'generic-wearables',             '⌚', NULL),
    ('Power & Charging',              'generic-power',                 '🔋', NULL),
    ('Networking & Wi-Fi',            'generic-networking',            '📡', NULL),
    ('Software & Digital Goods',      'generic-software',              '💾', NULL),
    ('Clothing & Fashion',            'generic-clothing',              '👕', NULL),
    ('Shoes & Footwear',              'generic-shoes',                 '👟', NULL),
    ('Bags & Luggage',                'generic-bags',                  '👜', NULL),
    ('Jewelry & Watches',             'generic-jewelry',               '💍', NULL),
    ('Hats, Caps & Scarves',          'generic-hats',                  '🧢', NULL),
    ('Sunglasses & Eyewear',          'generic-eyewear',               '🕶️', NULL),
    ('Underwear & Lingerie',          'generic-underwear',             '🩲', NULL),
    ('Sportswear & Activewear',       'generic-sportswear',            '🎽', NULL),
    ('Sports Equipment',              'generic-sports-equipment',      '⚽', NULL),
    ('Fitness & Gym Equipment',       'generic-fitness',               '🏋️', NULL),
    ('Outdoor & Camping Gear',        'generic-outdoor',               '⛺', NULL),
    ('Bicycles & Cycling',            'generic-cycling',               '🚴', NULL),
    ('Motorcycles & Spares',          'generic-motorcycles',           '🏍️', NULL),
    ('Cars & Automotive',             'generic-automotive',            '🚗', NULL),
    ('Car Parts & Accessories',       'generic-car-parts',             '🔧', NULL),
    ('Tyres & Wheels',                'generic-tyres',                 '🛞', NULL),
    ('Batteries & Lubricants',        'generic-batteries',             '🔋', NULL),
    ('Tools & Hardware',              'generic-tools',                 '🔨', NULL),
    ('Building Materials',            'generic-building',              '🧱', NULL),
    ('Plumbing & Electrical',         'generic-plumbing',              '🚰', NULL),
    ('Paint & Finishes',              'generic-paint',                 '🎨', NULL),
    ('Safety Gear & PPE',             'generic-safety',                '🦺', NULL),
    ('Garden & Outdoor',              'generic-garden',                '🌱', NULL),
    ('Farm Supplies & Livestock',     'generic-farm',                  '🚜', NULL),
    ('Seeds, Fertilizers & Feeds',    'generic-seeds',                 '🌾', NULL),
    ('Flowers & Plants',              'generic-flowers',               '🌷', NULL),
    ('Pet Supplies',                  'generic-pets',                  '🐾', NULL),
    ('Medical & Health Supplies',     'generic-medical',               '🩺', NULL),
    ('Medicines & Prescriptions (Body)', 'generic-medicines',          '💊', NULL),
    ('First Aid & Bandages (Body)',   'generic-first-aid',             '🩹', NULL),
    ('Health Supplements',            'generic-supplements',           '🧴', NULL),
    ('Furniture (Generic)',           'generic-furniture',             '🪑', NULL),
    ('Mattresses',                    'generic-mattresses',            '🛏️', NULL),
    ('Home Appliances',               'generic-home-appliances',       '🔌', NULL),
    ('Office Furniture',              'generic-office-furniture',      '💼', NULL),
    ('Real Estate & Land',            'generic-real-estate',           '🏘️', NULL),
    ('Rentals & Apartments',          'generic-rentals',               '🔑', NULL),
    ('Construction Services',         'generic-construction',          '🏗️', NULL),
    ('Professional Services',         'generic-professional',          '📋', NULL),
    ('Repair & Maintenance',          'generic-repair',                '🛠️', NULL),
    ('Cleaning Services',             'generic-cleaning-service',      '🧹', NULL),
    ('Events & Catering',             'generic-events',                '🎉', NULL),
    ('Party Supplies',                'generic-party',                 '🎈', NULL),
    ('Musical Instruments',           'generic-music',                 '🎸', NULL),
    ('DJ & Sound Equipment',          'generic-dj',                    '🎚️', NULL),
    ('Photography & Video Services',  'generic-photography-services',  '📸', NULL),
    ('Printing & Packaging',          'generic-printing',              '🖨️', NULL),
    ('Educational Materials',         'generic-educational',           '📖', NULL),
    ('Religious & Cultural Items',    'generic-religious',             '🕉️', NULL),
    ('Souvenirs & Local Crafts',      'generic-souvenirs',             '🎁', NULL),
    ('Wholesale & Bulk',              'generic-wholesale',             '📦', NULL),
    ('Second-Hand & Used',            'generic-second-hand',           '♻️', NULL),
    ('Rental Equipment',              'generic-rental-equipment',      '📦', NULL),
    ('Vouchers & Gift Cards',         'generic-vouchers',              '🎟️', NULL),

    -- ============================================================
    -- HEALTH
    -- ============================================================
    ('Medicines & Prescriptions',     'medicines-prescriptions',       '💊', 'health'),
    ('First Aid & Bandages',          'first-aid-bandages',            '🩹', 'health'),
    ('Vitamins & Supplements',        'vitamins-supplements',          '🧴', 'health'),
    ('Medical Equipment',             'medical-equipment',             '🩺', 'health'),
    ('Baby & Maternal Care',          'baby-maternal-care',            '🍼', 'health'),
    ('Personal Protective Equipment', 'personal-protective-equipment', '🧤', 'health'),
    ('Optical & Eyewear',             'optical-eyewear',               '👓', 'health'),
    ('Dental Care',                   'dental-care',                   '🦷', 'health'),
    ('Traditional & Herbal Medicine', 'traditional-medicine',          '🌿', 'health'),

    -- ============================================================
    -- BEAUTY & PERSONAL CARE
    -- ============================================================
    ('Skincare',                      'skincare',                      '🧴', 'beauty-personal-care'),
    ('Makeup & Cosmetics',            'makeup-cosmetics',              '💄', 'beauty-personal-care'),
    ('Haircare & Wigs',               'haircare',                      '💇', 'beauty-personal-care'),
    ('Fragrances & Perfumes',         'fragrances-perfumes',           '🌸', 'beauty-personal-care'),
    ('Nail Care',                     'nail-care',                     '💅', 'beauty-personal-care'),
    ('Bath & Body',                   'bath-body',                     '🛁', 'beauty-personal-care'),
    ('Mens Grooming',                 'mens-grooming',                 '🧔', 'beauty-personal-care'),
    ('Body Lotions & Creams (Beauty)','beauty-body-lotions',           '🧴', 'beauty-personal-care'),
    ('Salon Equipment & Supplies',    'salon-equipment',               '💈', 'beauty-personal-care'),
    ('Barber Supplies',               'barber-supplies',               '💈', 'beauty-personal-care'),

    -- ============================================================
    -- HARDWARE & CONSTRUCTION
    -- ============================================================
    ('Hand Tools',                    'hand-tools',                    '🔨', 'hardware-construction'),
    ('Power Tools',                   'power-tools',                   '⚡', 'hardware-construction'),
    ('Building Materials',            'building-materials',            '🧱', 'hardware-construction'),
    ('Plumbing Supplies',             'plumbing-supplies',             '🚰', 'hardware-construction'),
    ('Electrical Supplies',           'electrical-supplies',           '🔌', 'hardware-construction'),
    ('Paint & Finishes',              'paint-finishes',                '🎨', 'hardware-construction'),
    ('Fasteners & Fixings',           'fasteners-fixings',             '🔩', 'hardware-construction'),
    ('Safety Gear',                   'safety-gear',                   '🦺', 'hardware-construction'),
    ('Roofing & Gutters',             'roofing-gutters',               '🏠', 'hardware-construction'),
    ('Doors, Windows & Frames',       'doors-windows',                 '🚪', 'hardware-construction'),
    ('Tiles, Ceramics & Stone',       'tiles-ceramics',                '🧱', 'hardware-construction'),
    ('Cement, Sand & Aggregates',     'cement-aggregates',             '🧱', 'hardware-construction'),
    ('Steel & Metal Products',        'steel-metal',                   '⚙️', 'hardware-construction'),
    ('Timber & Wood Products',        'timber-wood',                   '🪵', 'hardware-construction'),
    ('Glass & Aluminium',             'glass-aluminium',               '🪟', 'hardware-construction'),
    ('Water Pumps & Tanks',           'water-pumps',                   '🚰', 'hardware-construction'),
    ('Solar & Renewable Energy',      'solar-energy',                  '☀️', 'hardware-construction'),

    -- ============================================================
    -- EDUCATION & TRAINING
    -- ============================================================
    ('Textbooks',                     'textbooks',                     '📖', 'education-training'),
    ('Stationery',                    'stationery',                    '✏️', 'education-training'),
    ('Office Supplies',               'office-supplies',               '📎', 'education-training'),
    ('School Bags & Lunch Boxes',     'school-bags',                   '🎒', 'education-training'),
    ('Art & Craft Supplies',          'art-craft-supplies',            '🎨', 'education-training'),
    ('Educational Toys',              'educational-toys',              '🧩', 'education-training'),
    ('Uniforms & PE Kits',            'uniforms-pe-kits',              '👕', 'education-training'),
    ('Science & Lab Equipment',       'science-lab',                   '🔬', 'education-training'),
    ('Musical Instruments (Edu)',     'edu-music',                     '🎹', 'education-training'),
    ('E-Learning & Software',         'e-learning',                    '💻', 'education-training'),
    ('Online Courses',                'online-courses',                '🎓', 'education-training'),
    ('Tutoring & Lessons',            'tutoring',                      '👨‍🏫', 'education-training'),

    -- ============================================================
    -- TECHNOLOGY & ELECTRONICS
    -- ============================================================
    ('Mobile Phones',                 'mobile-phones',                 '📱', 'technology-electronics'),
    ('Tablets',                       'tablets',                       '📲', 'technology-electronics'),
    ('Laptops & Computers',           'laptops-computers',             '💻', 'technology-electronics'),
    ('Computer Accessories',          'computer-accessories',          '🖱️', 'technology-electronics'),
    ('Audio & Headphones',            'audio-headphones',              '🎧', 'technology-electronics'),
    ('TVs & Home Theatre',            'tvs-home-theatre',              '📺', 'technology-electronics'),
    ('Cameras & Photography',         'cameras-photography',           '📷', 'technology-electronics'),
    ('Gaming Consoles',               'gaming-consoles',               '🎮', 'technology-electronics'),
    ('Smart Watches',                 'smart-watches',                 '⌚', 'technology-electronics'),
    ('Networking Equipment',          'networking-equipment',          '📡', 'technology-electronics'),
    ('Power Banks & Chargers',        'power-banks-chargers',          '🔋', 'technology-electronics'),
    ('Smart Home Devices',            'smart-home',                    '🏠', 'technology-electronics'),
    ('Software & Licenses',           'software-licenses',             '💾', 'technology-electronics'),
    ('Drones & RC',                   'drones-rc',                     '🚁', 'technology-electronics'),
    ('Printers & Scanners',           'printers-scanners',             '🖨️', 'technology-electronics'),
    ('Storage Devices',               'storage-devices',               '💽', 'technology-electronics'),

    -- ============================================================
    -- HOSPITALITY & ACCOMMODATION
    -- ============================================================
    ('Bedding & Linen',               'bedding-linen',                 '🛏️', 'hospitality-accommodation'),
    ('Towels',                        'towels',                        '🧻', 'hospitality-accommodation'),
    ('Toiletries',                    'toiletries',                    '🧼', 'hospitality-accommodation'),
    ('Room Decor',                    'room-decor',                    '🖼️', 'hospitality-accommodation'),
    ('Kitchenware',                   'kitchenware',                   '🍽️', 'hospitality-accommodation'),
    ('Furniture',                     'hospitality-furniture',         '🪑', 'hospitality-accommodation'),
    ('Hotel Supplies',                'hotel-supplies',                '🏨', 'hospitality-accommodation'),
    ('Restaurant Equipment',          'restaurant-equipment',          '🍴', 'hospitality-accommodation'),
    ('Cleaning & Housekeeping',       'housekeeping',                  '🧹', 'hospitality-accommodation'),

    -- ============================================================
    -- TRAVEL & LEISURE
    -- ============================================================
    ('Luggage & Suitcases',           'luggage-suitcases',             '🧳', 'travel-leisure'),
    ('Travel Bags',                   'travel-bags',                   '🎒', 'travel-leisure'),
    ('Travel Accessories',            'travel-accessories',            '🛂', 'travel-leisure'),
    ('Camping Gear',                  'camping-gear',                  '⛺', 'travel-leisure'),
    ('Outdoor Equipment',             'outdoor-equipment',             '🥾', 'travel-leisure'),
    ('Travel Books & Maps',           'travel-books',                  '🗺️', 'travel-leisure'),
    ('Tickets & Vouchers',            'tickets-vouchers',              '🎟️', 'travel-leisure'),

    -- ============================================================
    -- CLOTHING & FOOTWEAR
    -- ============================================================
    ('T-Shirts',                      't-shirts',                      '👕', 'clothing-footwear'),
    ('Shirts & Blouses',              'shirts-blouses',                '👔', 'clothing-footwear'),
    ('Dresses',                       'dresses',                       '👗', 'clothing-footwear'),
    ('Skirts',                        'skirts',                        '👚', 'clothing-footwear'),
    ('Trousers & Jeans',              'trousers-jeans',                '👖', 'clothing-footwear'),
    ('Jackets & Coats',               'jackets-coats',                 '🧥', 'clothing-footwear'),
    ('Sneakers',                      'sneakers',                      '👟', 'clothing-footwear'),
    ('Dress Shoes',                   'dress-shoes',                   '👞', 'clothing-footwear'),
    ('Sandals & Slippers',            'sandals-slippers',              '🩴', 'clothing-footwear'),
    ('Boots',                         'boots',                         '🥾', 'clothing-footwear'),
    ('Bags & Handbags',               'bags-handbags',                 '👜', 'clothing-footwear'),
    ('Jewelry & Watches',             'jewelry-watches',               '💍', 'clothing-footwear'),
    ('Hats & Caps',                   'hats-caps',                     '🧢', 'clothing-footwear'),
    ('Underwear & Lingerie',          'underwear-lingerie',            '🩲', 'clothing-footwear'),
    ('Sportswear',                    'sportswear',                    '🎽', 'clothing-footwear'),
    ('Traditional & African Wear',    'traditional-african-wear',      '🧵', 'clothing-footwear'),
    ('Tailoring & Alterations',       'tailoring',                     '🧵', 'clothing-footwear'),
    ('Baby & Kids Clothing',          'baby-kids-clothing',            '👶', 'clothing-footwear'),

    -- ============================================================
    -- FOOD & DINING
    -- ============================================================
    ('Fresh Produce',                 'fresh-produce',                 '🥬', 'food-dining'),
    ('Meat & Poultry',                'meat-poultry',                  '🥩', 'food-dining'),
    ('Fish & Seafood',                'fish-seafood',                  '🐟', 'food-dining'),
    ('Dairy & Eggs',                  'dairy-eggs',                    '🥚', 'food-dining'),
    ('Bakery & Bread',                'bakery-bread',                  '🥖', 'food-dining'),
    ('Cakes & Pastries',              'cakes-pastries',                '🧁', 'food-dining'),
    ('Beverages',                     'beverages',                     '🥤', 'food-dining'),
    ('Snacks & Confectionery',        'snacks-confectionery',          '🍫', 'food-dining'),
    ('Canned & Packaged Foods',       'canned-packaged-foods',         '🥫', 'food-dining'),
    ('Spices & Seasonings',           'spices-seasonings',             '🧂', 'food-dining'),
    ('Cooking Oils',                  'cooking-oils',                  '🫒', 'food-dining'),
    ('Grains & Cereals',              'grains-cereals',                '🌾', 'food-dining'),
    ('Prepared Meals',                'prepared-meals',                '🍱', 'food-dining'),
    ('Catering',                      'catering',                      '🍽️', 'food-dining'),
    ('Restaurant Menu Items',         'restaurant-menu',               '🍴', 'food-dining'),
    ('Coffee & Tea',                  'coffee-tea',                    '☕', 'food-dining'),
    ('Alcoholic Drinks',              'food-alcohol',                  '🍷', 'food-dining'),
    ('Specialty & Dietary Foods',     'specialty-dietary',             '🥗', 'food-dining'),

    -- ============================================================
    -- HOME & LIVING
    -- ============================================================
    ('Furniture',                     'home-furniture',                '🛋️', 'home-living'),
    ('Bedding & Mattresses',          'bedding-mattresses',            '🛏️', 'home-living'),
    ('Curtains & Blinds',             'curtains-blinds',               '🪟', 'home-living'),
    ('Home Decor',                    'home-decor',                    '🖼️', 'home-living'),
    ('Kitchen & Cookware',            'kitchen-cookware',              '🍳', 'home-living'),
    ('Home Appliances',               'home-appliances',               '🔌', 'home-living'),
    ('Lighting',                      'lighting',                      '💡', 'home-living'),
    ('Cleaning Supplies',             'cleaning-supplies',             '🧽', 'home-living'),
    ('Storage & Organization',        'storage-organization',          '📦', 'home-living'),
    ('Garden & Outdoor',              'garden-outdoor',                '🌱', 'home-living'),
    ('Wallpaper & Wall Art',          'wallpaper-art',                 '🖼️', 'home-living'),
    ('Rugs & Carpets',                'home-rugs',                     '🧶', 'home-living'),
    ('Fireplaces & Heating',          'home-heating',                  '🔥', 'home-living'),

    -- ============================================================
    -- SPORTS & FITNESS
    -- ============================================================
    ('Gym Equipment',                 'gym-equipment',                 '🏋️', 'sports-fitness'),
    ('Sportswear (Sports)',           'sports-sportswear',             '🎽', 'sports-fitness'),
    ('Sports Shoes',                  'sports-shoes',                  '👟', 'sports-fitness'),
    ('Balls & Sports Gear',           'balls-sports-gear',             '⚽', 'sports-fitness'),
    ('Cycling Gear',                  'cycling-gear',                  '🚴', 'sports-fitness'),
    ('Fitness Accessories',           'fitness-accessories',           '🧘', 'sports-fitness'),
    ('Outdoor & Hiking Gear',         'hiking-gear',                   '🥾', 'sports-fitness'),
    ('Team Sports Equipment',         'team-sports',                   '🏀', 'sports-fitness'),
    ('Water Sports',                  'water-sports',                  '🏊', 'sports-fitness'),
    ('Martial Arts Gear',             'martial-arts',                  '🥋', 'sports-fitness'),

    -- ============================================================
    -- AUTOMOTIVE & MECHANICAL
    -- ============================================================
    ('Car Parts',                     'car-parts',                     '🔧', 'automotive-mechanical'),
    ('Motorcycle Parts',              'motorcycle-parts',              '🏍️', 'automotive-mechanical'),
    ('Tyres & Wheels',                'tyres-wheels',                  '🛞', 'automotive-mechanical'),
    ('Car Batteries',                 'car-batteries',                 '🔋', 'automotive-mechanical'),
    ('Car Care & Cleaning',           'car-care-cleaning',             '🧼', 'automotive-mechanical'),
    ('Car Accessories',               'car-accessories',               '🚙', 'automotive-mechanical'),
    ('Oils & Lubricants',             'oils-lubricants',               '🛢️', 'automotive-mechanical'),
    ('Tools & Equipment',             'auto-tools-equipment',          '🧰', 'automotive-mechanical'),
    ('Trucks & Commercial Vehicles',  'trucks',                        '🚚', 'automotive-mechanical'),
    ('Bicycle Parts',                 'bicycle-parts',                 '🚲', 'automotive-mechanical'),
    ('Car Audio & Electronics',       'car-audio',                     '🔊', 'automotive-mechanical'),
    ('Vehicle Rental',                'vehicle-rental',                '🔑', 'automotive-mechanical'),

    -- ============================================================
    -- PROFESSIONAL SERVICES
    -- ============================================================
    ('Consulting Services',           'consulting-services',           '💼', 'professional-services'),
    ('Legal Services',                'legal-services',                '⚖️', 'professional-services'),
    ('Accounting & Tax',              'accounting-tax',                '🧾', 'professional-services'),
    ('Marketing & Design',            'marketing-design',              '📢', 'professional-services'),
    ('IT Services',                   'it-services',                   '🖥️', 'professional-services'),
    ('Repair Services',               'repair-services',               '🛠️', 'professional-services'),
    ('Cleaning Services',             'professional-cleaning',         '🧹', 'professional-services'),
    ('Security Services',             'security-services',             '🛡️', 'professional-services'),
    ('Logistics & Transport',         'logistics-transport',           '🚛', 'professional-services'),
    ('Real Estate Services',          'real-estate-services',          '🏘️', 'professional-services'),
    ('Insurance Services',            'insurance-services',            '📄', 'professional-services'),
    ('Training & Coaching',           'training-coaching',             '🎓', 'professional-services'),
    ('Printing & Signage',            'printing-signage',              '🖨️', 'professional-services'),
    ('Photography & Video',           'photography-video',             '📸', 'professional-services'),

    -- ============================================================
    -- AGRICULTURE & FARMING
    -- ============================================================
    ('Seeds',                         'seeds',                         '🌱', 'agriculture-farming'),
    ('Fertilizers',                   'fertilizers',                   '🧪', 'agriculture-farming'),
    ('Pesticides & Herbicides',       'pesticides-herbicides',         '🐛', 'agriculture-farming'),
    ('Farm Equipment',                'farm-equipment',                '🚜', 'agriculture-farming'),
    ('Animal Feed',                   'animal-feed',                   '🌾', 'agriculture-farming'),
    ('Livestock Supplies',            'livestock-supplies',            '🐄', 'agriculture-farming'),
    ('Fresh Farm Produce',            'fresh-farm-produce',            '🥕', 'agriculture-farming'),
    ('Flowers & Plants',              'flowers-plants',                '🌷', 'agriculture-farming'),
    ('Irrigation & Watering',         'irrigation',                    '💧', 'agriculture-farming'),
    ('Greenhouse & Nursery',          'greenhouse',                    '🏡', 'agriculture-farming'),
    ('Poultry & Supplies',            'poultry',                       '🐔', 'agriculture-farming'),
    ('Fish Farming',                  'fish-farming',                  '🐟', 'agriculture-farming'),

    -- ============================================================
    -- EVENTS & ENTERTAINMENT
    -- ============================================================
    ('Party Supplies',                'party-supplies',                '🎉', 'events-entertainment'),
    ('Event Decorations',             'event-decorations',             '🎈', 'events-entertainment'),
    ('Musical Instruments',           'musical-instruments',           '🎸', 'events-entertainment'),
    ('DJ & Sound Equipment',          'dj-sound-equipment',            '🎚️', 'events-entertainment'),
    ('Gifts & Souvenirs',             'gifts-souvenirs',               '🎁', 'events-entertainment'),
    ('Arts & Crafts',                 'arts-crafts',                   '🎨', 'events-entertainment'),
    ('Photography Services',          'photography-services',          '📸', 'events-entertainment'),
    ('Catering Supplies',             'catering-supplies',             '🍽️', 'events-entertainment'),
    ('Wedding Supplies',              'wedding-supplies',              '💒', 'events-entertainment'),
    ('Event Rentals',                 'event-rentals',                 '🪑', 'events-entertainment'),
    ('Live Bands & Performers',       'performers',                    '🎤', 'events-entertainment')
) AS v(name, slug, icon, business_slug)
LEFT JOIN business_categories bc ON bc.slug = v.business_slug
ON CONFLICT DO NOTHING;

-- ============================================================
--  6. BACKFILL EXISTING PRODUCTS
--  Map old free-text products.category values by exact name match.
-- ============================================================

UPDATE products p
SET product_category_id = pc.id
FROM product_categories pc
WHERE p.product_category_id IS NULL
  AND p.category IS NOT NULL
  AND LOWER(TRIM(p.category)) = LOWER(TRIM(pc.name));

-- ============================================================
--  7. VERIFY
-- ============================================================

DO $$
DECLARE
    total_categories INTEGER;
    generic_categories INTEGER;
    linked_to_business INTEGER;
BEGIN
    SELECT COUNT(*) INTO total_categories FROM product_categories;
    SELECT COUNT(*) INTO generic_categories FROM product_categories WHERE business_category_id IS NULL;
    SELECT COUNT(*) INTO linked_to_business FROM product_categories WHERE business_category_id IS NOT NULL;
    RAISE NOTICE 'product_categories total: %', total_categories;
    RAISE NOTICE 'generic (all businesses): %', generic_categories;
    RAISE NOTICE 'linked to a business category: %', linked_to_business;
END $$;