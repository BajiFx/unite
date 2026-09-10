-- ============================================================
-- MULTI-VENDOR DATABASE SCHEMA - COMPLETE
-- Run this entire script in your PostgreSQL database
-- ============================================================

-- ============================================================
-- 1. CORE TABLES
-- ============================================================

-- Admin users (business owners and super admin)
CREATE TABLE IF NOT EXISTS admin_users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'business_admin',
    business_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);

-- Businesses (replaces shop)
CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    business_name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) UNIQUE NOT NULL,
    owner_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
    location VARCHAR(255) DEFAULT 'Nairobi, Kenya',
    address TEXT,
    latitude VARCHAR(50),
    longitude VARCHAR(50),
    description TEXT,
    mission TEXT,
    vision TEXT,
    logo VARCHAR(500),
    heroImage VARCHAR(500),
    whatsapp VARCHAR(50),
    tiktok VARCHAR(100),
    instagram VARCHAR(100),
    facebook VARCHAR(100),
    phone VARCHAR(50),
    email VARCHAR(255),
    website VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    is_verified BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    mpesa_enabled BOOLEAN DEFAULT FALSE,
    mpesa_number VARCHAR(50),
    airtel_enabled BOOLEAN DEFAULT FALSE,
    airtel_number VARCHAR(50),
    bank_enabled BOOLEAN DEFAULT FALSE,
    bank_name VARCHAR(100),
    bank_account VARCHAR(100),
    bank_account_name VARCHAR(100),
    paypal_enabled BOOLEAN DEFAULT FALSE,
    paypal_email VARCHAR(100),
    shipping_policy TEXT,
    return_policy TEXT,
    terms_policy TEXT,
    privacy_policy TEXT,
    delivery_enabled BOOLEAN DEFAULT TRUE,
    online_orders_enabled BOOLEAN DEFAULT TRUE,
    location_sharing_enabled BOOLEAN DEFAULT FALSE,
    admin_lat VARCHAR(50),
    admin_lng VARCHAR(50),
    -- Delivery settings (simplified)
    delivery_offered VARCHAR(10) DEFAULT 'no',
    delivery_free VARCHAR(10) DEFAULT 'no',
    delivery_free_where VARCHAR(20) DEFAULT 'everywhere',
    delivery_no_message TEXT,
    delivery_free_message TEXT,
    delivery_paid_message TEXT,
    delivery_areas JSONB DEFAULT '[]',
    delivery_fee_type VARCHAR(20) DEFAULT 'fixed',
    delivery_fee_fixed DECIMAL(10,2) DEFAULT 0,
    delivery_fee_per_km DECIMAL(10,2) DEFAULT 0,
    delivery_min_order_free DECIMAL(10,2) DEFAULT 0,
    delivery_max_distance_km INT DEFAULT 50,
    delivery_days JSONB DEFAULT '["mon","tue","wed","thu","fri","sat"]',
    delivery_time_slots JSONB DEFAULT '["morning","afternoon"]',
    delivery_cutoff_time VARCHAR(10) DEFAULT '14:00',
    delivery_estimated_time VARCHAR(100) DEFAULT 'Same day (orders before 2pm)',
    delivery_policy TEXT,
    meeting_points JSONB DEFAULT '[]',
    -- Order settings
    order_regions TEXT,
    order_cutoff_time VARCHAR(10) DEFAULT '14:00',
    order_processing_time VARCHAR(100) DEFAULT '1-2 hours',
    auto_cancel_hours INT DEFAULT 24,
    auto_complete_days INT DEFAULT 7,
    replacement_hours INT DEFAULT 6,
    status_pending TEXT DEFAULT '📋 Your order is being reviewed.',
    status_pending_payment TEXT DEFAULT '⏳ Awaiting payment confirmation.',
    status_confirmed TEXT DEFAULT '✅ Your order is confirmed and being prepared.',
    status_shipped TEXT DEFAULT '🚚 Your order is on the way!',
    status_delivered TEXT DEFAULT '📦 Your order is ready for pickup. Please collect within 7 working days.',
    status_received TEXT DEFAULT '✔️ You have confirmed receipt. Thank you!',
    status_cancelled TEXT DEFAULT '❌ This order has been cancelled.',
    status_completed TEXT DEFAULT '✅ Order completed. Thank you for shopping!',
    return_window_days INT DEFAULT 14,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products
CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price VARCHAR(50) NOT NULL,
    old_price VARCHAR(50),
    discount_percent VARCHAR(10),
    category VARCHAR(100),
    contact VARCHAR(100),
    rating VARCHAR(50),
    badge1 VARCHAR(100),
    badge2 VARCHAR(100),
    shipping VARCHAR(255),
    isFlashSale BOOLEAN DEFAULT FALSE,
    isNewArrival BOOLEAN DEFAULT FALSE,
    image VARCHAR(500),
    video VARCHAR(500),
    description TEXT,
    shipping_fee DECIMAL(10,2),
    free_shipping_eligible BOOLEAN DEFAULT FALSE,
    return_enabled BOOLEAN DEFAULT TRUE,
    return_window_days INTEGER DEFAULT 14,
    restocking_fee_percent DECIMAL(5,2) DEFAULT 0,
    return_shipping_paid_by VARCHAR(20) DEFAULT 'buyer',
    return_condition VARCHAR(50) DEFAULT 'unopened',
    stock INTEGER DEFAULT 0,
    is_featured BOOLEAN DEFAULT false,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Product Variants
CREATE TABLE IF NOT EXISTS product_variants (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2),
    stock INTEGER DEFAULT 0,
    sku VARCHAR(100),
    attributes JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    color_code VARCHAR(20),
    image VARCHAR(500)
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    total DECIMAL(10,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    order_ref VARCHAR(20) UNIQUE,
    status_history JSONB DEFAULT '[]',
    order_notes TEXT,
    shipping_tier VARCHAR(20) DEFAULT 'standard',
    shipping_cost DECIMAL(10,2) DEFAULT 0,
    shipping_tier_reason TEXT,
    cancelled_at TIMESTAMP,
    cancelled_by VARCHAR(50),
    delivery_location JSONB,
    estimated_delivery_days INTEGER,
    refund_request TEXT,
    refund_status VARCHAR(20) DEFAULT 'none',
    replacement_request JSONB,
    replacement_status VARCHAR(20) DEFAULT 'none',
    replacement_diff DECIMAL(10,2),
    replacement_payment_status VARCHAR(20) DEFAULT 'none',
    replacement_payment_method VARCHAR(50),
    replacement_payment_details JSONB,
    replacement_payment_date TIMESTAMP,
    replacement_refund_status VARCHAR(20) DEFAULT 'none',
    urgent_delivery BOOLEAN DEFAULT FALSE,
    delivery_location_name TEXT,
    address_id INTEGER,
    promo_code VARCHAR(50),
    discount_applied DECIMAL(10,2) DEFAULT 0,
    payment_status VARCHAR(20) DEFAULT 'pending',
    recipient_name VARCHAR(100),
    recipient_phone VARCHAR(50),
    delivery_address TEXT,
    delivery_instructions TEXT,
    customer_lat VARCHAR(50),
    customer_lng VARCHAR(50),
    location_accuracy VARCHAR(20),
    location_detected_at TIMESTAMP,
    completed_at TIMESTAMP,
    tracking_number VARCHAR(100),
    shipped_at TIMESTAMP,
    delivered_at TIMESTAMP,
    received_at TIMESTAMP,
    -- Delivery recording fields
    delivery_method VARCHAR(50) DEFAULT 'pickup',
    delivery_fee DECIMAL(10,2) DEFAULT 0,
    delivery_area VARCHAR(100),
    delivery_time_slot VARCHAR(50),
    delivery_phone VARCHAR(50),
    delivery_recipient_name VARCHAR(100),
    delivery_seller_message TEXT,
    delivery_code VARCHAR(20),
    delivery_chosen_at TIMESTAMP,
    delivery_confirmed_by_customer BOOLEAN DEFAULT FALSE,
    delivery_confirmed_by_seller BOOLEAN DEFAULT FALSE,
    delivery_confirmed_at TIMESTAMP,
    delivery_status VARCHAR(50) DEFAULT 'pending',
    delivery_notes TEXT,
    delivery_dispute BOOLEAN DEFAULT FALSE,
    delivery_dispute_reason TEXT,
    pickup_recipient_name VARCHAR(100),
    pickup_phone VARCHAR(50),
    pickup_code VARCHAR(20),
    pickup_chosen_at TIMESTAMP,
    pickup_confirmed_by_customer BOOLEAN DEFAULT FALSE,
    pickup_confirmed_by_seller BOOLEAN DEFAULT FALSE,
    pickup_confirmed_at TIMESTAMP,
    pickup_status VARCHAR(50) DEFAULT 'pending',
    chat_arranged_delivery BOOLEAN DEFAULT FALSE,
    chat_arranged_message TEXT,
    chat_arranged_at TIMESTAMP,
    chat_arranged_by VARCHAR(50),
    delivery_type VARCHAR(50) DEFAULT 'doorstep',
    pickup_station_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Order Items
CREATE TABLE IF NOT EXISTS order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    price VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    image VARCHAR(255),
    unique_id VARCHAR(50),
    variant_name VARCHAR(100) DEFAULT 'Default',
    variant_id INTEGER,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE
);

