// ============================================================
//  BUSINESS ADMIN ROUTES - COMPLETE WITH ALL SETTINGS
//  Location: src/routes/business-admin.js
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware, businessAdminOnly, getBusinessIdFromToken } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadToCloudinary } = require('../config/cloudinary');
const { appendOrderStatus, logAdminActivity } = require('../services/orderService');
const Business = require('../models/Business');
const router = express.Router();

const LOCATION_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area', 'postal_code'];

async function geocodeLocation(location) {
    const address = LOCATION_FIELDS.map(field => location[field]).filter(Boolean).join(', ');
    if (!address || typeof fetch !== 'function') return null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`, {
            headers: { 'User-Agent': 'BusinessMarketplace/1.0 (location update)' }, signal: controller.signal
        });
        clearTimeout(timer);
        const results = response.ok ? await response.json() : [];
        if (!results[0]) return null;
        return { latitude: results[0].lat, longitude: results[0].lon };
    } catch (error) {
        // Geocoding must never prevent an admin from saving their profile.
        console.warn('Location geocoding skipped:', error.message);
        return null;
    }
}

router.put('/location', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const location = Object.fromEntries(LOCATION_FIELDS.map(field => [field, typeof req.body[field] === 'string' ? req.body[field].trim() || null : undefined]));
        const suppliedFields = Object.entries(location).filter(([, value]) => value !== undefined);
        if (!suppliedFields.length) return res.status(400).json({ error: 'Provide at least one location field' });
        const current = await pool.query('SELECT * FROM businesses WHERE id = $1', [req.businessId]);
        if (!current.rows[0]) return res.status(404).json({ error: 'Business not found' });
        const fullLocation = { ...current.rows[0], ...Object.fromEntries(suppliedFields) };
        const geocoded = await geocodeLocation(fullLocation);
        const fields = suppliedFields.map(([field], index) => `${field} = $${index + 1}`);
        const values = suppliedFields.map(([, value]) => value);
        if (geocoded) {
            fields.push(`latitude = $${values.length + 1}`, `longitude = $${values.length + 2}`, `location_geocoded = true`);
            values.push(geocoded.latitude, geocoded.longitude);
        } else {
            fields.push('location_geocoded = false');
        }
        values.push(req.businessId);
        const result = await pool.query(`UPDATE businesses SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values);
        res.json({ success: true, business: result.rows[0], geocoded: Boolean(geocoded), warning: geocoded ? undefined : 'Saved, but the address could not be geocoded.' });
    } catch (err) {
        logError(err, 'Update business location');
        res.status(500).json({ error: 'Unable to update location' });
    }
});

router.get('/ads', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT *, CASE WHEN views > 0 THEN ROUND((clicks::numeric / views) * 100, 2) ELSE 0 END AS click_through_rate FROM business_ads WHERE business_id = $1 ORDER BY created_at DESC', [req.businessId]);
        res.json({ ads: result.rows });
    } catch (err) { res.status(500).json({ error: 'Unable to load ads' }); }
});

router.post('/ads', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const { media_type, media_url, title, description, link_type = 'profile', link_target_id, display_duration, is_active = true } = req.body;
        if (!['image', 'video'].includes(media_type) || !media_url) return res.status(400).json({ error: 'media_type (image or video) and media_url are required' });
        if (!['profile', 'product'].includes(link_type)) return res.status(400).json({ error: 'Invalid link type' });
        if (link_type === 'product' && !link_target_id) return res.status(400).json({ error: 'A product target is required' });
        const duration = Number(display_duration) || (media_type === 'video' ? 120 : 10);
        const result = await pool.query(`INSERT INTO business_ads (business_id, media_type, media_url, title, description, link_type, link_target_id, display_duration, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.businessId, media_type, media_url, title || null, description || null, link_type, link_target_id || null, duration, Boolean(is_active)]);
        await pool.query('UPDATE businesses SET ad_media_enabled = true WHERE id = $1', [req.businessId]);
        res.status(201).json({ success: true, ad: result.rows[0] });
    } catch (err) { logError(err, 'Create ad'); res.status(500).json({ error: 'Unable to create ad' }); }
});

router.put('/ads/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const permitted = ['media_type', 'media_url', 'title', 'description', 'link_type', 'link_target_id', 'display_duration', 'is_active'];
        const entries = permitted.filter(field => req.body[field] !== undefined).map(field => [field, req.body[field]]);
        if (!entries.length) return res.status(400).json({ error: 'No ad fields to update' });
        const result = await pool.query(`UPDATE business_ads SET ${entries.map(([field], i) => `${field} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${entries.length + 1} AND business_id = $${entries.length + 2} RETURNING *`, [...entries.map(([, value]) => value), req.params.id, req.businessId]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Ad not found' });
        res.json({ success: true, ad: result.rows[0] });
    } catch (err) { res.status(500).json({ error: 'Unable to update ad' }); }
});

router.delete('/ads/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM business_ads WHERE id = $1 AND business_id = $2 RETURNING id', [req.params.id, req.businessId]);
        if (!result.rows[0]) return res.status(404).json({ error: 'Ad not found' });
        res.status(204).end();
    } catch (err) { res.status(500).json({ error: 'Unable to delete ad' }); }
});

// ============================================================
//  GET BUSINESS PROFILE
// ============================================================

