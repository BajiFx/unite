// ============================================================
//  BUSINESSES ROUTES - Public Marketplace COMPLETE
//  Location: src/routes/businesses.js
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const Business = require('../models/Business');
const router = express.Router();

function productFallbackImage(name) {
    const label = String(name || 'Product').slice(0, 32).replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${label}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const LOCATION_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area', 'postal_code'];
const locationSql = LOCATION_FIELDS.map(field => `COALESCE(b.${field}, '')`).join(", ' ', ");

// These routes intentionally precede /:slug so words such as "nearby" are not
// treated as business slugs.
router.get('/locations/distinct', async (req, res) => {
    try {
        const field = String(req.query.field || 'county');
        if (!LOCATION_FIELDS.includes(field)) {
            return res.status(400).json({ error: 'Invalid location field' });
        }
        const result = await pool.query(`
            SELECT ${field} AS value, COUNT(*)::int AS business_count
            FROM businesses
            WHERE is_active = true AND NULLIF(BTRIM(${field}), '') IS NOT NULL
            GROUP BY ${field}
            ORDER BY business_count DESC, value ASC
        `);
        res.json({ field, locations: result.rows });
    } catch (err) {
        logError(err, 'Get distinct business locations');
        res.status(500).json({ error: 'Unable to load locations' });
    }
});

router.get('/filter', async (req, res) => {
    try {
        const values = [];
        const conditions = ['b.is_active = true'];
        for (const field of LOCATION_FIELDS) {
            if (req.query[field]) {
                values.push(`%${String(req.query[field]).trim()}%`);
                conditions.push(`b.${field} ILIKE $${values.length}`);
            }
        }
        const result = await pool.query(`SELECT b.* FROM businesses b WHERE ${conditions.join(' AND ')} ORDER BY b.business_name`, values);
        res.json({ businesses: result.rows });
    } catch (err) {
        logError(err, 'Filter businesses by location');
        res.status(500).json({ error: 'Unable to filter businesses' });
    }
});

router.get('/nearby', async (req, res) => {
    try {
        const latitude = Number(req.query.latitude);
        const longitude = Number(req.query.longitude);
        const radiusKm = Math.min(Math.max(Number(req.query.radius || 10), 1), 200);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ error: 'Valid latitude and longitude are required' });
        }
        const result = await pool.query(`
            SELECT b.*, 6371 * acos(LEAST(1, GREATEST(-1,
              cos(radians($1)) * cos(radians(b.latitude::numeric)) *
              cos(radians(b.longitude::numeric) - radians($2)) +
              sin(radians($1)) * sin(radians(b.latitude::numeric))
            ))) AS distance_km
            FROM businesses b
            WHERE b.is_active = true
              AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
              AND b.latitude ~ '^-?[0-9]+(\\.[0-9]+)?$'
              AND b.longitude ~ '^-?[0-9]+(\\.[0-9]+)?$'
            ORDER BY distance_km ASC
        `, [latitude, longitude]);
        res.json({ radius_km: radiusKm, businesses: result.rows.filter(row => Number(row.distance_km) <= radiusKm) });
    } catch (err) {
        logError(err, 'Get nearby businesses');
        res.status(500).json({ error: 'Unable to find nearby businesses' });
    }
});