-- Payments
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    method VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    transaction_id VARCHAR(100),
    payment_details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Carts
CREATE TABLE IF NOT EXISTS carts (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    items JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reserved_until TIMESTAMP,
    UNIQUE(customer_id)
);

-- Customer Addresses
CREATE TABLE IF NOT EXISTS customer_addresses (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    label VARCHAR(50) NOT NULL,
    address TEXT NOT NULL,
    lat VARCHAR(50),
    lng VARCHAR(50),
    is_default BOOLEAN DEFAULT FALSE,
    location_name TEXT,
    address_type VARCHAR(50) DEFAULT 'doorstep',
    county_id INTEGER,
    sub_county_id INTEGER,
    ward_id INTEGER,
    pickup_station_id INTEGER,
    building_name VARCHAR(200),
    floor_room VARCHAR(100),
    road VARCHAR(200),
    estate VARCHAR(200),
    nearest_landmark VARCHAR(200),
    delivery_instructions TEXT,
    recipient_name VARCHAR(100),
    recipient_phone VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 2. COMMUNICATION TABLES
-- ============================================================

-- Public Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    from_user VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    customer_id INTEGER REFERENCES customers(id),
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE
);

-- Order Chat Messages
CREATE TABLE IF NOT EXISTS order_chat_messages (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    from_user VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 3. REVIEWS & RETURNS
-- ============================================================

-- Product Reviews
CREATE TABLE IF NOT EXISTS product_reviews (
    id SERIAL PRIMARY KEY,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    photos TEXT,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Returns
CREATE TABLE IF NOT EXISTS returns (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    reason VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending',
    photos TEXT,
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP,
    refund_amount DECIMAL(10,2),
    admin_notes TEXT
);

-- Business Reviews
CREATE TABLE IF NOT EXISTS business_reviews (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    review_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business_id, customer_id)
);

-- ============================================================
-- 4. BUSINESS SOCIAL & STATS
-- ============================================================

-- Business Followers
CREATE TABLE IF NOT EXISTS business_followers (
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id, customer_id)
);

-- Business Stats
CREATE TABLE IF NOT EXISTS business_stats (
    business_id INTEGER PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    total_orders INTEGER DEFAULT 0,
    total_revenue DECIMAL(10,2) DEFAULT 0,
    total_products INTEGER DEFAULT 0,
    total_followers INTEGER DEFAULT 0,
    average_rating DECIMAL(3,2) DEFAULT 0,
    total_reviews INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Business Categories
CREATE TABLE IF NOT EXISTS business_categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) UNIQUE NOT NULL,
    icon VARCHAR(50),
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Business-Category Assignment
CREATE TABLE IF NOT EXISTS business_category_assignments (
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES business_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (business_id, category_id)
);

