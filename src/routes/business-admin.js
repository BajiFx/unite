// ============================================================
//  BUSINESS ADMIN ROUTES - COMPLETE WITH ALL SETTINGS
//  Location: src/routes/business-admin.js
//
//  B.1 — Product categories come from the database
//  B.3 — Filtered by the business's own business category
//  B.5 — Required on create, update, and batch
//  B.6 — Business admins can request new product categories
//  B.8 — Joined category name returned on every product
//
//  Section C — Business location activation
//  C.1 — Manual latitude/longitude are no longer required.
//  C.2 — The profile response now reports activation state so
//        the panel can render the "Make people find you by your
//        location" section correctly.
//  C.3 — New /location/activate endpoint receives coordinates
//        already fetched by the browser.
//  C.4 — Coordinates + activation flag are saved together.
//  C.5 — New /location endpoint saves an adjusted pin.
//  C.6 — Re-activation simply calls /location/activate again.
//  C.7 — Address name fields remain on the normal profile update.
//  C.8 — activation flag is returned on GET /profile.
//  C.9 — location_complete flag is returned on GET /profile so
//        the panel can show a warning when incomplete.
//
//  Section J — Business Ads (hero slider on marketplace)
//  J.1 — The business_ads table is managed through
//        /ads (list), /ads (create), /ads/:id (update),
//        /ads/:id (delete), and /ads/:id/toggle.
//  J.2 — Business admins can upload image or video, set the
//        title, description, and link target (profile or
//        product), and toggle an ad active or inactive.
//  J.3 — Each ad is returned with views, clicks, and CTR so the
//        admin panel can render a small performance table.
//  J.6 — The link target is validated against the same business
//        so a product ad can never point at another business's
//        product.
//
//  Section N — Fixed ad slots
//  N.1 — Each business has exactly three ad slots: 1, 2, 3.
//  N.2 — A new ad is assigned the smallest free slot
//        (1 → 2 → 3). No "newest first" behaviour anywhere.
//  N.3 — Editing an ad never changes its slot.
//  N.4 — Deleting an ad frees its slot; the other slots do not
//        shift.
//  N.5 — When all three slots are taken, POST /ads is rejected
//        with 409 and a clear message telling the admin to
//        delete or edit an existing ad first.
//  N.6 — GET /ads returns ads ordered by slot ASC, plus the
//        full slot-usage picture ({ used, free, count, max })
//        so the admin UI can render "Ad 1 of 3" and disable the
//        create form at the cap.
//  N.7 — The marketplace rotation (businesses.js) relies on the
//        slot column being stable. This file is the only writer.
//
//  Section I.6 — mpesa_environment is now returned by
//        GET /payment-settings so the business admin panel can
//        render the read-only environment badge (production vs
//        sandbox) without a second request.
//
//  Section 2D — Ad duration caps
//   2D.A — AD_MAX_IMAGE_DURATION_SECONDS = 4
//   2D.B — AD_MAX_VIDEO_DURATION_SECONDS = 20
//   2D.C — clampAdDuration(mediaType, rawValue) is the single
//          entry point for enforcing the cap. It is applied on
//          POST /ads and on PUT /ads/:id, using the effective
//          media type in each case (the new one for a
//          replacement upload, the stored one otherwise).
//   2D.D — A one-time backfill migration
//          (20260921-ad-duration-clamp.sql) brings existing rows
//          into line.
//
//  Section 11.B — Business account deletion
//   Two new routes are appended at the very bottom of this file:
//     POST /request-deletion
//       Verifies the admin's password, schedules the deletion
//       60 days out, hides the business, and deactivates the
//       admin account. The client then logs the admin out.
//     POST /cancel-deletion
//       Clears a pending deletion on the requesting admin's own
//       business and reactivates both the business and the
//       admin account. Also called automatically from
//       POST /api/auth/business/login (that auto-cancel lives in
//       auth.js).
//
//   The finalization job that anonymizes / deactivates rows past
//   their grace period lives in server.js (cron at 03:00).
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const { pool, logError } = require('../config/database');
const { authMiddleware, businessAdminOnly, getBusinessIdFromToken } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadToCloudinary } = require('../config/cloudinary');
const { appendOrderStatus, logAdminActivity } = require('../services/orderService');
const Business = require('../models/Business');
const router = express.Router();

const LOCATION_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area', 'postal_code'];

// ============================================================
//  Section N.1 — Fixed ad slots
//  Each business has exactly three ad slots: 1, 2, 3.
//  Declared once so the cap has a single source of truth.
// ============================================================

const MAX_ADS_PER_BUSINESS = 3;
const AD_SLOT_RANGE = Array.from({ length: MAX_ADS_PER_BUSINESS }, (_, i) => i + 1);

// ============================================================
//  Section 2D — Ad duration caps
//
//  The marketplace hero slider rotates on a wall-clock cycle.
//  Enforcing a per-media-type cap keeps the cycle uniform and
//  stops a single ad from dominating the rotation.
//
//  These two constants are the server-side source of truth for
//  the caps. The client mirrors them, and the backfill migration
//  20260921-ad-duration-clamp.sql uses the same numbers.
// ============================================================

const AD_MAX_IMAGE_DURATION_SECONDS = 4;
const AD_MAX_VIDEO_DURATION_SECONDS = 20;

// ============================================================
//  Section 11.B — Business account deletion
//
//  Both the reason set and the grace period are declared here so
//  the request handler, the cancel handler, and any future code
//  that reads them all share one source of truth. The grace
//  period is used both when scheduling the deletion and (read
//  only) by the server-side finalization job.
// ============================================================

const BUSINESS_DELETION_REASONS = new Set([
    'Closing my business',
    'Too expensive',
    'Not enough sales',
    'Privacy concerns',
    'Moving to another platform',
    'Other'
]);

const BUSINESS_DELETION_GRACE_DAYS = 60;

// Sections C.3 – C.6 — helpers -------------------------------------------------

/**
 * Parse and validate a latitude/longitude pair coming from the client.
 * Accepts numbers or numeric strings. Rejects NaN, empty, or out of range.
 * Returns { ok: true, lat, lng } or { ok: false, error }.
 */