router.get('/ads', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.*, b.business_name, b.slug, b.logo
            FROM business_ads a JOIN businesses b ON b.id = a.business_id
            WHERE a.is_active = true AND b.is_active = true
            ORDER BY a.created_at DESC
        `);
        res.json({ ads: result.rows });
    } catch (err) {
        logError(err, 'Get marketplace ads');
        res.status(500).json({ error: 'Unable to load ads' });
    }
});

router.post('/ads/:id/view', async (req, res) => {
    try {
        await pool.query(`UPDATE business_ads SET views = views + 1, click_through_rate = CASE WHEN views + 1 = 0 THEN 0 ELSE ROUND((clicks::numeric / (views + 1)) * 100, 2) END, updated_at = NOW() WHERE id = $1 AND is_active = true`, [req.params.id]);
        res.status(204).end();
    } catch (err) { res.status(500).json({ error: 'Unable to record ad view' }); }
});

router.post('/ads/:id/click', async (req, res) => {
    try {
        const result = await pool.query(`UPDATE business_ads SET clicks = clicks + 1, click_through_rate = CASE WHEN views = 0 THEN 0 ELSE ROUND(((clicks + 1)::numeric / views) * 100, 2) END, updated_at = NOW() WHERE id = $1 AND is_active = true RETURNING link_type, link_target_id, business_id`, [req.params.id]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Ad not found' });
        res.json({ success: true, ad: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Unable to record ad click' }); }
});

// ============================================================
//  GET ALL BUSINESSES (Public)
// ============================================================

router.get('/', async (req, res) => {
    try {
        const { search, category, featured, verified, sort, limit = 20, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
                   (SELECT delivery_enabled FROM businesses WHERE id = b.id) as delivery_enabled,
                   b.online_orders_enabled
            FROM businesses b
            WHERE b.is_active = true
        `;
        const params = [];
        const conditions = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(b.business_name ILIKE $${paramIndex} OR b.description ILIKE $${paramIndex} OR CONCAT_WS(' ', ${locationSql}) ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (featured === 'true') {
            conditions.push(`b.is_featured = true`);
        }

        if (verified === 'true') {
            conditions.push(`b.is_verified = true`);
        }

        if (category && category !== 'all') {
            conditions.push(`EXISTS (
                SELECT 1 FROM business_category_assignments bca
                WHERE bca.business_id = b.id AND bca.category_id = $${paramIndex}
            )`);
            params.push(parseInt(category));
            paramIndex++;
        }

        if (conditions.length > 0) {
            query += ' AND ' + conditions.join(' AND ');
        }

        let orderBy = 'b.created_at DESC';
        if (sort === 'popular') {
            orderBy = 'product_count DESC, b.created_at DESC';
        } else if (sort === 'rating') {
            orderBy = 'avg_rating DESC, b.created_at DESC';
        }

        query += ` ORDER BY ${orderBy}`;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        let countQuery = `SELECT COUNT(*) FROM businesses b WHERE b.is_active = true`;
        const countParams = [];
        let countIndex = 1;

        if (search) {
            countQuery += ` AND (b.business_name ILIKE $${countIndex} OR b.description ILIKE $${countIndex} OR CONCAT_WS(' ', ${locationSql}) ILIKE $${countIndex})`;
            countParams.push(`%${search}%`);
            countIndex++;
        }
        if (featured === 'true') {
            countQuery += ` AND b.is_featured = true`;
        }
        if (verified === 'true') {
            countQuery += ` AND b.is_verified = true`;
        }
        if (category && category !== 'all') {
            countQuery += ` AND EXISTS (
                SELECT 1 FROM business_category_assignments bca
                WHERE bca.business_id = b.id AND bca.category_id = $${countIndex}
            )`;
            countParams.push(parseInt(category));
            countIndex++;
        }

        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count);

        res.json({
            businesses: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('❌ Get businesses error:', err);
        logError(err, 'Get businesses');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS BY SLUG (Public)
// ============================================================

router.get('/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        console.log('📊 Fetching business by slug:', slug);

        if (!slug || slug === '') {
            return res.status(400).json({ error: 'Invalid business slug' });
        }

        const result = await pool.query(`
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
                   (SELECT delivery_enabled FROM businesses WHERE id = b.id) as delivery_enabled
            FROM businesses b
            WHERE b.slug = $1 AND b.is_active = true
        `, [slug]);

        const business = result.rows[0];

        if (!business) {
            console.log('❌ Business not found for slug:', slug);
            return res.status(404).json({ error: 'Business not found' });
        }

        console.log('✅ Business found:', business.business_name);

        const categoriesResult = await pool.query(`
            SELECT c.*
            FROM business_categories c
            JOIN business_category_assignments bca ON bca.category_id = c.id
            WHERE bca.business_id = $1
            ORDER BY c.name
        `, [business.id]);

        const statsResult = await pool.query(`
            SELECT * FROM business_stats WHERE business_id = $1
        `, [business.id]);

        const deliverySettings = await Business.getDeliverySettings(business.id);

        res.json({
            business: business,
            categories: categoriesResult.rows,
            stats: statsResult.rows[0] || {},
            delivery: deliverySettings || {}
        });
    } catch (err) {
        console.error('❌ Get business error:', err);
        logError(err, 'Get business by slug');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS ORDER SETTINGS (Public) - FIX: ADDED ENDPOINT
// ============================================================

router.get('/:slug/order-settings', async (req, res) => {
    try {
        const { slug } = req.params;

        const result = await pool.query(`
            SELECT
                online_orders_enabled,
                show_cart_when_disabled,
                order_disabled_message,
                order_regions,
                order_cutoff_time,
                order_processing_time,
                auto_cancel_hours,
                auto_complete_days,
                replacement_hours,
                status_pending,
                status_pending_payment,
                status_confirmed,
                status_shipped,
                status_delivered,
                status_received,
                status_cancelled,
                status_completed,
                return_policy,
                return_window_days
            FROM businesses
            WHERE slug = $1 AND is_active = true
        `, [slug]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('❌ Get business order settings error:', err);
        logError(err, 'Get business order settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS DELIVERY SETTINGS (Public)
// ============================================================

router.get('/:slug/delivery', async (req, res) => {
    try {
        const { slug } = req.params;
        const business = await Business.findBySlug(slug);
        if (!business) {
            return res.status(404).json({ error: 'Business not found' });
        }
        const settings = await Business.getDeliverySettings(business.id);
        res.json({
            business_id: business.id,
            business_name: business.business_name,
            delivery_enabled: settings?.delivery_enabled || false,
            delivery_offered: settings?.delivery_offered || 'no',
            delivery_free: settings?.delivery_free || 'no',
            delivery_free_where: settings?.delivery_free_where || 'everywhere',
            delivery_no_message: settings?.delivery_no_message || null,
            delivery_free_message: settings?.delivery_free_message || null,
            delivery_paid_message: settings?.delivery_paid_message || null,
            delivery_areas: settings?.delivery_areas || [],
            delivery_fee_type: settings?.delivery_fee_type || 'fixed',
            delivery_fee_fixed: parseFloat(settings?.delivery_fee_fixed) || 0,
            delivery_fee_per_km: parseFloat(settings?.delivery_fee_per_km) || 0,
            delivery_min_order_free: parseFloat(settings?.delivery_min_order_free) || 0,
            delivery_max_distance_km: parseInt(settings?.delivery_max_distance_km) || 50,
            delivery_days: settings?.delivery_days || ['mon','tue','wed','thu','fri','sat'],
            delivery_time_windows: settings?.delivery_time_windows || [],
            delivery_time_slots: settings?.delivery_time_slots || ['morning', 'afternoon'],
            delivery_cutoff_time: settings?.delivery_cutoff_time || '14:00',
            delivery_estimated_time: settings?.delivery_estimated_time || 'Same day (orders before 2pm)',
            delivery_policy: settings?.delivery_policy || null,
            meeting_points: settings?.meeting_points || [],
            latitude: business.latitude,
            longitude: business.longitude
        });
    } catch (err) {
        console.error('❌ Get delivery settings error:', err);
        logError(err, 'Get delivery settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS PAYMENT SETTINGS (Public)
// ============================================================

router.get('/:slug/payment-settings', async (req, res) => {
    try {
        const { slug } = req.params;

        const result = await pool.query(
            `SELECT
                mpesa_enabled, mpesa_number,
                airtel_enabled, airtel_number,
                bank_enabled, bank_name, bank_account, bank_account_name,
                paypal_enabled, paypal_email
             FROM businesses
             WHERE slug = $1 AND is_active = true`,
            [slug]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('❌ Get business payment settings error:', err);
        logError(err, 'Get payment settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS STATUS (Public)
// ============================================================

router.get('/:slug/status', async (req, res) => {
    try {
        const { slug } = req.params;

        const result = await pool.query(
            `SELECT online_orders_enabled, is_active
             FROM businesses
             WHERE slug = $1`,
            [slug]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        res.json({
            online_orders_enabled: result.rows[0].online_orders_enabled !== false,
            show_cart_when_disabled: result.rows[0].show_cart_when_disabled === true,
            order_disabled_message: result.rows[0].order_disabled_message || 'This business is not currently accepting online orders. Please contact us directly.',
            is_active: result.rows[0].is_active !== false
        });
    } catch (err) {
        console.error('❌ Get business status error:', err);
        logError(err, 'Get business status');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CALCULATE DELIVERY FEE (Public)
// ============================================================

router.post('/:slug/calculate-delivery', async (req, res) => {
    try {
        const { slug } = req.params;
        const { customerLat, customerLng, subtotal } = req.body;

        const business = await Business.findBySlug(slug);
        if (!business) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const result = await Business.calculateDeliveryFee(
            business.id,
            customerLat,
            customerLng,
            subtotal
        );

        res.json(result);
    } catch (err) {
        console.error('❌ Calculate delivery error:', err);
        logError(err, 'Calculate delivery');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS PRODUCTS (Public)
// ============================================================

router.get('/:slug/products', async (req, res) => {
    try {
        const { slug } = req.params;
        const { search, category } = req.query;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const offset = (page - 1) * limit;

        const businessResult = await pool.query(
            'SELECT id, online_orders_enabled FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const businessId = businessResult.rows[0].id;
        const onlineOrdersEnabled = businessResult.rows[0].online_orders_enabled !== false;

        let query = `
            SELECT p.*
            FROM products p
            WHERE p.business_id = $1 AND p.is_active = true
        `;
        const params = [businessId];
        let paramIndex = 2;

        if (search) {
            query += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (category && category !== 'all') {
            query += ` AND p.category = $${paramIndex}`;
            params.push(category);
            paramIndex++;
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);
        const countResult = await pool.query(
            'SELECT COUNT(*)::int AS total FROM products WHERE business_id = $1 AND is_active = true',
            [businessId]
        );

        const products = [];
        for (const product of result.rows) {
            const variantsResult = await pool.query(
                'SELECT * FROM product_variants WHERE product_id = $1 ORDER BY id',
                [product.id]
            );
            const firstVariantWithImage = variantsResult.rows.find(variant => variant.image);
            products.push({
                ...product,
                variants: variantsResult.rows || [],
                image: product.image || firstVariantWithImage?.image || productFallbackImage(product.name),
                online_orders_enabled: onlineOrdersEnabled
            });
        }

        res.json({
            products: products,
            business: {
                id: businessId,
                slug: slug,
                online_orders_enabled: onlineOrdersEnabled
            },
            pagination: {
                page,
                limit,
                total: countResult.rows[0].total,
                pages: Math.ceil(countResult.rows[0].total / limit)
            }
        });
    } catch (err) {
        console.error('❌ Get business products error:', err);
        logError(err, 'Get business products');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS REVIEWS (Public)
// ============================================================

router.get('/:slug/reviews', async (req, res) => {
    try {
        const { slug } = req.params;
        const { limit = 20 } = req.query;

        const businessResult = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const result = await pool.query(`
            SELECT br.*, c.name AS customer_name
            FROM business_reviews br
            JOIN customers c ON br.customer_id = c.id
            WHERE br.business_id = $1
            ORDER BY br.created_at DESC
            LIMIT $2
        `, [businessResult.rows[0].id, parseInt(limit)]);

        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get business reviews error:', err);
        logError(err, 'Get business reviews');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  ADD BUSINESS REVIEW (Customer)
// ============================================================

router.post('/:slug/review', authMiddleware, [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
    body('review_text').optional().trim().escape()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    if (req.role !== 'customer') {
        return res.status(403).json({ error: 'Only customers can write reviews.' });
    }

    try {
        const { slug } = req.params;
        const { rating, review_text } = req.body;

        const businessResult = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const businessId = businessResult.rows[0].id;

        const orderCheck = await pool.query(
            'SELECT id FROM orders WHERE customer_id = $1 AND business_id = $2 AND status IN ($3, $4, $5)',
            [req.userId, businessId, 'delivered', 'received', 'completed']
        );

        if (orderCheck.rows.length === 0) {
            return res.status(400).json({ error: 'You must have completed an order with this business to review it' });
        }

        const result = await pool.query(`
            INSERT INTO business_reviews (business_id, customer_id, rating, review_text)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (business_id, customer_id)
            DO UPDATE SET rating = $3, review_text = $4, created_at = NOW()
            RETURNING *
        `, [businessId, req.userId, rating, review_text]);

        res.json({ success: true, review: result.rows[0] });
    } catch (err) {
        console.error('❌ Add business review error:', err);
        logError(err, 'Add business review');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  FOLLOW/UNFOLLOW BUSINESS (Customer)
// ============================================================

router.post('/:slug/follow', authMiddleware, async (req, res) => {
    try {
        const { slug } = req.params;

        if (req.role !== 'customer') {
            return res.status(403).json({ error: 'Only customers can follow businesses.' });
        }

        const businessResult = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const businessId = businessResult.rows[0].id;

        const existing = await pool.query(
            'SELECT 1 FROM business_followers WHERE business_id = $1 AND customer_id = $2',
            [businessId, req.userId]
        );

        let action;
        if (existing.rows.length > 0) {
            await pool.query(
                'DELETE FROM business_followers WHERE business_id = $1 AND customer_id = $2',
                [businessId, req.userId]
            );
            action = 'unfollowed';
        } else {
            await pool.query(
                'INSERT INTO business_followers (business_id, customer_id) VALUES ($1, $2)',
                [businessId, req.userId]
            );
            action = 'followed';
        }

        res.json({ success: true, action });
    } catch (err) {
        console.error('❌ Follow business error:', err);
        logError(err, 'Follow business');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHECK FOLLOW STATUS (Customer)
// ============================================================

router.get('/:slug/follow-status', authMiddleware, async (req, res) => {
    try {
        const { slug } = req.params;

        if (req.role !== 'customer') {
            return res.status(403).json({ error: 'Only customers can check follow status.' });
        }

        const businessResult = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const result = await pool.query(
            'SELECT 1 FROM business_followers WHERE business_id = $1 AND customer_id = $2',
            [businessResult.rows[0].id, req.userId]
        );

        res.json({ isFollowing: result.rows.length > 0 });
    } catch (err) {
        console.error('❌ Follow status error:', err);
        logError(err, 'Follow status');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS STATS (Public)
// ============================================================

router.get('/:slug/stats', async (req, res) => {
    try {
        const { slug } = req.params;

        const businessResult = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const result = await pool.query(
            'SELECT * FROM business_stats WHERE business_id = $1',
            [businessResult.rows[0].id]
        );

        res.json(result.rows[0] || {});
    } catch (err) {
        console.error('❌ Get business stats error:', err);
        logError(err, 'Get business stats');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET ALL CATEGORIES (Public)
// ============================================================

router.get('/categories/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT * FROM business_categories ORDER BY name
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get categories error:', err);
        logError(err, 'Get categories');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET FEATURED BUSINESSES (Public)
// ============================================================

router.get('/featured/all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating
            FROM businesses b
            WHERE b.is_active = true AND b.is_featured = true
            ORDER BY b.created_at DESC
            LIMIT 10
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get featured businesses error:', err);
        logError(err, 'Get featured businesses');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESSES BY CATEGORY (Public)
// ============================================================

router.get('/category/:categoryId', async (req, res) => {
    try {
        const categoryId = parseInt(req.params.categoryId);
        const { limit = 20, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(`
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating
            FROM businesses b
            JOIN business_category_assignments bca ON bca.business_id = b.id
            WHERE bca.category_id = $1 AND b.is_active = true
            ORDER BY b.created_at DESC
            LIMIT $2 OFFSET $3
        `, [categoryId, parseInt(limit), parseInt(offset)]);

        const countResult = await pool.query(`
            SELECT COUNT(*)
            FROM businesses b
            JOIN business_category_assignments bca ON bca.business_id = b.id
            WHERE bca.category_id = $1 AND b.is_active = true
        `, [categoryId]);

        res.json({
            businesses: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult.rows[0].count)
            }
        });
    } catch (err) {
        console.error('❌ Get businesses by category error:', err);
        logError(err, 'Get businesses by category');
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