-- ============================================================
-- 5. LOCATION & DELIVERY
-- ============================================================

-- Counties
CREATE TABLE IF NOT EXISTS counties (
    id SERIAL PRIMARY KEY,
    code VARCHAR(5) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sub-Counties
CREATE TABLE IF NOT EXISTS sub_counties (
    id SERIAL PRIMARY KEY,
    county_id INTEGER REFERENCES counties(id) ON DELETE CASCADE,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wards
CREATE TABLE IF NOT EXISTS wards (
    id SERIAL PRIMARY KEY,
    sub_county_id INTEGER REFERENCES sub_counties(id) ON DELETE CASCADE,
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pickup Stations
CREATE TABLE IF NOT EXISTS pickup_stations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    county_id INTEGER REFERENCES counties(id),
    sub_county_id INTEGER REFERENCES sub_counties(id),
    ward_id INTEGER REFERENCES wards(id),
    address TEXT,
    latitude DECIMAL(10,8),
    longitude DECIMAL(11,8),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(255),
    operating_hours TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Areas (for business-specific zones)
CREATE TABLE IF NOT EXISTS delivery_areas (
    id SERIAL PRIMARY KEY,
    business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    fee DECIMAL(10,2) DEFAULT 0,
    estimated_days INT DEFAULT 1,
    estimated_time VARCHAR(50) DEFAULT 'Same day',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Meeting Points
CREATE TABLE IF NOT EXISTS meeting_points (
    id SERIAL PRIMARY KEY,
    business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    address TEXT NOT NULL,
    lat VARCHAR(50),
    lng VARCHAR(50),
    contact_phone VARCHAR(50),
    operating_hours VARCHAR(200),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Logs
CREATE TABLE IF NOT EXISTS delivery_logs (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    driver_name VARCHAR(100),
    driver_phone VARCHAR(50),
    tracking_number VARCHAR(100),
    status VARCHAR(50) DEFAULT 'pending',
    assigned_at TIMESTAMP,
    picked_up_at TIMESTAMP,
    delivered_at TIMESTAMP,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Records (audit trail)
CREATE TABLE IF NOT EXISTS delivery_records (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
    delivery_method VARCHAR(50) NOT NULL,
    delivery_code VARCHAR(20),
    delivery_address TEXT,
    delivery_phone VARCHAR(50),
    delivery_recipient_name VARCHAR(100),
    delivery_instructions TEXT,
    delivery_fee DECIMAL(10,2) DEFAULT 0,
    delivery_seller_message TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    recorded_by VARCHAR(20) DEFAULT 'customer',
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    confirmed_by_customer BOOLEAN DEFAULT FALSE,
    confirmed_by_seller BOOLEAN DEFAULT FALSE,
    confirmed_at TIMESTAMP,
    notes TEXT,
    dispute BOOLEAN DEFAULT FALSE,
    dispute_reason TEXT,
    resolved_at TIMESTAMP,
    resolved_by VARCHAR(50)
);

-- ============================================================
-- 6. PROMO CODES & SYSTEM SETTINGS
-- ============================================================

-- Promo Codes
CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(10,2) NOT NULL,
    min_order_value DECIMAL(10,2) DEFAULT 0,
    expires_at TIMESTAMP,
    usage_limit INTEGER,
    used_count INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System Settings
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 7. OTHER TABLES
-- ============================================================

-- Admin Logs
CREATE TABLE IF NOT EXISTS admin_logs (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Location Requests
CREATE TABLE IF NOT EXISTS location_requests (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Wishlist
CREATE TABLE IF NOT EXISTS wishlist (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(customer_id, product_id)
);

-- Password Resets
CREATE TABLE IF NOT EXISTS password_resets (
    email VARCHAR(255) PRIMARY KEY,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    user_type VARCHAR(20) DEFAULT 'customer',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Bulk Shipping Rules (optional)
CREATE TABLE IF NOT EXISTS bulk_shipping_rules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    min_quantity INT NOT NULL DEFAULT 0,
    min_weight DECIMAL(10,2) DEFAULT 0,
    max_weight DECIMAL(10,2) DEFAULT 0,
    min_total DECIMAL(10,2) DEFAULT 0,
    shipping_fee DECIMAL(10,2) NOT NULL,
    free_shipping_eligible BOOLEAN DEFAULT false,
    applies_to_categories TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Migrations tracking
CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- 8. INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders(business_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_business_id ON order_items(business_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_business_id ON products(business_id);
CREATE INDEX IF NOT EXISTS idx_carts_customer_id ON carts(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_business_id ON payments(business_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_business_id ON product_reviews(business_id);
CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id);
CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_business_id ON returns(business_id);
CREATE INDEX IF NOT EXISTS idx_order_chat_messages_order ON order_chat_messages(order_id);
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_wishlist_customer_product ON wishlist(customer_id, product_id);
CREATE INDEX IF NOT EXISTS idx_location_requests_customer ON location_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_location_requests_status ON location_requests(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer_status ON orders(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_order_status ON payments(order_id, status);
CREATE INDEX IF NOT EXISTS idx_businesses_slug ON businesses(slug);
CREATE INDEX IF NOT EXISTS idx_businesses_is_active ON businesses(is_active);
CREATE INDEX IF NOT EXISTS idx_businesses_is_verified ON businesses(is_verified);
CREATE INDEX IF NOT EXISTS idx_businesses_owner_id ON businesses(owner_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_customers_username ON customers(username);
CREATE INDEX IF NOT EXISTS idx_business_reviews_business_id ON business_reviews(business_id);
CREATE INDEX IF NOT EXISTS idx_business_followers_business_id ON business_followers(business_id);
CREATE INDEX IF NOT EXISTS idx_delivery_areas_business ON delivery_areas(business_id);
CREATE INDEX IF NOT EXISTS idx_meeting_points_business ON meeting_points(business_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_order ON delivery_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_business ON delivery_logs(business_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_method ON orders(delivery_method);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_code ON orders(delivery_code);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
CREATE INDEX IF NOT EXISTS idx_orders_pickup_status ON orders(pickup_status);
CREATE INDEX IF NOT EXISTS idx_delivery_records_order ON delivery_records(order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_records_customer ON delivery_records(customer_id);
CREATE INDEX IF NOT EXISTS idx_delivery_records_business ON delivery_records(business_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_business_id ON chat_messages(business_id);

-- ============================================================
-- 9. SEED DATA
-- ============================================================

-- Default system settings
INSERT INTO system_settings (key, value) VALUES
    ('replacement_hours', '6'),
    ('auto_cancel_hours', '24'),
    ('auto_complete_days', '7'),
    ('free_shipping_threshold', '40000')
ON CONFLICT (key) DO NOTHING;

-- Default business categories
INSERT INTO business_categories (name, slug, icon, description) VALUES
    ('Fashion', 'fashion', '👗', 'Clothing, shoes, and accessories'),
    ('Hardware', 'hardware', '🔧', 'Building materials and tools'),
    ('Electronics', 'electronics', '📱', 'Phones, computers, and gadgets'),
    ('Food', 'food', '🍕', 'Restaurants, groceries, and catering'),
    ('Home', 'home', '🏠', 'Furniture, decor, and appliances'),
    ('Health', 'health', '💊', 'Pharmacy, fitness, and wellness'),
    ('Beauty', 'beauty', '💄', 'Cosmetics and personal care'),
    ('Books', 'books', '📚', 'Books, stationery, and office supplies'),
    ('Sports', 'sports', '⚽', 'Sports equipment and apparel'),
    ('Automotive', 'automotive', '🚗', 'Car parts and accessories'),
    ('Services', 'services', '🛠️', 'Professional and personal services'),
    ('Other', 'other', '📦', 'Other products and services')
ON CONFLICT (name) DO NOTHING;

-- Counties (all 47)
INSERT INTO counties (code, name) VALUES
    ('001', 'Mombasa'),
    ('002', 'Kwale'),
    ('003', 'Kilifi'),
    ('004', 'Tana River'),
    ('005', 'Lamu'),
    ('006', 'Taita Taveta'),
    ('007', 'Garissa'),
    ('008', 'Wajir'),
    ('009', 'Mandera'),
    ('010', 'Marsabit'),
    ('011', 'Isiolo'),
    ('012', 'Meru'),
    ('013', 'Tharaka Nithi'),
    ('014', 'Embu'),
    ('015', 'Kitui'),
    ('016', 'Machakos'),
    ('017', 'Makueni'),
    ('018', 'Nyandarua'),
    ('019', 'Nyeri'),
    ('020', 'Kirinyaga'),
    ('021', 'Murang''a'),
    ('022', 'Kiambu'),
    ('023', 'Turkana'),
    ('024', 'West Pokot'),
    ('025', 'Samburu'),
    ('026', 'Trans Nzoia'),
    ('027', 'Uasin Gishu'),
    ('028', 'Elgeyo Marakwet'),
    ('029', 'Nandi'),
    ('030', 'Baringo'),
    ('031', 'Laikipia'),
    ('032', 'Nakuru'),
    ('033', 'Narok'),
    ('034', 'Kajiado'),
    ('035', 'Kericho'),
    ('036', 'Bomet'),
    ('037', 'Kakamega'),
    ('038', 'Vihiga'),
    ('039', 'Bungoma'),
    ('040', 'Busia'),
    ('041', 'Siaya'),
    ('042', 'Kisumu'),
    ('043', 'Homa Bay'),
    ('044', 'Migori'),
    ('045', 'Kisii'),
    ('046', 'Nyamira'),
    ('047', 'Nairobi')
ON CONFLICT (code) DO NOTHING;

-- Sub-counties for Nairobi (sample)
INSERT INTO sub_counties (county_id, code, name) VALUES
    ((SELECT id FROM counties WHERE code = '047'), '04701', 'Westlands'),
    ((SELECT id FROM counties WHERE code = '047'), '04702', 'Dagoretti North'),
    ((SELECT id FROM counties WHERE code = '047'), '04703', 'Dagoretti South'),
    ((SELECT id FROM counties WHERE code = '047'), '04704', 'Embakasi Central'),
    ((SELECT id FROM counties WHERE code = '047'), '04705', 'Embakasi East'),
    ((SELECT id FROM counties WHERE code = '047'), '04706', 'Embakasi North'),
    ((SELECT id FROM counties WHERE code = '047'), '04707', 'Embakasi South'),
    ((SELECT id FROM counties WHERE code = '047'), '04708', 'Embakasi West'),
    ((SELECT id FROM counties WHERE code = '047'), '04709', 'Kasarani'),
    ((SELECT id FROM counties WHERE code = '047'), '04710', 'Kibra'),
    ((SELECT id FROM counties WHERE code = '047'), '04711', 'Langata'),
    ((SELECT id FROM counties WHERE code = '047'), '04712', 'Makadara'),
    ((SELECT id FROM counties WHERE code = '047'), '04713', 'Mathare'),
    ((SELECT id FROM counties WHERE code = '047'), '04714', 'Roysambu'),
    ((SELECT id FROM counties WHERE code = '047'), '04715', 'Ruaraka'),
    ((SELECT id FROM counties WHERE code = '047'), '04716', 'Starehe'),
    ((SELECT id FROM counties WHERE code = '047'), '04717', 'Kamukunji')
ON CONFLICT (code) DO NOTHING;

-- Sub-counties for Mombasa
INSERT INTO sub_counties (county_id, code, name) VALUES
    ((SELECT id FROM counties WHERE code = '001'), '00101', 'Changamwe'),
    ((SELECT id FROM counties WHERE code = '001'), '00102', 'Jomvu'),
    ((SELECT id FROM counties WHERE code = '001'), '00103', 'Kisauni'),
    ((SELECT id FROM counties WHERE code = '001'), '00104', 'Nyali'),
    ((SELECT id FROM counties WHERE code = '001'), '00105', 'Likoni'),
    ((SELECT id FROM counties WHERE code = '001'), '00106', 'Mvita')
ON CONFLICT (code) DO NOTHING;

-- Sample pickup stations
INSERT INTO pickup_stations (name, county_id, sub_county_id, address, contact_phone, operating_hours) VALUES
    ('G4S Bondo', (SELECT id FROM counties WHERE code = '042'), (SELECT id FROM sub_counties WHERE code = '04201'), 'Bondo Pickup-G4S Bondo-Usenge Road Opp Equity Bank Siaya, Bondo', '736888403', 'Mon - Sat 09:00-18:00'),
    ('G4S Kisumu', (SELECT id FROM counties WHERE code = '042'), (SELECT id FROM sub_counties WHERE code = '04201'), 'Kisumu Pickup-G4S Kisumu-Off Oginga Odinga Road', '736888404', 'Mon - Sat 08:00-17:00'),
    ('G4S Nakuru', (SELECT id FROM counties WHERE code = '032'), (SELECT id FROM sub_counties WHERE code = '03201'), 'Nakuru Pickup-G4S Nakuru-Kenyatta Avenue', '736888405', 'Mon - Sat 09:00-18:00')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 10. TRIGGERS (optional: auto-update business_stats)
-- ============================================================

CREATE OR REPLACE FUNCTION update_business_stats()
RETURNS TRIGGER AS $$
DECLARE
    affected_business_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        affected_business_id := OLD.business_id;
    ELSE
        affected_business_id := NEW.business_id;
    END IF;
    UPDATE business_stats
    SET
        total_orders = (SELECT COUNT(*) FROM orders WHERE business_id = affected_business_id),
        total_revenue = (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = affected_business_id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')),
        total_products = (SELECT COUNT(*) FROM products WHERE business_id = affected_business_id AND is_active = true),
        total_followers = (SELECT COUNT(*) FROM business_followers WHERE business_id = affected_business_id),
        average_rating = (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = affected_business_id),
        total_reviews = (SELECT COUNT(*) FROM business_reviews WHERE business_id = affected_business_id),
        updated_at = NOW()
    WHERE business_id = affected_business_id;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_business_stats ON orders;
CREATE TRIGGER trigger_update_business_stats
AFTER INSERT OR UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION update_business_stats();

DROP TRIGGER IF EXISTS trigger_update_business_stats_products ON products;
CREATE TRIGGER trigger_update_business_stats_products
AFTER INSERT OR UPDATE OR DELETE ON products
FOR EACH ROW
EXECUTE FUNCTION update_business_stats();

DROP TRIGGER IF EXISTS trigger_update_business_stats_reviews ON business_reviews;
CREATE TRIGGER trigger_update_business_stats_reviews
AFTER INSERT OR UPDATE OR DELETE ON business_reviews
FOR EACH ROW
EXECUTE FUNCTION update_business_stats();

DROP TRIGGER IF EXISTS trigger_update_business_stats_followers ON business_followers;
CREATE TRIGGER trigger_update_business_stats_followers
AFTER INSERT OR DELETE ON business_followers
FOR EACH ROW
EXECUTE FUNCTION update_business_stats();

-- ============================================================
-- 11. VIEW (for easy business listing)
-- ============================================================

CREATE OR REPLACE VIEW business_list_view AS
SELECT
    b.*,
    (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
    (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
    (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
    (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
    (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue,
    (SELECT ARRAY(SELECT category_id FROM business_category_assignments WHERE business_id = b.id)) as category_ids
FROM businesses b
WHERE b.is_active = true;

-- ============================================================
-- 12. FINAL VERIFICATION
-- ============================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Multi-vendor database schema created successfully!';
END $$;