function parseCoordinates(inputLat, inputLng) {
    if (inputLat === undefined || inputLat === null || inputLat === '') {
        return { ok: false, error: 'Latitude is required' };
    }
    if (inputLng === undefined || inputLng === null || inputLng === '') {
        return { ok: false, error: 'Longitude is required' };
    }

    const lat = Number.parseFloat(inputLat);
    const lng = Number.parseFloat(inputLng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { ok: false, error: 'Valid latitude and longitude are required' };
    }
    if (lat < -90 || lat > 90) {
        return { ok: false, error: 'Latitude must be between -90 and 90' };
    }
    if (lng < -180 || lng > 180) {
        return { ok: false, error: 'Longitude must be between -180 and 180' };
    }
    return { ok: true, lat, lng };
}

/**
 * Normalise a location source value.
 */
function normaliseLocationSource(source) {
    const allowed = ['browser', 'pin', 'geocode'];
    return allowed.includes(source) ? source : 'browser';
}

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

// ============================================================
//  PRODUCT CATEGORIES — list for the current business
//  B.1, B.3 — Only categories linked to the business's own
//             business categories are returned. Generic ones
//             (business_category_id IS NULL) are always included.
// ============================================================

router.get('/product-categories', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT
                pc.id,
                pc.name,
                pc.slug,
                pc.icon,
                pc.description,
                pc.business_category_id,
                bc.name AS business_category_name,
                bc.slug AS business_category_slug
            FROM product_categories pc
            LEFT JOIN business_categories bc ON bc.id = pc.business_category_id
            WHERE pc.is_active = true
              AND (
                    pc.business_category_id IS NULL
                 OR pc.business_category_id IN (
                        SELECT category_id
                        FROM business_category_assignments
                        WHERE business_id = $1
                    )
              )
            ORDER BY bc.name NULLS FIRST, pc.name ASC
        `, [req.businessId]);

        res.json(result.rows);
    } catch (err) {
        logError(err, 'Get business admin product categories');
        res.status(500).json({ error: 'Unable to load product categories' });
    }
});

// ============================================================
//  PRODUCT CATEGORIES — request a new one
//  B.6 — Business admins can request a new product category.
//        The row is stored with is_active = false and
//        is_requested = true so a platform admin can approve it.
// ============================================================

router.post('/product-categories/request', authMiddleware, businessAdminOnly, getBusinessIdFromToken, [
    body('name').trim().isLength({ min: 2 }).withMessage('Product category name is required'),
    body('business_category_id').optional().isInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { name, business_category_id, description } = req.body;
    const trimmedName = String(name).trim();
    const slugBase = trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = slugBase || `product-category-${Date.now()}`;

    try {
        const existing = await pool.query(
            'SELECT id, is_active, is_requested FROM product_categories WHERE LOWER(name) = LOWER($1)',
            [trimmedName]
        );

        if (existing.rows.length > 0) {
            const found = existing.rows[0];
            if (found.is_active) {
                return res.status(409).json({ error: 'That product category already exists.' });
            }
            if (found.is_requested) {
                return res.status(202).json({
                    success: true,
                    pending: true,
                    message: 'That product category has already been requested and is awaiting approval.'
                });
            }
        }

        const result = await pool.query(`
            INSERT INTO product_categories
                (name, slug, description, business_category_id, is_active, is_requested, requested_by_business_id)
            VALUES ($1, $2, $3, $4, false, true, $5)
            RETURNING id, name, slug, business_category_id, is_active, is_requested
        `, [
            trimmedName,
            slug,
            description || null,
            business_category_id || null,
            req.businessId
        ]);

        await logAdminActivity(req.userId, 'REQUEST_PRODUCT_CATEGORY', {
            productCategoryId: result.rows[0].id,
            name: trimmedName,
            businessId: req.businessId
        });

        res.status(201).json({
            success: true,
            pending: true,
            product_category: result.rows[0],
            message: 'Product category request submitted. It will be available once approved.'
        });
    } catch (err) {
        logError(err, 'Request product category');
        res.status(500).json({ error: 'Unable to submit product category request' });
    }
});

// ============================================================
//  GET BUSINESS PROFILE
//
//  C.2 / C.8 / C.9 — now returns the full location state so
//  the admin panel can render the "Make people find you by
//  your location" section, the "✅ Location Activated" badge,
//  and the "your business cannot be found" warning.
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

        const categories = await pool.query(`
            SELECT c.id, c.name, c.slug, c.icon
            FROM business_categories c
            JOIN business_category_assignments bca ON bca.category_id = c.id
            WHERE bca.business_id = $1
            ORDER BY c.name
        `, [req.businessId]);

        const business = result.rows[0];

        // C.8 / C.9 — expose activation + completeness flags explicitly
        // so the frontend does not have to re-derive them.
        const locationActivated = business.location_activated === true;
        const locationComplete = business.location_complete === true;

        res.json({
            business: {
                ...business,
                location_activated: locationActivated,
                location_complete: locationComplete
            },
            location: {
                activated: locationActivated,
                complete: locationComplete,
                activated_at: business.location_activated_at || null,
                pin_updated_at: business.location_pin_updated_at || null,
                source: business.location_source || null,
                accuracy: business.location_accuracy || null,
                latitude: business.latitude || null,
                longitude: business.longitude || null
            },
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
//
//  C.1 — latitude / longitude remain accepted but are no
//        longer required. They are kept in the allowedFields
//        list so other flows (pin adjust fallback) still work.
//  C.7 — continent, country, county, sub-county, ward, town,
//        specific_area and postal_code are accepted here.
//
//  C.4 — When coordinates come in via the profile form, the
//        activation flag is set automatically and the source
//        defaults to "geocode" unless already set.
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
                // C.7 — human-readable location names
                'continent', 'country', 'county', 'sub_county', 'ward',
                'town', 'specific_area', 'postal_code',
                // C.1 — manual coordinates remain optional
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

            // C.4 — If the admin supplied coordinates via this form,
            // mark the location as activated automatically.
            const hasLat = req.body.latitude !== undefined && req.body.latitude !== '';
            const hasLng = req.body.longitude !== undefined && req.body.longitude !== '';
            if (hasLat && hasLng) {
                const parsed = parseCoordinates(req.body.latitude, req.body.longitude);
                if (parsed.ok) {
                    fields.push(`location_activated = TRUE`);
                    fields.push(`location_activated_at = COALESCE(location_activated_at, NOW())`);
                    fields.push(`location_source = COALESCE(location_source, 'geocode')`);
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
//  SECTION C — LOCATION ACTIVATION
//
//  C.3 / C.4 / C.6
//  The browser fetches coordinates and POSTs them here.
//  This is the ONLY write path that marks a business as
//  "activated by the browser", and re-calling it simply
//  refreshes the coordinates (C.6).
//
//  Manual validation (no express-validator) because the browser
//  sends `accuracy` as a NUMBER and `notEmpty()` treats 0 as empty.
// ============================================================

router.post('/location/activate',
    authMiddleware,
    businessAdminOnly,
    getBusinessIdFromToken,
    async (req, res) => {
        try {
            const { latitude, longitude, accuracy } = req.body || {};

            console.log('📍 Activate location request:', {
                businessId: req.businessId,
                latitude,
                longitude,
                accuracy
            });

            const parsed = parseCoordinates(latitude, longitude);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }

            // C.4 — persist coordinates and set the activation flag.
            const result = await pool.query(`
                UPDATE businesses
                SET latitude = $1,
                    longitude = $2,
                    location_accuracy = COALESCE($3, location_accuracy),
                    location_activated = TRUE,
                    location_activated_at = NOW(),
                    location_source = 'browser',
                    updated_at = NOW()
                WHERE id = $4
                RETURNING
                    id, business_name,
                    latitude, longitude,
                    location_accuracy,
                    location_activated,
                    location_activated_at,
                    location_source,
                    location_complete
            `, [
                parsed.lat.toString(),
                parsed.lng.toString(),
                accuracy !== undefined && accuracy !== null && accuracy !== ''
                    ? String(accuracy)
                    : null,
                req.businessId
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Business not found' });
            }

            await logAdminActivity(req.userId, 'ACTIVATE_BUSINESS_LOCATION', {
                businessId: req.businessId,
                latitude: parsed.lat,
                longitude: parsed.lng
            });

            res.json({
                success: true,
                message: 'Location activated successfully.',
                location: {
                    latitude: result.rows[0].latitude,
                    longitude: result.rows[0].longitude,
                    accuracy: result.rows[0].location_accuracy,
                    activated: result.rows[0].location_activated === true,
                    activated_at: result.rows[0].location_activated_at,
                    source: result.rows[0].location_source,
                    complete: result.rows[0].location_complete === true
                }
            });
        } catch (err) {
            console.error('❌ Activate business location error:', err);
            logError(err, 'Activate business location');
            res.status(500).json({
                error: 'Unable to save business location',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

// ============================================================
//  SECTION C — ADJUSTED PIN
//
//  C.5 — After the map preview shows the pin, the admin can
//  drag it and confirm. The adjusted coordinates are saved
//  here with source = 'pin'.
//
//  C.6 — The same endpoint is used again if the business moves.
// ============================================================

router.put('/location',
    authMiddleware,
    businessAdminOnly,
    getBusinessIdFromToken,
    async (req, res) => {
        try {
            const { latitude, longitude } = req.body || {};

            const parsed = parseCoordinates(latitude, longitude);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }

            const result = await pool.query(`
                UPDATE businesses
                SET latitude = $1,
                    longitude = $2,
                    location_pin_updated_at = NOW(),
                    location_activated = TRUE,
                    location_activated_at = COALESCE(location_activated_at, NOW()),
                    location_source = 'pin',
                    updated_at = NOW()
                WHERE id = $3
                RETURNING
                    id, business_name,
                    latitude, longitude,
                    location_pin_updated_at,
                    location_activated,
                    location_activated_at,
                    location_source,
                    location_complete
            `, [
                parsed.lat.toString(),
                parsed.lng.toString(),
                req.businessId
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Business not found' });
            }

            await logAdminActivity(req.userId, 'ADJUST_BUSINESS_LOCATION_PIN', {
                businessId: req.businessId,
                latitude: parsed.lat,
                longitude: parsed.lng
            });

            res.json({
                success: true,
                message: 'Location pin updated successfully.',
                location: {
                    latitude: result.rows[0].latitude,
                    longitude: result.rows[0].longitude,
                    pin_updated_at: result.rows[0].location_pin_updated_at,
                    activated: result.rows[0].location_activated === true,
                    activated_at: result.rows[0].location_activated_at,
                    source: result.rows[0].location_source,
                    complete: result.rows[0].location_complete === true
                }
            });
        } catch (err) {
            console.error('❌ Adjust business location pin error:', err);
            logError(err, 'Adjust business location pin');
            res.status(500).json({ error: 'Unable to update location pin' });
        }
    }
);

// ============================================================
//  SECTION C — LOCATION STATUS
//
//  C.8 / C.9 — Lightweight endpoint the panel can poll to
//  refresh the badge and warning without reloading the whole
//  profile.
// ============================================================

router.get('/location', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                latitude, longitude,
                location_accuracy,
                location_activated,
                location_activated_at,
                location_pin_updated_at,
                location_source,
                location_complete,
                continent, country, county, sub_county, ward,
                town, specific_area, postal_code
            FROM businesses
            WHERE id = $1
        `, [req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const row = result.rows[0];

        res.json({
            activated: row.location_activated === true,
            complete: row.location_complete === true,
            activated_at: row.location_activated_at || null,
            pin_updated_at: row.location_pin_updated_at || null,
            source: row.location_source || null,
            accuracy: row.location_accuracy || null,
            latitude: row.latitude || null,
            longitude: row.longitude || null,
            names: {
                continent: row.continent || null,
                country: row.country || null,
                county: row.county || null,
                sub_county: row.sub_county || null,
                ward: row.ward || null,
                town: row.town || null,
                specific_area: row.specific_area || null,
                postal_code: row.postal_code || null
            }
        });
    } catch (err) {
        console.error('❌ Get business location error:', err);
        logError(err, 'Get business location');
        res.status(500).json({ error: 'Unable to load business location' });
    }
});