router.get('/profile', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('📊 Fetching business profile for ID:', req.businessId);

        const result = await pool.query(`
            SELECT b.*,
                (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                (SELECT COUNT(*) FROM orders WHERE business_id = b.id) as order_count,
                (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue
            FROM businesses b
            WHERE b.id = $1 AND b.is_active = true
        `, [req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const stats = await pool.query(
            'SELECT * FROM business_stats WHERE business_id = $1',
            [req.businessId]
        );

        // Also return the business's current category assignments so the form can
        // preselect them (needed for the "edit categories" flow).
        const categories = await pool.query(`
            SELECT c.id, c.name, c.slug, c.icon
            FROM business_categories c
            JOIN business_category_assignments bca ON bca.category_id = c.id
            WHERE bca.business_id = $1
            ORDER BY c.name
        `, [req.businessId]);

        res.json({
            business: result.rows[0],
            stats: stats.rows[0] || {},
            categories: categories.rows
        });
    } catch (err) {
        console.error('❌ Get business profile error:', err);
        logError(err, 'Get business profile');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  UPDATE BUSINESS PROFILE
// ============================================================

router.put('/profile', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
    upload.fields([{ name: 'logo' }, { name: 'heroImage' }]),
    async (req, res) => {
        try {
            let logo = req.body.logo;
            let heroImage = req.body.heroImage;

            if (req.files) {
                if (req.files.logo && req.files.logo[0]) {
                    try {
                        logo = await uploadToCloudinary(req.files.logo[0].path, { folder: `business_shop/${req.businessId}/logos` });
                    } catch (err) {
                        console.error('Logo upload error:', err);
                    }
                }
                if (req.files.heroImage && req.files.heroImage[0]) {
                    try {
                        heroImage = await uploadToCloudinary(req.files.heroImage[0].path, { folder: `business_shop/${req.businessId}/hero` });
                    } catch (err) {
                        console.error('Hero image upload error:', err);
                    }
                }
            }

            const allowedFields = [
                'business_name', 'location', 'address', 'description',
                'mission', 'vision', 'whatsapp', 'tiktok', 'instagram',
                'facebook', 'linkedin', 'phone', 'website', 'email',
                'phone_numbers', 'email_addresses',
                'latitude', 'longitude'
            ];

            const fields = [];
            const values = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (req.body[field] !== undefined) {
                    fields.push(`${field} = $${paramIndex}`);
                    if (field === 'phone_numbers' || field === 'email_addresses') {
                        const entries = String(req.body[field] || '').split(/[,\n]/).map(value => value.trim()).filter(Boolean);
                        values.push(JSON.stringify(entries));
                    } else {
                        values.push(req.body[field]);
                    }
                    paramIndex++;
                }
            }

            if (logo) {
                fields.push(`logo = $${paramIndex}`);
                values.push(logo);
                paramIndex++;
            }
            if (heroImage) {
                fields.push(`heroImage = $${paramIndex}`);
                values.push(heroImage);
                paramIndex++;
            }

            if (fields.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            values.push(req.businessId);
            const query = `
                UPDATE businesses
                SET ${fields.join(', ')}, updated_at = NOW()
                WHERE id = $${paramIndex}
                RETURNING *
            `;

            const result = await pool.query(query, values);

            await logAdminActivity(req.userId, 'UPDATE_BUSINESS_PROFILE', { businessId: req.businessId });

            res.json({ success: true, business: result.rows[0] });
        } catch (err) {
            console.error('❌ Update business profile error:', err);
            logError(err, 'Update business profile');
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
//  GET BUSINESS PRODUCTS
// ============================================================

router.get('/products', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('📦 Fetching products for business ID:', req.businessId);

        const { search, category, limit = 50, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT p.*
            FROM products p
            WHERE p.business_id = $1 AND p.is_active = true
        `;
        const params = [req.businessId];
        let paramIndex = 2;

        if (search) {
            query += ` AND p.name ILIKE $${paramIndex}`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (category) {
            query += ` AND p.category = $${paramIndex}`;
            params.push(category);
            paramIndex++;
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get business products error:', err);
        logError(err, 'Get business products');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS ADMIN CATEGORIES
//  Returns the exact same shape as /api/businesses/categories/all
//  so the admin UI and the registration form share one source of truth.
// ============================================================

router.get('/categories', authMiddleware, businessAdminOnly, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                c.id,
                c.name,
                c.slug,
                c.icon,
                c.description,
                (SELECT COUNT(*)::int FROM business_category_assignments bca
                   JOIN businesses b ON b.id = bca.business_id
                   WHERE bca.category_id = c.id AND b.is_active = true) AS business_count
            FROM business_categories c
            ORDER BY c.name ASC
        `);
        res.json(result.rows);
    } catch (err) {
        logError(err, 'Get business admin categories');
        res.status(500).json({ error: 'Unable to load categories' });
    }
});

// ============================================================
//  SET / REPLACE BUSINESS CATEGORIES (assignment table)
// ============================================================

router.put('/categories', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    const categoryIds = [...new Set((Array.isArray(req.body.category_ids) ? req.body.category_ids : [])
        .map(Number).filter(Number.isInteger))];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (categoryIds.length) {
            const valid = await client.query('SELECT id FROM business_categories WHERE id = ANY($1::int[])', [categoryIds]);
            if (valid.rows.length !== categoryIds.length) throw new Error('One or more selected categories are invalid');
        }
        await client.query('DELETE FROM business_category_assignments WHERE business_id = $1', [req.businessId]);
        for (const categoryId of categoryIds) {
            await client.query('INSERT INTO business_category_assignments (business_id, category_id) VALUES ($1, $2)', [req.businessId, categoryId]);
        }
        await client.query('UPDATE businesses SET custom_category = NULL, updated_at = NOW() WHERE id = $1', [req.businessId]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message || 'Unable to save categories' });
    } finally {
        client.release();
    }
});

// ============================================================
//  ADD PRODUCT TO BUSINESS
// ============================================================

router.post('/products', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
    upload.fields([{ name: 'image', maxCount: 8 }, { name: 'video', maxCount: 4 }, { name: 'variantImages', maxCount: 20 }]),
    [
        body('name').notEmpty().withMessage('Product name required'),
        body('price').notEmpty().withMessage('Price required')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            let image = null;
            let video = null;

            const images = [];
            const videos = [];
            if (req.files) {
                for (const file of (req.files.image || [])) {
                    try {
                        const uploaded = await uploadToCloudinary(file.path, {
                            folder: `business_shop/${req.businessId}/products`
                        });
                        images.push(uploaded);
                        if (!image) image = uploaded;
                    } catch (err) {
                        console.error('Image upload error:', err);
                    }
                }
                for (const file of (req.files.video || [])) {
                    try {
                        const uploaded = await uploadToCloudinary(file.path, {
                            folder: `business_shop/${req.businessId}/products`,
                            resource_type: 'video'
                        });
                        videos.push(uploaded);
                        if (!video) video = uploaded;
                    } catch (err) {
                        console.error('Video upload error:', err);
                    }
                }
            }

            const {
                name, price, old_price, discount_percent, category, contact, rating,
                badge1, badge2, shipping, isFlashSale, isNewArrival,
                description, stock = 0, is_featured
            } = req.body;

            const result = await pool.query(`
                INSERT INTO products (
                    name, price, old_price, discount_percent, category, contact, rating,
                    badge1, badge2, shipping, isFlashSale, isNewArrival, image, video,
                    description, stock, business_id, is_active, images, videos
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                RETURNING *
            `, [
                name, price, old_price || null,
                discount_percent || null, category || null,
                contact || null, rating || null,
                badge1 || null, badge2 || null,
                shipping || null,
                isFlashSale === 'true' || isFlashSale === true,
                isNewArrival === 'true' || isNewArrival === true,
                image, video,
                description || null, parseInt(stock) || 0,
                req.businessId, true, JSON.stringify(images), JSON.stringify(videos)
            ]);

            const product = result.rows[0];

            await logAdminActivity(req.userId, 'ADD_PRODUCT', { productId: product.id, businessId: req.businessId });

            if (req.body.variants) {
                try {
                    const variants = JSON.parse(req.body.variants);
                    for (const v of variants) {
                        await pool.query(
                            `INSERT INTO product_variants (product_id, name, price, stock, color_code, image)
                             VALUES ($1, $2, $3, $4, $5, $6)`,
                            [product.id, v.name, v.price || null, v.stock || 0, v.color_code || null, v.image || null]
                        );
                    }
                } catch (variantErr) {
                    console.error('Error adding variants:', variantErr);
                }
            }

            res.status(201).json({ success: true, product });
        } catch (err) {
            console.error('❌ Add product error:', err);
            logError(err, 'Add product');
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
//  UPDATE PRODUCT
// ============================================================

router.put('/products/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
    upload.fields([{ name: 'image', maxCount: 8 }, { name: 'video', maxCount: 4 }, { name: 'variantImages', maxCount: 20 }]),
    async (req, res) => {
        try {
            const productId = parseInt(req.params.id);

            const productCheck = await pool.query(
                'SELECT * FROM products WHERE id = $1 AND business_id = $2',
                [productId, req.businessId]
            );

            if (productCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Product not found in your business' });
            }

            let image = productCheck.rows[0].image;
            let video = productCheck.rows[0].video;
            const images = Array.isArray(productCheck.rows[0].images) ? productCheck.rows[0].images : [];
            const videos = Array.isArray(productCheck.rows[0].videos) ? productCheck.rows[0].videos : [];

            if (req.files) {
                for (const file of (req.files.image || [])) {
                    try {
                        const uploaded = await uploadToCloudinary(file.path, {
                            folder: `business_shop/${req.businessId}/products`
                        });
                        images.push(uploaded);
                        image = uploaded;
                    } catch (err) {
                        console.error('Image upload error:', err);
                    }
                }
                for (const file of (req.files.video || [])) {
                    try {
                        const uploaded = await uploadToCloudinary(file.path, {
                            folder: `business_shop/${req.businessId}/products`,
                            resource_type: 'video'
                        });
                        videos.push(uploaded);
                        video = uploaded;
                    } catch (err) {
                        console.error('Video upload error:', err);
                    }
                }
            }

            const {
                name, price, old_price, discount_percent, category, contact, rating,
                badge1, badge2, shipping, isFlashSale, isNewArrival,
                description, stock, is_active, is_featured
            } = req.body;

            const result = await pool.query(`
                UPDATE products
                SET name = COALESCE($1, name),
                    price = COALESCE($2, price),
                    old_price = COALESCE($3, old_price),
                    discount_percent = COALESCE($4, discount_percent),
                    category = COALESCE($5, category),
                    contact = COALESCE($6, contact),
                    rating = COALESCE($7, rating),
                    badge1 = COALESCE($8, badge1),
                    badge2 = COALESCE($9, badge2),
                    shipping = COALESCE($10, shipping),
                    isFlashSale = COALESCE($11, isFlashSale),
                    isNewArrival = COALESCE($12, isNewArrival),
                    image = COALESCE($13, image),
                    video = COALESCE($14, video),
                    description = COALESCE($15, description),
                    stock = COALESCE($16, stock),
                    is_active = COALESCE($17, is_active),
                    is_featured = COALESCE($18, is_featured),
                    images = $19,
                    videos = $20
                WHERE id = $21 AND business_id = $22
                RETURNING *
            `, [
                name || null,
                price || null,
                old_price || null,
                discount_percent || null,
                category || null,
                contact || null,
                rating || null,
                badge1 || null,
                badge2 || null,
                shipping || null,
                isFlashSale === 'true' || isFlashSale === true,
                isNewArrival === 'true' || isNewArrival === true,
                image,
                video,
                description || null,
                parseInt(stock) || 0,
                is_active !== 'false',
                is_featured === 'true' || is_featured === true,
                JSON.stringify(images), JSON.stringify(videos), productId, req.businessId
            ]);

            await logAdminActivity(req.userId, 'UPDATE_PRODUCT', { productId, businessId: req.businessId });
            res.json({ success: true, product: result.rows[0] });
        } catch (err) {
            console.error('❌ Update product error:', err);
            logError(err, 'Update product');
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
//  DELETE PRODUCT
// ============================================================

router.delete('/products/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);

        const result = await pool.query(
            'DELETE FROM products WHERE id = $1 AND business_id = $2 RETURNING id',
            [productId, req.businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found in your business' });
        }

        await logAdminActivity(req.userId, 'DELETE_PRODUCT', { productId, businessId: req.businessId });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Delete product error:', err);
        logError(err, 'Delete product');
        res.status(500).json({ error: err.message });
    }
});

// Batch creation deliberately accepts the same fields as the normal form. Files are
// uploaded with individual products; this endpoint makes data-entry batches atomic.
router.post('/products/batch', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    const products = Array.isArray(req.body.products) ? req.body.products : [];
    if (!products.length || products.length > 100) return res.status(400).json({ error: 'Provide 1 to 100 products' });
    if (products.some(product => !String(product.name || '').trim() || product.price === undefined || product.price === '')) {
        return res.status(400).json({ error: 'Every product needs a name and price' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const created = [];
        for (const product of products) {
            const result = await client.query(
                `INSERT INTO products (name, price, old_price, category, description, stock, business_id, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
                [String(product.name).trim(), product.price, product.old_price || null, product.category || null,
                    product.description || null, Number.parseInt(product.stock, 10) || 0, req.businessId]
            );
            created.push(result.rows[0]);
        }
        await client.query('COMMIT');
        res.status(201).json({ success: true, products: created });
    } catch (err) {
        await client.query('ROLLBACK');
        logError(err, 'Batch product create');
        res.status(500).json({ error: 'Unable to create product batch' });
    } finally {
        client.release();
    }
});

// ============================================================
//  GET BUSINESS ORDERS
// ============================================================

router.get('/orders', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const { status, limit = 50, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT o.*, c.name AS customer_name, c.email AS customer_email
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            WHERE o.business_id = $1
        `;
        const params = [req.businessId];
        let paramIndex = 2;

        if (status && status !== 'all') {
            query += ` AND o.status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }

        query += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get business orders error:', err);
        logError(err, 'Get business orders');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  UPDATE ORDER STATUS
// ============================================================

router.put('/orders/:id/status', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.id);
        const { status } = req.body;

        const orderCheck = await pool.query(
            'SELECT * FROM orders WHERE id = $1 AND business_id = $2',
            [orderId, req.businessId]
        );

        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found in your business' });
        }

        const currentStatus = orderCheck.rows[0].status;

        const validTransitions = {
            'pending': ['confirmed', 'cancelled'],
            'pending_payment': ['pending', 'cancelled'],
            'confirmed': ['shipped', 'cancelled'],
            'shipped': ['delivered', 'cancelled'],
            'delivered': ['awaiting_payment', 'received'],
            'awaiting_payment': ['paid_on_delivery', 'cancelled'],
            'paid_on_delivery': ['received'],
            'received': ['completed']
        };

        if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
            return res.status(400).json({ error: `Cannot transition from ${currentStatus} to ${status}` });
        }

        await pool.query(
            `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
            [status, orderId]
        );

        await appendOrderStatus(orderId, status, `Status updated by business admin`);
        await logAdminActivity(req.userId, 'UPDATE_ORDER_STATUS', { orderId, status, businessId: req.businessId });

        const io = req.app.get('io');
        io.to(`order_${orderId}`).emit('order-status-updated', { orderId, status });
        io.emit('order-status-updated', { orderId, status });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Update order status error:', err);
        logError(err, 'Update order status');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS ANALYTICS
// ============================================================

router.get('/analytics', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const { period = 'week' } = req.query;
        const interval = period === 'week' ? '7 days' : period === 'month' ? '30 days' : '1 day';

        const revenue = await pool.query(`
            SELECT DATE(created_at) as date,
                   SUM(total) as revenue,
                   COUNT(*) as orders
            FROM orders
            WHERE business_id = $1
            AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
            AND created_at > NOW() - INTERVAL '${interval}'
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `, [req.businessId]);

        const stats = await pool.query(
            'SELECT * FROM business_stats WHERE business_id = $1',
            [req.businessId]
        );

        const topProducts = await pool.query(`
            SELECT oi.product_name, SUM(oi.quantity) as total_sold
            FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE o.business_id = $1
            AND o.status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
            GROUP BY oi.product_name
            ORDER BY total_sold DESC
            LIMIT 10
        `, [req.businessId]);

        const orderStatuses = await pool.query(`
            SELECT status, COUNT(*) as count
            FROM orders
            WHERE business_id = $1
            GROUP BY status
        `, [req.businessId]);

        res.json({
            period,
            revenue: revenue.rows,
            stats: stats.rows[0] || {},
            topProducts: topProducts.rows,
            orderStatuses: orderStatuses.rows
        });
    } catch (err) {
        console.error('❌ Get business analytics error:', err);
        logError(err, 'Get business analytics');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS CUSTOMERS
// ============================================================

router.get('/customers', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const { search, limit = 50, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT DISTINCT c.id, c.name, c.email, c.phone, c.created_at,
                (SELECT COUNT(*) FROM orders WHERE customer_id = c.id AND business_id = $1) as order_count,
                (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = c.id AND business_id = $1 AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
            FROM customers c
            JOIN orders o ON o.customer_id = c.id
            WHERE o.business_id = $1
        `;
        const params = [req.businessId];
        let paramIndex = 2;

        if (search) {
            query += ` AND (c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        query += ` ORDER BY c.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('❌ Get business customers error:', err);
        logError(err, 'Get business customers');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  GET BUSINESS PAYMENT SETTINGS
// ============================================================

router.get('/payment-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                mpesa_enabled, mpesa_number, mpesa_till_number, mpesa_paybill_number,
                mpesa_paybill_account, mpesa_payment_type, pochi_la_biashara_enabled, pochi_la_biashara_number,
                airtel_enabled, airtel_number,
                bank_enabled, bank_name, bank_account, bank_account_name,
                paypal_enabled, paypal_email
            FROM businesses
            WHERE id = $1
        `, [req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('❌ Get payment settings error:', err);
        logError(err, 'Get payment settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  UPDATE BUSINESS PAYMENT SETTINGS
// ============================================================

router.put('/payment-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const {
            mpesa_enabled, mpesa_number, mpesa_till_number, mpesa_paybill_number,
            mpesa_paybill_account, mpesa_payment_type, pochi_la_biashara_enabled, pochi_la_biashara_number,
            airtel_enabled, airtel_number,
            bank_enabled, bank_name, bank_account, bank_account_name,
            paypal_enabled, paypal_email
        } = req.body;

        if (mpesa_payment_type && !['paybill', 'till', 'pochi'].includes(mpesa_payment_type)) {
            return res.status(400).json({ error: 'M-Pesa payment type must be paybill, till, or pochi' });
        }
        const selectedNumber = mpesa_payment_type === 'paybill' ? mpesa_paybill_number : mpesa_payment_type === 'till' ? mpesa_till_number : mpesa_payment_type === 'pochi' ? pochi_la_biashara_number : mpesa_number;
        if (mpesa_enabled && mpesa_payment_type === 'paybill' && (!mpesa_paybill_number || !mpesa_paybill_account)) return res.status(400).json({ error: 'Paybill number and account number are required' });
        if (mpesa_enabled && mpesa_payment_type === 'till' && !mpesa_till_number) return res.status(400).json({ error: 'Till number is required' });
        if (mpesa_enabled && mpesa_payment_type === 'pochi' && !pochi_la_biashara_number) return res.status(400).json({ error: 'Pochi number is required' });
        const result = await pool.query(`
            UPDATE businesses
            SET
                mpesa_enabled = COALESCE($1, mpesa_enabled),
                mpesa_number = COALESCE($2, mpesa_number),
                mpesa_till_number = COALESCE($3, mpesa_till_number), mpesa_paybill_number = COALESCE($4, mpesa_paybill_number),
                mpesa_paybill_account = COALESCE($5, mpesa_paybill_account), mpesa_payment_type = COALESCE($6, mpesa_payment_type),
                pochi_la_biashara_enabled = COALESCE($7, pochi_la_biashara_enabled), pochi_la_biashara_number = COALESCE($8, pochi_la_biashara_number),
                airtel_enabled = COALESCE($9, airtel_enabled), airtel_number = COALESCE($10, airtel_number),
                bank_enabled = COALESCE($11, bank_enabled), bank_name = COALESCE($12, bank_name), bank_account = COALESCE($13, bank_account), bank_account_name = COALESCE($14, bank_account_name),
                paypal_enabled = COALESCE($15, paypal_enabled), paypal_email = COALESCE($16, paypal_email),
                updated_at = NOW()
            WHERE id = $17
            RETURNING *
        `, [
            mpesa_enabled, selectedNumber || mpesa_number, mpesa_till_number, mpesa_paybill_number, mpesa_paybill_account, mpesa_payment_type,
            pochi_la_biashara_enabled, pochi_la_biashara_number,
            airtel_enabled, airtel_number, bank_enabled, bank_name, bank_account, bank_account_name, paypal_enabled, paypal_email,
            req.businessId
        ]);

        await logAdminActivity(req.userId, 'UPDATE_PAYMENT_SETTINGS', { businessId: req.businessId });

        res.json({ success: true, settings: result.rows[0] });
    } catch (err) {
        console.error('❌ Update payment settings error:', err);
        logError(err, 'Update payment settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  DELIVERY SETTINGS - GET
// ============================================================

router.get('/delivery-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('🚚 Fetching delivery settings for business:', req.businessId);

        const result = await pool.query(`
            SELECT
                delivery_enabled,
                delivery_offered,
                delivery_free,
                delivery_free_where,
                delivery_no_message,
                delivery_free_message,
                delivery_paid_message,
                delivery_areas,
                delivery_fee_type,
                delivery_fee_fixed,
                delivery_fee_per_km,
                delivery_min_order_free,
                delivery_max_distance_km,
                delivery_days,
                delivery_time_slots,
                delivery_cutoff_time,
                delivery_estimated_time,
                delivery_policy,
                meeting_points
            FROM businesses
            WHERE id = $1
        `, [req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const settings = result.rows[0];

        // Parse JSON fields
        if (settings.delivery_areas && typeof settings.delivery_areas === 'string') {
            try { settings.delivery_areas = JSON.parse(settings.delivery_areas); } catch(e) { settings.delivery_areas = []; }
        }
        if (settings.delivery_days && typeof settings.delivery_days === 'string') {
            try { settings.delivery_days = JSON.parse(settings.delivery_days); } catch(e) { settings.delivery_days = ['mon','tue','wed','thu','fri','sat']; }
        }
        if (settings.delivery_time_slots && typeof settings.delivery_time_slots === 'string') {
            try { settings.delivery_time_slots = JSON.parse(settings.delivery_time_slots); } catch(e) { settings.delivery_time_slots = ['morning', 'afternoon']; }
        }
        if (settings.meeting_points && typeof settings.meeting_points === 'string') {
            try { settings.meeting_points = JSON.parse(settings.meeting_points); } catch(e) { settings.meeting_points = []; }
        }

        res.json(settings);
    } catch (err) {
        console.error('❌ Get delivery settings error:', err);
        logError(err, 'Get delivery settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  DELIVERY SETTINGS - UPDATE
// ============================================================

router.put('/delivery-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('🚚 Updating delivery settings for business:', req.businessId);
        console.log('📦 Request body:', req.body);

        const {
            delivery_offered,
            delivery_free,
            delivery_free_where,
            delivery_no_message,
            delivery_free_message,
            delivery_paid_message,
            delivery_areas,
            delivery_fee_type,
            delivery_fee_fixed,
            delivery_fee_per_km,
            delivery_min_order_free,
            delivery_max_distance_km,
            delivery_days,
            delivery_time_slots,
            delivery_cutoff_time,
            delivery_estimated_time,
            delivery_policy,
            meeting_points
        } = req.body;

        // Build update query
        const updates = [];
        const values = [];
        let paramIndex = 1;

        // Only update fields that are provided
        if (delivery_offered !== undefined) {
            updates.push(`delivery_offered = $${paramIndex}`);
            values.push(delivery_offered);
            paramIndex++;
        }
        if (delivery_free !== undefined) {
            updates.push(`delivery_free = $${paramIndex}`);
            values.push(delivery_free);
            paramIndex++;
        }
        if (delivery_free_where !== undefined) {
            updates.push(`delivery_free_where = $${paramIndex}`);
            values.push(delivery_free_where);
            paramIndex++;
        }
        if (delivery_no_message !== undefined) {
            updates.push(`delivery_no_message = $${paramIndex}`);
            values.push(delivery_no_message);
            paramIndex++;
        }
        if (delivery_free_message !== undefined) {
            updates.push(`delivery_free_message = $${paramIndex}`);
            values.push(delivery_free_message);
            paramIndex++;
        }
        if (delivery_paid_message !== undefined) {
            updates.push(`delivery_paid_message = $${paramIndex}`);
            values.push(delivery_paid_message);
            paramIndex++;
        }
        if (delivery_areas !== undefined) {
            updates.push(`delivery_areas = $${paramIndex}`);
            values.push(JSON.stringify(delivery_areas || []));
            paramIndex++;
        }
        if (delivery_fee_type !== undefined) {
            updates.push(`delivery_fee_type = $${paramIndex}`);
            values.push(delivery_fee_type);
            paramIndex++;
        }
        if (delivery_fee_fixed !== undefined) {
            updates.push(`delivery_fee_fixed = $${paramIndex}`);
            values.push(parseFloat(delivery_fee_fixed) || 0);
            paramIndex++;
        }
        if (delivery_fee_per_km !== undefined) {
            updates.push(`delivery_fee_per_km = $${paramIndex}`);
            values.push(parseFloat(delivery_fee_per_km) || 0);
            paramIndex++;
        }
        if (delivery_min_order_free !== undefined) {
            updates.push(`delivery_min_order_free = $${paramIndex}`);
            values.push(parseFloat(delivery_min_order_free) || 0);
            paramIndex++;
        }
        if (delivery_max_distance_km !== undefined) {
            updates.push(`delivery_max_distance_km = $${paramIndex}`);
            values.push(parseInt(delivery_max_distance_km) || 50);
            paramIndex++;
        }
        if (delivery_days !== undefined) {
            updates.push(`delivery_days = $${paramIndex}`);
            values.push(JSON.stringify(delivery_days || ['mon','tue','wed','thu','fri','sat']));
            paramIndex++;
        }
        if (delivery_time_slots !== undefined) {
            updates.push(`delivery_time_slots = $${paramIndex}`);
            values.push(JSON.stringify(delivery_time_slots || ['morning', 'afternoon']));
            paramIndex++;
        }
        if (delivery_cutoff_time !== undefined) {
            updates.push(`delivery_cutoff_time = $${paramIndex}`);
            values.push(delivery_cutoff_time || '14:00');
            paramIndex++;
        }
        if (delivery_estimated_time !== undefined) {
            updates.push(`delivery_estimated_time = $${paramIndex}`);
            values.push(delivery_estimated_time || 'Same day (orders before 2pm)');
            paramIndex++;
        }
        if (delivery_policy !== undefined) {
            updates.push(`delivery_policy = $${paramIndex}`);
            values.push(delivery_policy);
            paramIndex++;
        }
        if (meeting_points !== undefined) {
            updates.push(`meeting_points = $${paramIndex}`);
            values.push(JSON.stringify(meeting_points || []));
            paramIndex++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        // Add updated_at
        updates.push(`updated_at = NOW()`);

        // Add business_id to values
        values.push(req.businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        console.log('📦 Update query:', query);
        console.log('📦 Values:', values);

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        await logAdminActivity(req.userId, 'UPDATE_DELIVERY_SETTINGS', { businessId: req.businessId });
        res.json({ success: true, settings: result.rows[0] });
    } catch (err) {
        console.error('❌ Update delivery settings error:', err);
        logError(err, 'Update delivery settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  ORDER SETTINGS - GET
// ============================================================

router.get('/order-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('📋 Fetching order settings for business:', req.businessId);

        // Get order settings from businesses table (online_orders_enabled)
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
                return_window_days,
                online_payment_enabled,
                payment_on_delivery_enabled,
                require_pod_agreement,
                allow_replacements,
                allow_cancellations,
                allow_returns,
                allow_refunds,
                allow_reorders,
                cancellation_hours,
                return_days,
                pod_agreement_text
            FROM businesses
            WHERE id = $1
        `, [req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        // Also get system settings as fallback
        const systemSettings = await pool.query(`
            SELECT key, value FROM system_settings
        `);

        const settingsMap = {};
        systemSettings.rows.forEach(row => {
            settingsMap[row.key] = row.value;
        });

        const settings = result.rows[0];

        // Use business settings if available, otherwise system defaults
        const response = {
            online_orders_enabled: settings.online_orders_enabled !== false,
            show_cart_when_disabled: settings.show_cart_when_disabled === true,
            order_disabled_message: settings.order_disabled_message || 'This business is not currently accepting online orders. Please contact us directly.',
            order_regions: settings.order_regions || 'Anywhere in Kenya',
            order_cutoff_time: settings.order_cutoff_time || '14:00',
            order_processing_time: settings.order_processing_time || '1-2 hours',
            auto_cancel_hours: settings.auto_cancel_hours || parseInt(settingsMap.auto_cancel_hours) || 24,
            auto_complete_days: settings.auto_complete_days || parseInt(settingsMap.auto_complete_days) || 7,
            replacement_hours: settings.replacement_hours || parseInt(settingsMap.replacement_hours) || 6,
            status_pending: settings.status_pending || '📋 Your order is being reviewed.',
            status_pending_payment: settings.status_pending_payment || '⏳ Awaiting payment confirmation.',
            status_confirmed: settings.status_confirmed || '✅ Your order is confirmed and being prepared.',
            status_shipped: settings.status_shipped || '🚚 Your order is on the way!',
            status_delivered: settings.status_delivered || '📦 Your order is ready for pickup. Please collect within 7 working days.',
            status_received: settings.status_received || '✔️ You have confirmed receipt. Thank you!',
            status_cancelled: settings.status_cancelled || '❌ This order has been cancelled.',
            status_completed: settings.status_completed || '✅ Order completed. Thank you for shopping!',
            return_policy: settings.return_policy || 'Returns accepted within 14 days of delivery. Products must be in original condition.',
            return_window_days: settings.return_window_days || 14,
            online_payment_enabled: settings.online_payment_enabled !== false,
            payment_on_delivery_enabled: settings.payment_on_delivery_enabled === true,
            require_pod_agreement: settings.require_pod_agreement !== false,
            allow_replacements: settings.allow_replacements !== false,
            allow_cancellations: settings.allow_cancellations !== false,
            allow_returns: settings.allow_returns !== false,
            allow_refunds: settings.allow_refunds !== false,
            allow_reorders: settings.allow_reorders !== false,
            cancellation_hours: settings.cancellation_hours || 24,
            return_days: settings.return_days || 14,
            pod_agreement_text: settings.pod_agreement_text || ''
        };

        res.json(response);
    } catch (err) {
        console.error('❌ Get order settings error:', err);
        logError(err, 'Get order settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  ORDER SETTINGS - UPDATE
// ============================================================

router.put('/order-settings', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('📋 Updating order settings for business:', req.businessId);
        console.log('📦 Request body:', req.body);

        const {
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
            return_window_days,
            online_payment_enabled,
            payment_on_delivery_enabled,
            require_pod_agreement,
            allow_replacements,
            allow_cancellations,
            allow_returns,
            allow_refunds,
            allow_reorders,
            cancellation_hours,
            return_days,
            pod_agreement_text
        } = req.body;

        // Build update query
        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (online_orders_enabled !== undefined) {
            updates.push(`online_orders_enabled = $${paramIndex}`);
            values.push(online_orders_enabled);
            paramIndex++;
        }
        if (order_regions !== undefined) {
            updates.push(`order_regions = $${paramIndex}`);
            values.push(order_regions);
            paramIndex++;
        }
        if (order_cutoff_time !== undefined) {
            updates.push(`order_cutoff_time = $${paramIndex}`);
            values.push(order_cutoff_time);
            paramIndex++;
        }
        if (order_processing_time !== undefined) {
            updates.push(`order_processing_time = $${paramIndex}`);
            values.push(order_processing_time);
            paramIndex++;
        }
        if (auto_cancel_hours !== undefined) {
            updates.push(`auto_cancel_hours = $${paramIndex}`);
            values.push(parseInt(auto_cancel_hours) || 24);
            paramIndex++;
        }
        if (auto_complete_days !== undefined) {
            updates.push(`auto_complete_days = $${paramIndex}`);
            values.push(parseInt(auto_complete_days) || 7);
            paramIndex++;
        }
        if (replacement_hours !== undefined) {
            updates.push(`replacement_hours = $${paramIndex}`);
            values.push(parseInt(replacement_hours) || 6);
            paramIndex++;
        }
        if (status_pending !== undefined) {
            updates.push(`status_pending = $${paramIndex}`);
            values.push(status_pending);
            paramIndex++;
        }
        if (status_pending_payment !== undefined) {
            updates.push(`status_pending_payment = $${paramIndex}`);
            values.push(status_pending_payment);
            paramIndex++;
        }
        if (status_confirmed !== undefined) {
            updates.push(`status_confirmed = $${paramIndex}`);
            values.push(status_confirmed);
            paramIndex++;
        }
        if (status_shipped !== undefined) {
            updates.push(`status_shipped = $${paramIndex}`);
            values.push(status_shipped);
            paramIndex++;
        }
        if (status_delivered !== undefined) {
            updates.push(`status_delivered = $${paramIndex}`);
            values.push(status_delivered);
            paramIndex++;
        }
        if (status_received !== undefined) {
            updates.push(`status_received = $${paramIndex}`);
            values.push(status_received);
            paramIndex++;
        }
        if (status_cancelled !== undefined) {
            updates.push(`status_cancelled = $${paramIndex}`);
            values.push(status_cancelled);
            paramIndex++;
        }
        if (status_completed !== undefined) {
            updates.push(`status_completed = $${paramIndex}`);
            values.push(status_completed);
            paramIndex++;
        }
        if (return_policy !== undefined) {
            updates.push(`return_policy = $${paramIndex}`);
            values.push(return_policy);
            paramIndex++;
        }
        if (return_window_days !== undefined) {
            updates.push(`return_window_days = $${paramIndex}`);
            values.push(parseInt(return_window_days) || 14);
            paramIndex++;
        }
        if (show_cart_when_disabled !== undefined) {
            updates.push(`show_cart_when_disabled = $${paramIndex}`);
            values.push(Boolean(show_cart_when_disabled));
            paramIndex++;
        }
        if (order_disabled_message !== undefined) {
            updates.push(`order_disabled_message = $${paramIndex}`);
            values.push(String(order_disabled_message).slice(0, 1000));
            paramIndex++;
        }

        const policyFields = {
            online_payment_enabled,
            payment_on_delivery_enabled,
            require_pod_agreement,
            allow_replacements,
            allow_cancellations,
            allow_returns,
            allow_refunds,
            allow_reorders,
            cancellation_hours,
            return_days,
            pod_agreement_text
        };
        for (const [field, value] of Object.entries(policyFields)) {
            if (value === undefined) continue;
            updates.push(`${field} = $${paramIndex}`);
            values.push(['cancellation_hours', 'return_days'].includes(field) ? parseInt(value, 10) : value);
            paramIndex++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        // Add updated_at
        updates.push(`updated_at = NOW()`);

        // Add business_id to values
        values.push(req.businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        console.log('📦 Update query:', query);
        console.log('📦 Values:', values);

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        await logAdminActivity(req.userId, 'UPDATE_ORDER_SETTINGS', { businessId: req.businessId });
        res.json({ success: true, settings: result.rows[0] });
    } catch (err) {
        console.error('❌ Update order settings error:', err);
        logError(err, 'Update order settings');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  DELIVERY LOG - GET
// ============================================================

router.get('/delivery-log/:orderId', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.orderId);

        const orderCheck = await pool.query(
            'SELECT id FROM orders WHERE id = $1 AND business_id = $2',
            [orderId, req.businessId]
        );

        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const log = await Business.getDeliveryLog(orderId);
        res.json(log || {});
    } catch (err) {
        console.error('❌ Get delivery log error:', err);
        logError(err, 'Get delivery log');
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  DELIVERY LOG - UPDATE
// ============================================================

router.put('/delivery-log/:orderId', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const orderId = parseInt(req.params.orderId);
        const { status, driver_name, driver_phone, tracking_number, notes } = req.body;

        const orderCheck = await pool.query(
            'SELECT id FROM orders WHERE id = $1 AND business_id = $2',
            [orderId, req.businessId]
        );

        if (orderCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const log = await Business.updateDeliveryLog(orderId, status, {
            driver_name, driver_phone, tracking_number, notes
        });

        await logAdminActivity(req.userId, 'UPDATE_DELIVERY_LOG', { orderId, status, businessId: req.businessId });
        res.json({ success: true, log });
    } catch (err) {
        console.error('❌ Update delivery log error:', err);
        logError(err, 'Update delivery log');
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;