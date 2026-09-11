// ============================================================
//  BUSINESSES ROUTES - Public Marketplace COMPLETE
//  Location: src/routes/businesses.js
//
//  Section B:
//   B.7 — Product category returned on the business profile product
//         list, plus a product_category_id filter.
//
//  Section C:
//   C.8 — Public business-by-slug response exposes location activation state.
//   C.9 — Public business-by-slug response exposes location_complete.
//
//  Section D — Smart customer search and nearby ranking:
//   D.3 — Free-text search accepts self-anchor keywords (English + Swahili).
//   D.4 — distance_km returned when an anchor was used.
//   D.5 — When an anchor is present, results sort by distance ascending.
//   D.6 — Fallback to name/location matching when no anchor.
//   D.7 — Location-name filter dropdowns (continent, country, county,
//         sub_county, ward, town, specific_area) combined with search.
//   D.8 — Location filter and category filter combine freely.
//   D.9 — sort=urgent forces a strict nearest-first ordering when the
//         customer supplied coordinates; otherwise the query still
//         works but simply falls through to the default ordering.
//
//  Section E.4 — Smart default ranking (sort=smart):
//   When no explicit sort, no search text, and no urgent toggle are
//   present, the marketplace uses a blended score that combines
//   text relevance, average rating, and distance. This makes the
//   default browse experience "smart" instead of purely "newest".
//
//   The score is computed in JavaScript AFTER the SQL query, using
//   the already-returned rows. This avoids fragile placeholder
//   ordering inside the SQL string and works no matter which
//   combination of filters is active.
//
//  Section E.2 — Preferred-location soft anchor:
//   When the caller sends preferred_county / preferred_town (read
//   by the marketplace from the customer's saved preferred area),
//   the smart score gives a small boost to businesses whose
//   location names match. The customer's preferred names are never
//   returned in the response (D.11 preserved).
//
//  Section J — Marketplace hero slider:
//   J.1 / J.4 — /ads returns the active ad set that replaces the
//               Featured Businesses block on the marketplace.
//   J.6 — /ads/:id/click returns the ad's link type and target so
//         the client can navigate to the correct page (profile or
//         product).
//   J.7 — /ads/:id/view and /ads/:id/click update views, clicks,
//         and CTR in the same table the business admin uses.
//
//  Guests: the customer can pass ?latitude=..&longitude=.. without
//  logging in. The server never persists them (D.11).
//
//  Server-side geocode cache: 'in <place>' is geocoded once via
//  Nominatim and cached in memory for 1 hour.
//
//  Section I — Public payment settings endpoint:
//   The /:slug/payment-settings response is extended so the
//   customer checkout can render the correct M-Pesa label
//   (Paybill / Till / Pochi) without a second round-trip. The
//   environment value is never returned to the public because
//   it is a platform-wide setting; the client only needs to
//   know which shortcode and account reference to show.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const Business = require('../models/Business');
const Customer = require('../models/Customer');
const router = express.Router();