// ============================================================
//  GET BUSINESS PRODUCTS
//  B.8 — Joined product category name returned with every product
// ============================================================

router.get('/products', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        console.log('📦 Fetching products for business ID:', req.businessId);

        const { search, category, product_category_id, limit = 50, page = 1 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT p.*,
                   pc.name AS product_category_name,
                   pc.slug AS product_category_slug,
                   pc.icon AS product_category_icon
            FROM products p
            LEFT JOIN product_categories pc ON pc.id = p.product_category_id
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

        if (product_category_id) {
            query += ` AND p.product_category_id = $${paramIndex}`;
            params.push(parseInt(product_category_id, 10));
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
//  SECTION J / N — BUSINESS ADS (HERO SLIDER ON MARKETPLACE)
//
//  J.1 — Ad rows live in the business_ads table created by
//        migrations/sql/20260914-business-ads.sql.
//  J.2 — Upload image or video, set title / description, and
//        choose a link target (profile or one of this
//        business's own products).
//  J.3 — The list response carries views, clicks, and CTR so
//        the admin panel can render a small performance table.
//  J.6 — When link_type = 'product', link_target_id must be a
//        product owned by the same business. Enforced here at
//        the app layer, and again by a trigger in the schema.
//
//  Section N.1 – N.6 — Fixed ad slots.
//   Each business has exactly three slots (1, 2, 3). A new ad
//   is placed in the smallest free slot. Editing an ad never
//   moves it. Deleting frees the slot without shifting others.
//   When all three slots are taken, POST /ads is rejected.
//   The slot ordering is the ONLY thing the marketplace slider
//   uses to rotate ads — never created_at — so a business
//   cannot jump ahead by deleting and re-uploading.
//
//  Media is uploaded to Cloudinary, matching how product media
//  is handled elsewhere in this file:
//    images → default resource type
//    videos → resource_type: 'video'
//
//  Section 2D — Ad duration caps.
//   Every duration that reaches the database is passed through
//   clampAdDuration() below. The helper picks the correct cap
//   from the effective media type:
//     image  →  AD_MAX_IMAGE_DURATION_SECONDS (4 s)
//     video  →  AD_MAX_VIDEO_DURATION_SECONDS (20 s)
// ============================================================

/**
 * Section 2D — Clamp an ad's display duration against its
 * media-type cap.
 *
 * Accepts a number or numeric string. Returns:
 *   - null when the caller did not supply a value, so the
 *     slider can fall back to its own defaults.
 *   - the parsed value clamped to [1, cap] otherwise.
 *
 * `mediaType` is the *effective* type: for a new ad it is the
 * type derived from the uploaded file; for an edit it is the
 * type that will be stored after the edit (the new one if a
 * replacement file was uploaded, the stored one otherwise).
 */
function clampAdDuration(mediaType, rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return null;
    const parsed = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return null;
    const cap = mediaType === 'video'
        ? AD_MAX_VIDEO_DURATION_SECONDS
        : AD_MAX_IMAGE_DURATION_SECONDS;
    return Math.min(parsed, cap);
}

/**
 * Normalise an ad's link type.
 * Anything other than 'product' falls back to 'profile'.
 */
function parseLinkType(value) {
    return value === 'product' ? 'product' : 'profile';
}

/**
 * Validate the link target for an ad.
 *
 *  - link_type = 'profile'  → target is ignored, always valid.
 *  - link_type = 'product'  → target must be a real product
 *                             owned by the same business.
 *
 * Returns { ok: true, linkTargetId } or { ok: false, error }.
 */
async function validateAdLinkTarget(businessId, linkType, rawTargetId) {
    if (linkType !== 'product') {
        return { ok: true, linkTargetId: null };
    }

    const targetId = Number.parseInt(rawTargetId, 10);
    if (!Number.isInteger(targetId)) {
        return { ok: false, error: 'Please choose which product this ad should open.' };
    }

    const result = await pool.query(
        'SELECT id FROM products WHERE id = $1 AND business_id = $2 AND is_active = true',
        [targetId, businessId]
    );

    if (result.rows.length === 0) {
        return { ok: false, error: 'Selected product does not belong to your business.' };
    }

    return { ok: true, linkTargetId: targetId };
}

/**
 * Load a single ad owned by the given business, joined with the
 * minimal product data needed to render the list.
 */
async function loadAdForBusiness(businessId, adId) {
    const result = await pool.query(`
        SELECT a.*,
               p.name AS product_name,
               p.image AS product_image
        FROM business_ads a
        LEFT JOIN products p ON p.id = a.link_target_id AND a.link_type = 'product'
        WHERE a.id = $1 AND a.business_id = $2
    `, [adId, businessId]);

    return result.rows[0] || null;
}

/**
 * Section N.2 — Find the smallest free slot for this business.
 *
 * Returns the first integer in [1, 2, 3] not currently used by
 * this business, or null when every slot is taken.
 *
 * The caller is responsible for the subsequent INSERT; this
 * function does not lock the row, so a race is still possible in
 * theory. The unique index on (business_id, slot) is what
 * actually guarantees correctness — the INSERT will fail with a
 * 23505 error if two creates land on the same slot at the same
 * time, and the route below handles that case by re-checking.
 */
async function findFreeAdSlot(businessId) {
    const result = await pool.query(
        'SELECT slot FROM business_ads WHERE business_id = $1',
        [businessId]
    );
    const used = new Set(result.rows.map(row => Number(row.slot)));
    for (const candidate of AD_SLOT_RANGE) {
        if (!used.has(candidate)) return candidate;
    }
    return null;
}

/**
 * Section N.6 — Return the full slot usage for this business so
 * the admin UI can render "Ad 1 of 3", disable the create form
 * at the cap, and show which slots are free.
 */
async function getAdSlotUsage(businessId) {
    const result = await pool.query(
        'SELECT slot, id FROM business_ads WHERE business_id = $1 ORDER BY slot ASC',
        [businessId]
    );
    const used = result.rows.map(row => Number(row.slot));
    const free = AD_SLOT_RANGE.filter(slot => !used.includes(slot));
    return {
        max: MAX_ADS_PER_BUSINESS,
        count: used.length,
        used,
        free,
        isFull: free.length === 0
    };
}

// ============================================================
//  N — LIST ADS FOR THE CURRENT BUSINESS
//
//  N.6 — Ordered by slot ASC (never created_at), and enriched
//        with the full slot-usage picture so the admin UI can
//        render the count and disable the form at the cap.
// ============================================================

router.get('/ads', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.*,
                   p.name AS product_name,
                   p.image AS product_image
            FROM business_ads a
            LEFT JOIN products p ON p.id = a.link_target_id AND a.link_type = 'product'
            WHERE a.business_id = $1
            ORDER BY a.slot ASC
        `, [req.businessId]);

        const slotUsage = await getAdSlotUsage(req.businessId);

        res.json({
            ads: result.rows,
            slot_usage: slotUsage
        });
    } catch (err) {
        console.error('❌ Get business ads error:', err);
        logError(err, 'Get business ads');
        res.status(500).json({ error: 'Unable to load ads' });
    }
});

// ============================================================
//  N — CREATE AD
//
//  N.2 — Assigns the smallest free slot for this business.
//  N.5 — Rejects with 409 when all three slots are taken.
//
//  Section 2D — display_duration is passed through
//  clampAdDuration(mediaType, ...) before the INSERT, so the
//  cap is enforced server-side no matter what the client sends.
//
//  Multipart form:
//    media           (required, single file: image or video)
//    media_type      ('image' | 'video')
//    title           (optional)
//    description     (optional)
//    link_type       ('profile' | 'product')
//    link_target_id  (required when link_type = 'product')
//    display_duration(optional, seconds — clamped to 4 / 20)
//    is_active       ('true' | 'false', defaults to 'true')
// ============================================================

router.post(
    '/ads',
    authMiddleware,
    businessAdminOnly,
    getBusinessIdFromToken,
    upload.fields([{ name: 'media', maxCount: 1 }]),
    async (req, res) => {
        try {
            const mediaFile = req.files && req.files.media && req.files.media[0];

            if (!mediaFile) {
                return res.status(400).json({ error: 'Please upload an image or video for this ad.' });
            }

            // N.5 — refuse before doing any upload work when the cap
            // is already reached. This is checked twice: once here
            // (fast path, avoids a wasted Cloudinary upload) and
            // again implicitly through the unique index below.
            const slotUsage = await getAdSlotUsage(req.businessId);
            if (slotUsage.isFull) {
                return res.status(409).json({
                    error: `You have reached the maximum of ${MAX_ADS_PER_BUSINESS} ads. Delete or edit an existing ad to free a slot.`,
                    slot_usage: slotUsage
                });
            }

            // Derive the media type from the file itself. The client's
            // `media_type` field is only a hint; the mime type is the
            // source of truth so a mislabelled upload cannot corrupt the row.
            const mime = String(mediaFile.mimetype || '').toLowerCase();
            const inferredType = mime.startsWith('video/') ? 'video' : 'image';
            const mediaType = inferredType;

            const { title, description, link_type, link_target_id, display_duration, is_active } = req.body || {};

            const parsedLinkType = parseLinkType(link_type);
            const targetCheck = await validateAdLinkTarget(req.businessId, parsedLinkType, link_target_id);
            if (!targetCheck.ok) {
                return res.status(400).json({ error: targetCheck.error });
            }

            let mediaUrl;
            try {
                mediaUrl = await uploadToCloudinary(mediaFile.path, {
                    folder: `business_shop/${req.businessId}/ads`,
                    ...(mediaType === 'video' ? { resource_type: 'video' } : {})
                });
            } catch (uploadErr) {
                console.error('Ad media upload error:', uploadErr);
                return res.status(500).json({ error: 'Unable to upload ad media. Please try again.' });
            }

            // Section 2D — clamp the duration against the correct cap
            // for this media type. The helper returns null when the
            // caller did not supply a value, so the marketplace can
            // fall back to its own defaults.
            const duration = clampAdDuration(mediaType, display_duration);
            const active = !(is_active === 'false' || is_active === false);

            // N.2 — find the smallest free slot at insert time. If
            // two requests race, the unique index will reject the
            // second with 23505, and we retry once with a fresh
            // lookup so the caller never sees a raw database error.
            let insertedAd = null;
            let attempt = 0;

            while (attempt < 2 && !insertedAd) {
                attempt++;
                const nextSlot = await findFreeAdSlot(req.businessId);
                if (nextSlot === null) {
                    return res.status(409).json({
                        error: `You have reached the maximum of ${MAX_ADS_PER_BUSINESS} ads. Delete or edit an existing ad to free a slot.`,
                        slot_usage: await getAdSlotUsage(req.businessId)
                    });
                }

                try {
                    const result = await pool.query(`
                        INSERT INTO business_ads (
                            business_id, slot, media_type, media_url, title, description,
                            link_type, link_target_id, display_duration, is_active
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                        RETURNING *
                    `, [
                        req.businessId,
                        nextSlot,
                        mediaType,
                        mediaUrl,
                        title ? String(title).trim().slice(0, 200) : null,
                        description ? String(description).trim().slice(0, 2000) : null,
                        parsedLinkType,
                        targetCheck.linkTargetId,
                        duration,
                        active
                    ]);
                    insertedAd = result.rows[0];
                } catch (insertErr) {
                    // 23505 = unique_violation on (business_id, slot).
                    // A parallel create grabbed the same slot; loop
                    // and pick the next free one.
                    if (insertErr.code === '23505' && attempt < 2) {
                        continue;
                    }
                    throw insertErr;
                }
            }

            await logAdminActivity(req.userId, 'CREATE_AD', {
                businessId: req.businessId,
                adId: insertedAd.id,
                slot: insertedAd.slot,
                mediaType
            });

            const enriched = await loadAdForBusiness(req.businessId, insertedAd.id);
            const updatedSlotUsage = await getAdSlotUsage(req.businessId);

            res.status(201).json({
                success: true,
                ad: enriched || insertedAd,
                slot_usage: updatedSlotUsage
            });
        } catch (err) {
            console.error('❌ Create ad error:', err);
            logError(err, 'Create ad');
            res.status(500).json({ error: 'Unable to create ad' });
        }
    }
);

// ============================================================
//  N — UPDATE AD
//
//  N.3 — Editing an ad NEVER changes its slot. Only the fields
//        the admin actually sent are written. Media is optional;
//        when omitted, the existing media is kept.
//
//  Section 2D — display_duration is clamped against the
//  *effective* media type: the new one when a replacement file
//  was uploaded, otherwise the one already stored on the row.
// ============================================================

router.put(
    '/ads/:id',
    authMiddleware,
    businessAdminOnly,
    getBusinessIdFromToken,
    upload.fields([{ name: 'media', maxCount: 1 }]),
    async (req, res) => {
        try {
            const adId = Number.parseInt(req.params.id, 10);
            if (!Number.isInteger(adId)) {
                return res.status(400).json({ error: 'Invalid ad id' });
            }

            const existing = await pool.query(
                'SELECT * FROM business_ads WHERE id = $1 AND business_id = $2',
                [adId, req.businessId]
            );
            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Ad not found' });
            }

            const current = existing.rows[0];
            const updates = [];
            const values = [];
            let paramIndex = 1;

            // N.3 — slot is deliberately NOT in the update list.
            // It is assigned at create time and never moves.

            // Media replacement (optional).
            const mediaFile = req.files && req.files.media && req.files.media[0];
            let nextMediaType = current.media_type;
            let nextMediaUrl = current.media_url;

            if (mediaFile) {
                const mime = String(mediaFile.mimetype || '').toLowerCase();
                nextMediaType = mime.startsWith('video/') ? 'video' : 'image';
                try {
                    nextMediaUrl = await uploadToCloudinary(mediaFile.path, {
                        folder: `business_shop/${req.businessId}/ads`,
                        ...(nextMediaType === 'video' ? { resource_type: 'video' } : {})
                    });
                } catch (uploadErr) {
                    console.error('Ad media upload error:', uploadErr);
                    return res.status(500).json({ error: 'Unable to upload ad media. Please try again.' });
                }
                updates.push(`media_type = $${paramIndex}`); values.push(nextMediaType); paramIndex++;
                updates.push(`media_url = $${paramIndex}`); values.push(nextMediaUrl); paramIndex++;
            }

            // Link type + target (only when the caller sent either of them).
            const linkTypeWasSent = req.body.link_type !== undefined;
            const targetWasSent = req.body.link_target_id !== undefined;
            if (linkTypeWasSent || targetWasSent) {
                const nextLinkType = linkTypeWasSent
                    ? parseLinkType(req.body.link_type)
                    : current.link_type;
                const rawTarget = targetWasSent ? req.body.link_target_id : current.link_target_id;
                const targetCheck = await validateAdLinkTarget(req.businessId, nextLinkType, rawTarget);
                if (!targetCheck.ok) {
                    return res.status(400).json({ error: targetCheck.error });
                }
                updates.push(`link_type = $${paramIndex}`); values.push(nextLinkType); paramIndex++;
                updates.push(`link_target_id = $${paramIndex}`); values.push(targetCheck.linkTargetId); paramIndex++;
            }

            if (req.body.title !== undefined) {
                const t = req.body.title;
                updates.push(`title = $${paramIndex}`);
                values.push(t ? String(t).trim().slice(0, 200) : null);
                paramIndex++;
            }

            if (req.body.description !== undefined) {
                const d = req.body.description;
                updates.push(`description = $${paramIndex}`);
                values.push(d ? String(d).trim().slice(0, 2000) : null);
                paramIndex++;
            }

            if (req.body.display_duration !== undefined) {
                // Section 2D — clamp against the effective media type.
                // If the caller sent a new media file, nextMediaType
                // is the new type; otherwise it is the type already
                // stored on the row.
                updates.push(`display_duration = $${paramIndex}`);
                values.push(clampAdDuration(nextMediaType, req.body.display_duration));
                paramIndex++;
            }

            if (req.body.is_active !== undefined) {
                updates.push(`is_active = $${paramIndex}`);
                values.push(!(req.body.is_active === 'false' || req.body.is_active === false));
                paramIndex++;
            }

            if (updates.length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            values.push(adId, req.businessId);
            const query = `
                UPDATE business_ads
                SET ${updates.join(', ')}, updated_at = NOW()
                WHERE id = $${paramIndex} AND business_id = $${paramIndex + 1}
                RETURNING *
            `;

            const result = await pool.query(query, values);

            await logAdminActivity(req.userId, 'UPDATE_AD', {
                businessId: req.businessId,
                adId,
                slot: result.rows[0].slot
            });

            const enriched = await loadAdForBusiness(req.businessId, adId);
            const slotUsage = await getAdSlotUsage(req.businessId);

            res.json({
                success: true,
                ad: enriched || result.rows[0],
                slot_usage: slotUsage
            });
        } catch (err) {
            console.error('❌ Update ad error:', err);
            logError(err, 'Update ad');
            res.status(500).json({ error: 'Unable to update ad' });
        }
    }
);

// ============================================================
//  N — TOGGLE AD ACTIVE STATE
//  A single endpoint for the "Active / Paused" switch in the
//  admin list. Slot is never touched.
// ============================================================

router.post('/ads/:id/toggle', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const adId = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(adId)) {
            return res.status(400).json({ error: 'Invalid ad id' });
        }

        const result = await pool.query(`
            UPDATE business_ads
            SET is_active = NOT is_active, updated_at = NOW()
            WHERE id = $1 AND business_id = $2
            RETURNING *
        `, [adId, req.businessId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        await logAdminActivity(req.userId, 'TOGGLE_AD', {
            businessId: req.businessId,
            adId,
            isActive: result.rows[0].is_active
        });

        const slotUsage = await getAdSlotUsage(req.businessId);

        res.json({
            success: true,
            ad: result.rows[0],
            slot_usage: slotUsage
        });
    } catch (err) {
        console.error('❌ Toggle ad error:', err);
        logError(err, 'Toggle ad');
        res.status(500).json({ error: 'Unable to toggle ad' });
    }
});

// ============================================================
//  N — DELETE AD
//
//  N.4 — Deleting an ad frees its slot. The other slots do NOT
//        shift. This is important: shifting would silently move
//        an existing ad's position in the marketplace rotation.
// ============================================================

router.delete('/ads/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const adId = Number.parseInt(req.params.id, 10);
        if (!Number.isInteger(adId)) {
            return res.status(400).json({ error: 'Invalid ad id' });
        }

        const result = await pool.query(
            'DELETE FROM business_ads WHERE id = $1 AND business_id = $2 RETURNING id, slot',
            [adId, req.businessId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        await logAdminActivity(req.userId, 'DELETE_AD', {
            businessId: req.businessId,
            adId,
            freedSlot: result.rows[0].slot
        });

        const slotUsage = await getAdSlotUsage(req.businessId);

        res.json({
            success: true,
            freed_slot: result.rows[0].slot,
            slot_usage: slotUsage
        });
    } catch (err) {
        console.error('❌ Delete ad error:', err);
        logError(err, 'Delete ad');
        res.status(500).json({ error: 'Unable to delete ad' });
    }
});

// ============================================================
//  ADD PRODUCT TO BUSINESS
//  B.1 — product_category_id is required
//  B.5 — Save blocked without a category
//  B.8 — Joined name echoed back in the response
// ============================================================

router.post('/products', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
    upload.fields([{ name: 'image', maxCount: 8 }, { name: 'video', maxCount: 4 }, { name: 'variantImages', maxCount: 20 }]),
    [
        body('name').notEmpty().withMessage('Product name required'),
        body('price').notEmpty().withMessage('Price required'),
        body('product_category_id').notEmpty().withMessage('Please select a product category')
    ],
    async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        try {
            const { product_category_id } = req.body;
            const productCategoryId = parseInt(product_category_id, 10);
            if (!Number.isInteger(productCategoryId)) {
                return res.status(400).json({ error: 'Please select a product category' });
            }
            const categoryCheck = await pool.query('SELECT id FROM product_categories WHERE id = $1 AND is_active = true', [productCategoryId]);
            if (categoryCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Selected product category does not exist or is not active' });
            }

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
                    name, price, old_price, discount_percent, category, product_category_id,
                    contact, rating,
                    badge1, badge2, shipping, isFlashSale, isNewArrival, image, video,
                    description, stock, business_id, is_active, images, videos
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                RETURNING *
            `, [
                name, price, old_price || null,
                discount_percent || null, category || null,
                productCategoryId,
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

            const enriched = await pool.query(`
                SELECT p.*, pc.name AS product_category_name, pc.slug AS product_category_slug
                FROM products p
                LEFT JOIN product_categories pc ON pc.id = p.product_category_id
                WHERE p.id = $1
            `, [product.id]);

            res.status(201).json({ success: true, product: enriched.rows[0] || product });
        } catch (err) {
            console.error('❌ Add product error:', err);
            logError(err, 'Add product');
            res.status(500).json({ error: err.message });
        }
    }
);

// ============================================================
//  UPDATE PRODUCT
//  B.1 / B.5 — product_category_id is required and validated
//  B.8 — Joined name echoed back
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
                name, price, old_price, discount_percent, category, product_category_id,
                contact, rating,
                badge1, badge2, shipping, isFlashSale, isNewArrival,
                description, stock, is_active, is_featured
            } = req.body;

            let productCategoryId = null;
            if (product_category_id !== undefined && product_category_id !== '') {
                productCategoryId = parseInt(product_category_id, 10);
                if (!Number.isInteger(productCategoryId)) {
                    return res.status(400).json({ error: 'Please select a product category' });
                }
                const categoryCheck = await pool.query('SELECT id FROM product_categories WHERE id = $1 AND is_active = true', [productCategoryId]);
                if (categoryCheck.rows.length === 0) {
                    return res.status(400).json({ error: 'Selected product category does not exist or is not active' });
                }
            } else if (!productCheck.rows[0].product_category_id) {
                return res.status(400).json({ error: 'Please select a product category' });
            }

            const result = await pool.query(`
                UPDATE products
                SET name = COALESCE($1, name),
                    price = COALESCE($2, price),
                    old_price = COALESCE($3, old_price),
                    discount_percent = COALESCE($4, discount_percent),
                    category = COALESCE($5, category),
                    product_category_id = COALESCE($6, product_category_id),
                    contact = COALESCE($7, contact),
                    rating = COALESCE($8, rating),
                    badge1 = COALESCE($9, badge1),
                    badge2 = COALESCE($10, badge2),
                    shipping = COALESCE($11, shipping),
                    isFlashSale = COALESCE($12, isFlashSale),
                    isNewArrival = COALESCE($13, isNewArrival),
                    image = COALESCE($14, image),
                    video = COALESCE($15, video),
                    description = COALESCE($16, description),
                    stock = COALESCE($17, stock),
                    is_active = COALESCE($18, is_active),
                    is_featured = COALESCE($19, is_featured),
                    images = $20,
                    videos = $21
                WHERE id = $22 AND business_id = $23
                RETURNING *
            `, [
                name || null,
                price || null,
                old_price || null,
                discount_percent || null,
                category || null,
                productCategoryId,
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

            const enriched = await pool.query(`
                SELECT p.*, pc.name AS product_category_name, pc.slug AS product_category_slug
                FROM products p
                LEFT JOIN product_categories pc ON pc.id = p.product_category_id
                WHERE p.id = $1
            `, [productId]);

            res.json({ success: true, product: enriched.rows[0] || result.rows[0] });
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

// ============================================================
//  BATCH PRODUCT CREATE
//  B.1 / B.5 — Each product needs a valid product_category_id
// ============================================================

router.post('/products/batch', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    const products = Array.isArray(req.body.products) ? req.body.products : [];
    if (!products.length || products.length > 100) return res.status(400).json({ error: 'Provide 1 to 100 products' });
    if (products.some(product => !String(product.name || '').trim() || product.price === undefined || product.price === '')) {
        return res.status(400).json({ error: 'Every product needs a name and price' });
    }
    if (products.some(product => !product.product_category_id)) {
        return res.status(400).json({ error: 'Please select a product category for every product' });
    }

    const categoryIds = [...new Set(products.map(p => parseInt(p.product_category_id, 10)).filter(Number.isInteger))];
    if (categoryIds.length !== products.length && products.some(p => !Number.isInteger(parseInt(p.product_category_id, 10)))) {
        return res.status(400).json({ error: 'One or more product categories are invalid' });
    }

    const client = await pool.connect();
    try {
        const validCategories = await client.query(
            'SELECT id FROM product_categories WHERE id = ANY($1::int[]) AND is_active = true',
            [categoryIds]
        );
        if (validCategories.rows.length !== categoryIds.length) {
            return res.status(400).json({ error: 'One or more selected product categories do not exist or are inactive' });
        }

        await client.query('BEGIN');
        const created = [];
        for (const product of products) {
            const result = await client.query(
                `INSERT INTO products (name, price, old_price, category, product_category_id, description, stock, business_id, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
                [String(product.name).trim(), product.price, product.old_price || null, product.category || null,
                    parseInt(product.product_category_id, 10),
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
//  Section I.6 — mpesa_environment is included so the admin
//  panel can render the read-only environment badge without a
//  second request.
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

        const settings = result.rows[0];

        // I.6 — read-only environment label. It is a platform-wide
        // value (process.env.MPESA_ENVIRONMENT), not a per-business
        // setting, so it is returned here as a display hint only and
        // is never writable through /payment-settings.
        settings.mpesa_environment = (process.env.MPESA_ENVIRONMENT || 'sandbox').toLowerCase();

        res.json(settings);
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

        const updates = [];
        const values = [];
        let paramIndex = 1;

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

        updates.push(`updated_at = NOW()`);
        values.push(req.businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

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

        const systemSettings = await pool.query(`SELECT key, value FROM system_settings`);
        const settingsMap = {};
        systemSettings.rows.forEach(row => { settingsMap[row.key] = row.value; });

        const settings = result.rows[0];

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

        updates.push(`updated_at = NOW()`);
        values.push(req.businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

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

// ============================================================
//  SECTION 11.B — BUSINESS ACCOUNT DELETION
//
//  POST /request-deletion
//    Required: password, reason.
//    Verifies the password against the admin's hash, then:
//      1. Schedules the deletion 60 days out on the business row.
//      2. Stores the reason.
//      3. Sets businesses.is_active = FALSE immediately, which
//         hides the shop from the marketplace.
//      4. Sets admin_users.is_active = FALSE for the owner.
//    Does NOT log the admin out — the client does that.
//
//    If the admin logs back in during the grace period, the
//    POST /api/auth/business/login handler in auth.js will
//    clear the pending deletion and reactivate both rows.
//
//  POST /cancel-deletion
//    Cancels a pending deletion on the requesting admin's own
//    business and reactivates both the business and the admin
//    account. Returns { cancelled: false } when there is
//    nothing to cancel, so the client can be idempotent.
//
//  Both routes reuse authMiddleware, businessAdminOnly, and
//  getBusinessIdFromToken so they are protected exactly like
//  every other route in this file.
// ============================================================

router.post('/request-deletion', authMiddleware, businessAdminOnly, getBusinessIdFromToken, [
    body('password').notEmpty().withMessage('Password required'),
    body('reason').notEmpty().withMessage('Reason required')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const adminId = req.userId;
        const businessId = req.businessId;

        if (!adminId || !businessId) {
            return res.status(400).json({ error: 'Invalid admin session.' });
        }

        const { password, reason } = req.body;

        if (!BUSINESS_DELETION_REASONS.has(String(reason))) {
            return res.status(400).json({ error: 'Please select a valid reason.' });
        }

        const adminResult = await pool.query(
            'SELECT id, password, business_id, is_active FROM admin_users WHERE id = $1',
            [adminId]
        );

        if (adminResult.rows.length === 0) {
            return res.status(404).json({ error: 'Admin not found' });
        }

        const admin = adminResult.rows[0];

        if (admin.business_id !== businessId) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (!admin.password) {
            return res.status(400).json({ error: 'This account cannot be scheduled for deletion.' });
        }

        const passwordOk = await bcrypt.compare(password, admin.password);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        await pool.query('BEGIN');

        const result = await pool.query(`
            UPDATE businesses
            SET deletion_scheduled_at = NOW() + ($1::text || ' days')::interval,
                deletion_reason = $2,
                is_active = FALSE,
                updated_at = NOW()
            WHERE id = $3
            RETURNING deletion_scheduled_at, deletion_reason
        `, [String(BUSINESS_DELETION_GRACE_DAYS), String(reason).slice(0, 100), businessId]);

        await pool.query(
            'UPDATE admin_users SET is_active = FALSE WHERE id = $1',
            [adminId]
        );

        await pool.query('COMMIT');

        const row = result.rows[0];

        await logAdminActivity(adminId, 'REQUEST_BUSINESS_DELETION', {
            businessId,
            reason,
            scheduled_for: row.deletion_scheduled_at
        });

        console.log(`🗓️ Business #${businessId} deletion scheduled for ${row.deletion_scheduled_at}.`);

        res.json({
            success: true,
            message: `Your business is scheduled for deletion in ${BUSINESS_DELETION_GRACE_DAYS} days.`,
            deletion_scheduled_for: row.deletion_scheduled_at,
            deletion_reason: row.deletion_reason,
            grace_days: BUSINESS_DELETION_GRACE_DAYS
        });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('❌ Business request-deletion error:', err);
        logError(err, 'Business request-deletion');
        res.status(500).json({ error: 'Could not schedule business deletion.' });
    }
});

router.post('/cancel-deletion', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
    try {
        const adminId = req.userId;
        const businessId = req.businessId;

        if (!adminId || !businessId) {
            return res.status(400).json({ error: 'Invalid admin session.' });
        }

        await pool.query('BEGIN');

        const result = await pool.query(`
            UPDATE businesses
            SET deletion_scheduled_at = NULL,
                deletion_reason = NULL,
                is_active = TRUE,
                updated_at = NOW()
            WHERE id = $1 AND deletion_scheduled_at IS NOT NULL
            RETURNING id
        `, [businessId]);

        await pool.query(
            'UPDATE admin_users SET is_active = TRUE WHERE id = $1',
            [adminId]
        );

        await pool.query('COMMIT');

        if (result.rows.length === 0) {
            return res.json({
                success: true,
                cancelled: false,
                message: 'No pending deletion to cancel.'
            });
        }

        await logAdminActivity(adminId, 'CANCEL_BUSINESS_DELETION', { businessId });

        console.log(`♻️ Business #${businessId} deletion cancelled on request.`);
        res.json({
            success: true,
            cancelled: true,
            message: 'Your business is safe.'
        });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error('❌ Business cancel-deletion error:', err);
        logError(err, 'Business cancel-deletion');
        res.status(500).json({ error: 'Could not cancel business deletion.' });
    }
});

module.exports = router;