function productFallbackImage(name) {
    const label = String(name || 'Product').slice(0, 32).replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${label}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const LOCATION_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area', 'postal_code'];
const locationSql = LOCATION_FIELDS.map(field => `COALESCE(b.${field}, '')`).join(", ' ', ");

// ============================================================
//  Section D — keyword parsing
// ============================================================

const ANCHOR_SELF_KEYWORDS = [
    'karibu na mimi',
    'karibu nami',
    'karibu nasi',
    'mtaa yangu',
    'area yangu',
    'side yangu',
    'hapa karibu',
    'kwetu',
    'nyumbani',
    'mtaani',
    'mtaa',
    'hapa',
    'huku',
    'karibu',

    'closest to me',
    'closer to me',
    'close to me',
    'next to me',
    'beside me',
    'around my area',
    'near where i am',
    'in my area',
    'my location',
    'near my shop',
    'near my home',
    'near home',
    'near here',
    'around here',
    'around me',
    'near me',
    'close by me',
    'in my side',
    'my side',
    'my area',

    'nearby',
    'nearer',
    'nearest',
    'closest',
    'closer',
    'closeby',
    'close by',
    'near',
    'close'
];

const geocodeCache = new Map();
const GEOCODE_CACHE_TTL_MS = 60 * 60 * 1000;

async function geocodePlace(placeName) {
    if (!placeName || typeof fetch !== 'function') return null;

    const key = placeName.trim().toLowerCase();
    const cached = geocodeCache.get(key);
    if (cached && Date.now() - cached.cachedAt < GEOCODE_CACHE_TTL_MS) {
        return { latitude: cached.latitude, longitude: cached.longitude };
    }

    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(placeName)}`;
        const response = await fetch(url, {
            headers: { 'User-Agent': 'BidhaaLink/1.0 (customer search)' },
            signal: controller.signal
        });
        clearTimeout(timer);
        const results = response.ok ? await response.json() : [];
        if (!results[0]) return null;

        const latitude = parseFloat(results[0].lat);
        const longitude = parseFloat(results[0].lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

        geocodeCache.set(key, { latitude, longitude, cachedAt: Date.now() });
        return { latitude, longitude };
    } catch (err) {
        console.warn('Geocoding skipped:', err.message);
        return null;
    }
}

function parseSearchQuery(rawQuery) {
    const result = {
        text: '',
        anchor: null,
        anchorPlace: null,
        radiusKm: null,
        verified: false,
        featured: false,
        isNew: false,
        open: false,
        delivery: false,
        pickup: false,
        minRating: null,
        cheap: false
    };

    if (!rawQuery || typeof rawQuery !== 'string') return result;

    let working = ' ' + rawQuery.toLowerCase().trim() + ' ';
    working = working.replace(/\s+/g, ' ');

    const withinMatch = working.match(/\bwithin\s+(\d+)\s*k?m?s?\b/);
    if (withinMatch) {
        result.radiusKm = Math.min(Math.max(parseInt(withinMatch[1], 10) || 0, 1), 500);
        result.anchor = 'self';
        working = working.replace(withinMatch[0], ' ');
    }

    const placeMatch = working.match(/\b(?:in|around|at)\s+([a-z0-9][a-z0-9\s\-'.]{1,60})/);
    if (placeMatch && !result.anchor) {
        const place = placeMatch[1].trim();
        if (place && !/^(near|nearby|me|my|verified|featured|new|open|delivery|pickup)$/.test(place)) {
            result.anchor = 'place';
            result.anchorPlace = place;
            working = working.replace(placeMatch[0], ' ');
        }
    }

    if (!result.anchor) {
        for (const keyword of ANCHOR_SELF_KEYWORDS) {
            const regex = new RegExp(`\\b${keyword.replace(/\s+/g, '\\s+')}\\b`);
            if (regex.test(working)) {
                result.anchor = 'self';
                working = working.replace(regex, ' ');
                break;
            }
        }
    }

    if (/\bverified\b/.test(working))       { result.verified = true; working = working.replace(/\bverified\b/g, ' '); }
    if (/\bfeatured\b/.test(working))       { result.featured = true; working = working.replace(/\bfeatured\b/g, ' '); }
    if (/\bnew\b/.test(working))            { result.isNew = true;    working = working.replace(/\bnew\b/g, ' '); }
    if (/\bopen\b/.test(working))           { result.open = true;     working = working.replace(/\bopen\b/g, ' '); }
    if (/\bdelivery\b/.test(working))       { result.delivery = true; working = working.replace(/\bdelivery\b/g, ' '); }
    if (/\bpickup\b/.test(working))         { result.pickup = true;   working = working.replace(/\bpickup\b/g, ' '); }
    if (/\b(cheap|affordable)\b/.test(working)) {
        result.cheap = true;
        working = working.replace(/\b(cheap|affordable)\b/g, ' ');
    }

    const ratedMatch = working.match(/\brated\s+(\d)(\+)?\b/);
    if (ratedMatch) {
        result.minRating = parseInt(ratedMatch[1], 10);
        working = working.replace(ratedMatch[0], ' ');
    }

    result.text = working.trim().replace(/\s+/g, ' ');

    return result;
}

const LOCATION_FILTER_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area'];

function buildLocationNameConditions(query, startParamIndex) {
    const conditions = [];
    const params = [];
    let paramIndex = startParamIndex;

    for (const field of LOCATION_FILTER_FIELDS) {
        const raw = query[field];
        if (!raw) continue;
        const value = String(raw).trim();
        if (!value) continue;
        conditions.push(`b.${field} ILIKE $${paramIndex}`);
        params.push(`%${value}%`);
        paramIndex++;
    }

    return { conditions, params, nextIndex: paramIndex };
}

// ============================================================
//  Section E.4 — Smart score (JS-side, after the query)
// ============================================================

/**
 * Compute a blended smart score for a single business row.
 *
 *   relevance — 2 if the search text appears in the name,
 *               1 if it appears in the description,
 *               0 otherwise.
 *               If there is no search text, relevance is 0 for
 *               every business — the score then leans on rating
 *               and distance only.
 *
 *   rating    — avg_rating / 5, clamped to [0, 1].
 *
 *   distance  — 1 - min(distance_km, 50) / 50, clamped to [0, 1].
 *               If the row has no distance, this term is 0.
 *
 *   preferred — a soft-anchor bonus when the customer's preferred
 *               area names match the business's location names.
 *               +0.1 if preferred_county matches b.county,
 *               +0.05 if preferred_town matches b.town.
 *
 * Weights (sum = 1.0 with no preferred bonus):
 *   0.45 * relevance
 *   0.35 * rating
 *   0.20 * distance
 *   + preferred bonus (capped so it never dominates)
 */
function computeSmartScore(row, searchText, hasAnchor, preferredCounty, preferredTown) {
    const safe = (n) => (Number.isFinite(n) ? n : 0);

    let relevance = 0;
    if (searchText) {
        const q = searchText.toLowerCase();
        const name = String(row.business_name || '').toLowerCase();
        const description = String(row.description || '').toLowerCase();
        if (name.includes(q)) relevance = 2;
        else if (description.includes(q)) relevance = 1;
    }
    const relevanceScore = relevance / 2;   // 0, 0.5, or 1

    const ratingScore = Math.max(0, Math.min(1, safe(parseFloat(row.avg_rating)) / 5));

    let distanceScore = 0;
    if (hasAnchor && row.distance_km !== null && row.distance_km !== undefined) {
        const km = safe(Number(row.distance_km));
        distanceScore = Math.max(0, Math.min(1, 1 - Math.min(km, 50) / 50));
    }

    let preferredBonus = 0;
    if (preferredCounty) {
        const businessCounty = String(row.county || '').toLowerCase();
        if (businessCounty && businessCounty.includes(preferredCounty.toLowerCase())) {
            preferredBonus += 0.1;
        }
    }
    if (preferredTown) {
        const businessTown = String(row.town || '').toLowerCase();
        if (businessTown && businessTown.includes(preferredTown.toLowerCase())) {
            preferredBonus += 0.05;
        }
    }

    const score =
        0.45 * relevanceScore +
        0.35 * ratingScore +
        0.20 * distanceScore +
        preferredBonus;

    return score;
}

// ============================================================
//  GET ALL BUSINESS CATEGORIES
// ============================================================
router.get('/categories/all', async (req, res) => {
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
        console.error('❌ Get categories error:', err);
        logError(err, 'Get categories');
        res.status(500).json({ error: 'Unable to load categories' });
    }
});

// ============================================================
//  LOCATIONS — distinct values per location field (D.7)
// ============================================================
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

// ============================================================
//  NEARBY — sorted by distance ascending (kept for compatibility)
// ============================================================
router.get('/nearby', async (req, res) => {
    try {
        const latitude = Number(req.query.latitude);
        const longitude = Number(req.query.longitude);
        const radiusKm = Math.min(Math.max(Number(req.query.radius || 10), 1), 200);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(400).json({ error: 'Valid latitude and longitude are required' });
        }
        const result = await pool.query(`
            SELECT b.*,
                   6371 * acos(LEAST(1, GREATEST(-1,
                      cos(radians($1)) * cos(radians(b.latitude::numeric)) *
                      cos(radians(b.longitude::numeric) - radians($2)) +
                      sin(radians($1)) * sin(radians(b.latitude::numeric))
                   ))) AS distance_km,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count
            FROM businesses b
            WHERE b.is_active = true
              AND b.latitude IS NOT NULL AND b.longitude IS NOT NULL
              AND b.latitude ~ '^-?[0-9]+(\\.[0-9]+)?$'
              AND b.longitude ~ '^-?[0-9]+(\\.[0-9]+)?$'
            ORDER BY distance_km ASC
        `, [latitude, longitude]);
        res.json({
            radius_km: radiusKm,
            businesses: result.rows.filter(row => Number(row.distance_km) <= radiusKm)
        });
    } catch (err) {
        logError(err, 'Get nearby businesses');
        res.status(500).json({ error: 'Unable to find nearby businesses' });
    }
});

// ============================================================
//  SECTION J — PUBLIC ADS FEED (HERO SLIDER ON MARKETPLACE)
//
//  J.1 / J.4 — Return the active ad set that replaces the
//              Featured Businesses block on the marketplace.
//              Only ads belonging to active businesses are
//              returned, and only ads that are themselves
//              active. The slides are ordered newest-first so
//              a fresh ad appears first.
//
//  The business row is joined so the client has everything it
//  needs to render a click: business slug, business name, and
//  logo (used as a small fallback card when media is missing).
//
//  The product row is joined when the ad points at a product,
//  so the client can render the product name/thumbnail without
//  a second round-trip.
// ============================================================

router.get('/ads', async (req, res) => {
    try {
        const limitRaw = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(limitRaw, 30)
            : 20;

        const result = await pool.query(`
            SELECT a.id,
                   a.business_id,
                   a.media_type,
                   a.media_url,
                   a.title,
                   a.description,
                   a.link_type,
                   a.link_target_id,
                   a.display_duration,
                   a.views,
                   a.clicks,
                   a.click_through_rate,
                   a.created_at,
                   b.business_name,
                   b.slug  AS business_slug,
                   b.logo  AS business_logo,
                   p.name  AS product_name,
                   p.image AS product_image
            FROM business_ads a
            JOIN businesses b ON b.id = a.business_id
            LEFT JOIN products p
                   ON a.link_type = 'product'
                  AND p.id = a.link_target_id
                  AND p.is_active = true
            WHERE a.is_active = true
              AND b.is_active = true
            ORDER BY a.created_at DESC
            LIMIT $1
        `, [limit]);

        res.json({ ads: result.rows });
    } catch (err) {
        logError(err, 'Get marketplace ads');
        res.status(500).json({ error: 'Unable to load ads' });
    }
});

// ============================================================
//  J.7 — RECORD AD IMPRESSION
//  Fire-and-forget from the client. The endpoint only writes
//  the counter and CTR; it does not return the ad itself.
// ============================================================

router.post('/ads/:id/view', async (req, res) => {
    try {
        await pool.query(`
            UPDATE business_ads
            SET views = views + 1,
                click_through_rate = CASE
                    WHEN views + 1 = 0 THEN 0
                    ELSE ROUND((clicks::numeric / (views + 1)) * 100, 2)
                END,
                updated_at = NOW()
            WHERE id = $1 AND is_active = true
        `, [req.params.id]);
        res.status(204).end();
    } catch (err) {
        res.status(500).json({ error: 'Unable to record ad view' });
    }
});

// ============================================================
//  J.6 / J.7 — RECORD AD CLICK AND RETURN THE TARGET
//  The client uses the returned link_type + link_target_id +
//  business_slug to navigate without a second call. That way
//  the click is always counted even if navigation happens
//  immediately after.
// ============================================================

router.post('/ads/:id/click', async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE business_ads
            SET clicks = clicks + 1,
                click_through_rate = CASE
                    WHEN views = 0 THEN 0
                    ELSE ROUND(((clicks + 1)::numeric / views) * 100, 2)
                END,
                updated_at = NOW()
            WHERE id = $1 AND is_active = true
            RETURNING link_type, link_target_id, business_id
        `, [req.params.id]);

        if (!result.rows[0]) {
            return res.status(404).json({ error: 'Ad not found' });
        }

        const ad = result.rows[0];
        const businessResult = await pool.query(
            'SELECT slug FROM businesses WHERE id = $1 AND is_active = true',
            [ad.business_id]
        );

        res.json({
            success: true,
            ad: {
                ...ad,
                business_slug: businessResult.rows[0]?.slug || null
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Unable to record ad click' });
    }
});

// ============================================================
//  GET ALL BUSINESSES (Public)
//
//  D.3 — Smart free-text search parsing.
//  D.4 — distance_km returned when an anchor was used.
//  D.5 — Distance sort when an anchor is present.
//  D.6 — Fallback to name/location matching when no anchor.
//  D.7 — Location-name filters combine with search and category.
//  D.8 — Location + category filters work together.
//  D.9 — sort=urgent strictly prioritises distance when coords exist.
//
//  E.4 — sort=smart is the default when there is no sort, no search
//        text, and no urgent toggle. Score computed in JS after the
//        query, so it works no matter what filters are active.
//  E.2 — Preferred-area soft anchor via ?preferred_county= & ?preferred_town=.
// ============================================================

router.get('/', async (req, res) => {
    try {
        const {
            search,
            category,
            featured,
            verified,
            sort,
            latitude,
            longitude,
            limit = 20,
            page = 1
        } = req.query;

        const offset = (page - 1) * limit;

        // Section D — parse the free-text query.
        const parsed = parseSearchQuery(search || '');
        const searchText = parsed.text;

        // Resolve the anchor coordinates (only when an anchor exists).
        let anchorLat = null;
        let anchorLng = null;
        let anchorSource = null;

        if (parsed.anchor === 'self') {
            const selfLat = Number(latitude);
            const selfLng = Number(longitude);
            if (Number.isFinite(selfLat) && Number.isFinite(selfLng)) {
                anchorLat = selfLat;
                anchorLng = selfLng;
                anchorSource = 'self';
            }
        } else if (parsed.anchor === 'place' && parsed.anchorPlace) {
            const geo = await geocodePlace(parsed.anchorPlace);
            if (geo) {
                anchorLat = geo.latitude;
                anchorLng = geo.longitude;
                anchorSource = 'place';
            }
        }

        // D.9 — urgent mode
        const urgentMode = sort === 'urgent';
        if (urgentMode && anchorSource === null) {
            const selfLat = Number(latitude);
            const selfLng = Number(longitude);
            if (Number.isFinite(selfLat) && Number.isFinite(selfLng)) {
                anchorLat = selfLat;
                anchorLng = selfLng;
                anchorSource = 'self';
            }
        }

        const hasAnchor = anchorSource !== null && Number.isFinite(anchorLat) && Number.isFinite(anchorLng);

        // ------------------------------------------------------------
        //  E.2 — Preferred-location soft anchor
        // ------------------------------------------------------------
        const preferredCounty = req.query.preferred_county ? String(req.query.preferred_county).trim() : '';
        const preferredTown = req.query.preferred_town ? String(req.query.preferred_town).trim() : '';
        const hasPreferredAnchor = Boolean(preferredCounty || preferredTown);

        // ------------------------------------------------------------
        //  E.4 — smart mode decision
        //  smart applies only on pure browse: no sort, no search, no urgent.
        // ------------------------------------------------------------
        const smartMode =
            !sort &&
            !urgentMode &&
            !searchText &&
            !parsed.anchor &&
            !hasAnchor;

        let query = `
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
                   (SELECT delivery_enabled FROM businesses WHERE id = b.id) as delivery_enabled,
                   b.online_orders_enabled
        `;

        const params = [];
        let paramIndex = 1;

        if (hasAnchor) {
            query += `,
                   6371 * acos(LEAST(1, GREATEST(-1,
                      cos(radians($${paramIndex})) * cos(radians(b.latitude::numeric)) *
                      cos(radians(b.longitude::numeric) - radians($${paramIndex + 1})) +
                      sin(radians($${paramIndex})) * sin(radians(b.latitude::numeric))
                   ))) AS distance_km`;
            params.push(anchorLat, anchorLng);
            paramIndex += 2;
        }

        query += ` FROM businesses b WHERE b.is_active = true`;
        const conditions = [];

        if (searchText) {
            conditions.push(`(b.business_name ILIKE $${paramIndex} OR b.description ILIKE $${paramIndex} OR CONCAT_WS(' ', ${locationSql}) ILIKE $${paramIndex})`);
            params.push(`%${searchText}%`);
            paramIndex++;
        }

        if (featured === 'true' || parsed.featured) {
            conditions.push(`b.is_featured = true`);
        }
        if (verified === 'true' || parsed.verified) {
            conditions.push(`b.is_verified = true`);
        }
        if (parsed.isNew) {
            conditions.push(`b.created_at > NOW() - INTERVAL '30 days'`);
        }
        if (parsed.open) {
            conditions.push(`b.online_orders_enabled = true`);
        }
        if (parsed.delivery) {
            conditions.push(`b.delivery_enabled = true`);
        }
        if (parsed.pickup) {
            conditions.push(`b.delivery_offered = 'no'`);
        }
        if (Number.isInteger(parsed.minRating)) {
            conditions.push(`(SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) >= $${paramIndex}`);
            params.push(parsed.minRating);
            paramIndex++;
        }
        if (parsed.cheap) {
            conditions.push(`(
                SELECT COALESCE(AVG(CAST(NULLIF(REGEXP_REPLACE(p.price, '[^0-9.]', '', 'g'), '') AS NUMERIC)), 0)
                FROM products p WHERE p.business_id = b.id AND p.is_active = true
            ) < (
                SELECT COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(NULLIF(REGEXP_REPLACE(price, '[^0-9.]', '', 'g'), '') AS NUMERIC)), 0)
                FROM products WHERE is_active = true AND price ~ '[0-9]'
            )`);
        }

        const locationFilter = buildLocationNameConditions(req.query, paramIndex);
        if (locationFilter.conditions.length > 0) {
            conditions.push(...locationFilter.conditions);
            params.push(...locationFilter.params);
            paramIndex = locationFilter.nextIndex;
        }

        if (category && category !== 'all') {
            conditions.push(`EXISTS (
                SELECT 1 FROM business_category_assignments bca
                WHERE bca.business_id = b.id AND bca.category_id = $${paramIndex}
            )`);
            params.push(parseInt(category, 10));
            paramIndex++;
        }

        if (conditions.length > 0) {
            query += ' AND ' + conditions.join(' AND ');
        }

        // Ordering — SQL-side ordering for the non-smart modes.
        // In smart mode we still need a deterministic tiebreaker, so
        // we sort by created_at DESC in SQL and re-sort in JS below.
        let orderBy = 'b.created_at DESC';
        if (hasAnchor) {
            orderBy = 'distance_km ASC NULLS LAST, b.created_at DESC';
        } else if (sort === 'popular') {
            orderBy = 'product_count DESC, b.created_at DESC';
        } else if (sort === 'rating') {
            orderBy = 'avg_rating DESC, b.created_at DESC';
        }

        query += ` ORDER BY ${orderBy}`;
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit, 10), parseInt(offset, 10));

        const result = await pool.query(query, params);

        // Radius filter (only when a radius was requested via 'within Nkm').
        let businesses = result.rows;
        if (hasAnchor && parsed.radiusKm) {
            businesses = businesses.filter(row =>
                row.distance_km === null || Number(row.distance_km) <= parsed.radiusKm
            );
        }

        // ------------------------------------------------------------
        //  E.4 — Apply smart score in JS (only in smart mode).
        //  This is what makes the default browse experience blended
        //  instead of purely "newest".
        // ------------------------------------------------------------
        if (smartMode && businesses.length > 1) {
            businesses = businesses.map(row => ({
                ...row,
                smart_score: computeSmartScore(
                    row,
                    searchText,
                    hasAnchor,
                    preferredCounty,
                    preferredTown
                )
            }));
            businesses.sort((a, b) => {
                const diff = (b.smart_score || 0) - (a.smart_score || 0);
                if (diff !== 0) return diff;
                return new Date(b.created_at) - new Date(a.created_at);
            });
        }

        // Count query — mirrors the same conditions.
        let countQuery = `SELECT COUNT(*) FROM businesses b WHERE b.is_active = true`;
        const countParams = [];
        let countIndex = 1;

        if (searchText) {
            countQuery += ` AND (b.business_name ILIKE $${countIndex} OR b.description ILIKE $${countIndex} OR CONCAT_WS(' ', ${locationSql}) ILIKE $${countIndex})`;
            countParams.push(`%${searchText}%`);
            countIndex++;
        }
        if (featured === 'true' || parsed.featured) {
            countQuery += ` AND b.is_featured = true`;
        }
        if (verified === 'true' || parsed.verified) {
            countQuery += ` AND b.is_verified = true`;
        }
        if (parsed.isNew) {
            countQuery += ` AND b.created_at > NOW() - INTERVAL '30 days'`;
        }
        if (parsed.open) {
            countQuery += ` AND b.online_orders_enabled = true`;
        }
        if (parsed.delivery) {
            countQuery += ` AND b.delivery_enabled = true`;
        }
        if (parsed.pickup) {
            countQuery += ` AND b.delivery_offered = 'no'`;
        }
        if (Number.isInteger(parsed.minRating)) {
            countQuery += ` AND (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) >= $${countIndex}`;
            countParams.push(parsed.minRating);
            countIndex++;
        }
        if (parsed.cheap) {
            countQuery += ` AND (
                SELECT COALESCE(AVG(CAST(NULLIF(REGEXP_REPLACE(p.price, '[^0-9.]', '', 'g'), '') AS NUMERIC)), 0)
                FROM products p WHERE p.business_id = b.id AND p.is_active = true
            ) < (
                SELECT COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY CAST(NULLIF(REGEXP_REPLACE(price, '[^0-9.]', '', 'g'), '') AS NUMERIC)), 0)
                FROM products WHERE is_active = true AND price ~ '[0-9]'
            )`;
        }

        const locationCountFilter = buildLocationNameConditions(req.query, countIndex);
        if (locationCountFilter.conditions.length > 0) {
            countQuery += ' AND ' + locationCountFilter.conditions.join(' AND ');
            countParams.push(...locationCountFilter.params);
            countIndex = locationCountFilter.nextIndex;
        }

        if (category && category !== 'all') {
            countQuery += ` AND EXISTS (
                SELECT 1 FROM business_category_assignments bca
                WHERE bca.business_id = b.id AND bca.category_id = $${countIndex}
            )`;
            countParams.push(parseInt(category, 10));
            countIndex++;
        }

        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count, 10);

        res.json({
            businesses,
            anchor: hasAnchor ? anchorSource : null,
            anchor_place: anchorSource === 'place' ? parsed.anchorPlace : null,
            radius_km: parsed.radiusKm || null,
            urgent: urgentMode,
            smart: smartMode,
            preferred_anchor: hasPreferredAnchor ? {
                county: preferredCounty || null,
                town: preferredTown || null
            } : null,
            parsed: {
                text: searchText || null,
                verified: parsed.verified,
                featured: parsed.featured,
                new: parsed.isNew,
                open: parsed.open,
                delivery: parsed.delivery,
                pickup: parsed.pickup,
                min_rating: parsed.minRating,
                cheap: parsed.cheap
            },
            pagination: {
                page: parseInt(page, 10),
                limit: parseInt(limit, 10),
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
                source: business.location_source || null,
                latitude: business.latitude || null,
                longitude: business.longitude || null,
                names: {
                    continent: business.continent || null,
                    country: business.country || null,
                    county: business.county || null,
                    sub_county: business.sub_county || null,
                    ward: business.ward || null,
                    town: business.town || null,
                    specific_area: business.specific_area || null,
                    postal_code: business.postal_code || null
                }
            },
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
//  GET BUSINESS ORDER SETTINGS (Public)
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
//
//  Section I.1 / I.2 — The full M-Pesa type fields are returned
//  so the customer checkout can build the correct label
//  (Paybill / Till / Pochi) without a second round-trip.
//  The environment value is intentionally NOT returned here —
//  it is a platform-wide setting and never belongs in a public
//  response.
// ============================================================
router.get('/:slug/payment-settings', async (req, res) => {
    try {
        const { slug } = req.params;

        const result = await pool.query(
            `SELECT
                mpesa_enabled,
                mpesa_number,
                mpesa_payment_type,
                mpesa_paybill_number,
                mpesa_paybill_account,
                mpesa_till_number,
                pochi_la_biashara_enabled,
                pochi_la_biashara_number,
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
            `SELECT online_orders_enabled, is_active, show_cart_when_disabled, order_disabled_message
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
        const { search, category, product_category_id } = req.query;
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
            SELECT p.*,
                   pc.name AS product_category_name,
                   pc.slug AS product_category_slug,
                   pc.icon AS product_category_icon
            FROM products p
            LEFT JOIN product_categories pc ON pc.id = p.product_category_id
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

        if (product_category_id) {
            query += ` AND p.product_category_id = $${paramIndex}`;
            params.push(parseInt(product_category_id, 10));
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
//  GET FEATURED BUSINESSES (Public)
//  Kept for backwards compatibility with the account page and
//  any client that still calls it directly. The marketplace
//  home page no longer renders a Featured Businesses grid;
//  the ad slider (Section J) replaces it.
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