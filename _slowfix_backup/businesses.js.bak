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
//  Section D — Smart customer search and nearby ranking.
//
//  Section E.4 — Smart default ranking (sort=smart).
//
//  Section E.2 — Preferred-location soft anchor.
//
//  Section J / N — Marketplace hero slider and fixed ad slots.
//
//  Section R — Per-visit business rotation.
//
//  Section — Business Search Tag.
//
//  Business product categories on the profile product list
//  (this revision):
//   GET /:slug/products now joins product_categories and returns
//   product_category_name, product_category_slug, and
//   product_category_icon alongside each product. The join was
//   missing, which meant the frontend could not build the
//   "defined product categories" dropdown on the business
//   profile page. The join now matches the one already used by
//   GET /api/products and GET /api/products/:id/detail, so the
//   three views stay consistent.
//
//  PHASE 1 / PHASE 2 — Product variants and the three-tab filter
//   The `GET /:slug/products` handler now:
//     - honours a `tab` query parameter with values
//       all | image | video, applying the filter in SQL so it
//       composes with search, category, product_category_id,
//       and pagination;
//     - resolves variants for every product through
//       variantService.listActiveVariants(), so the inheritance
//       chain (variant → parent) is applied in one place;
//     - returns a resolved thumbnail_url, a thumbnail_kind, and a
//       media_kind per product so the customer card never walks
//       the chain itself.
//
//   Every other route and helper in this file is preserved
//   byte-for-byte.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const Business = require('../models/Business');
const Customer = require('../models/Customer');
// Phase 1 / Phase 2 — variant resolution for the shop page and
// the product detail page. The service owns every read from
// product_variants, so no route in this file queries that table
// directly.
const variantService = require('../services/variantService');
const router = express.Router();

function productFallbackImage(name) {
    const label = String(name || 'Product').slice(0, 32).replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${label}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const LOCATION_FIELDS = ['continent', 'country', 'county', 'sub_county', 'ward', 'town', 'specific_area', 'postal_code'];
const locationSql = LOCATION_FIELDS.map(field => `COALESCE(b.${field}, '')`).join(", ' ', ");

// ============================================================
//  Category JSON subquery
// ============================================================

const CATEGORIES_SUBQUERY = `
    (SELECT COALESCE(
        json_agg(json_build_object('id', c.id, 'name', c.name, 'icon', c.icon) ORDER BY c.name),
        '[]'::json
     )
     FROM business_category_assignments bca
     JOIN business_categories c ON c.id = bca.category_id
     WHERE bca.business_id = b.id) AS categories
`;

// ============================================================
//  Section 20260923 — Defensive product_keywords coercion
// ============================================================

function coerceProductKeywords(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const value of raw) {
        if (value === undefined || value === null) continue;
        const trimmed = String(value).trim();
        if (trimmed === '') continue;
        out.push(trimmed);
    }
    return out;
}

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

// ============================================================
//  Section M.2 — Filler words
// ============================================================

const FILLER_WORDS = [
    'i', 'me', 'my', 'we', 'us', 'you',
    'need', 'want', 'looking', 'for', 'show', 'find', 'get',
    'give', 'bring', 'please', 'some', 'a', 'an', 'the',
    'any', 'all', 'is', 'are', 'of', 'with', 'to', 'that', 'this',

    'nataka', 'ninataka', 'naomba', 'tafadhali', 'nipe', 'nilete',
    'kwa', 'ya', 'na'
];

const FILLER_WORD_REGEX = new RegExp(
    `\\b(${FILLER_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'g'
);

const DEFAULT_NEAR_ME_RADIUS_KM = 50;

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

/**
 * Section D + M — parse a customer-typed search sentence.
 */
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

    // -------- 1. radius anchor: "within 5km" / "within 5 kms" --------
    const withinMatch = working.match(/\bwithin\s+(\d+)\s*k?m?s?\b/);
    if (withinMatch) {
        result.radiusKm = Math.min(Math.max(parseInt(withinMatch[1], 10) || 0, 1), 500);
        result.anchor = 'self';
        working = working.replace(withinMatch[0], ' ');
    }

    // -------- 2. place anchor: "in nairobi" / "around westlands" --------
    const placeMatch = working.match(/\b(?:in|around|at)\s+([a-z0-9][a-z0-9\s\-'.]{1,60})/);
    if (placeMatch && !result.anchor) {
        const place = placeMatch[1].trim();
        if (place && !/^(near|nearby|me|my|verified|featured|new|open|delivery|pickup)$/.test(place)) {
            result.anchor = 'place';
            result.anchorPlace = place;
            working = working.replace(placeMatch[0], ' ');
        }
    }

    // -------- 3. self anchor: "near me", "hapa", "kwetu" --------
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

    // -------- 4. flag keywords --------
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

    // -------- 5. filler words (English + Swahili) --------
    working = working.replace(FILLER_WORD_REGEX, ' ');

    // -------- 6. normalise whitespace and keep the real word --------
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
//  Section K — Search regex builders
// ============================================================

function escapeRegex(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return null;
    const words = trimmed
        .split(/\s+/)
        .map(w => escapeRegex(w))
        .filter(Boolean);
    if (words.length === 0) return null;
    return `\\m(${words.map(w => `${w}\\w*`).join('|')})\\M`;
}

function buildWordBoundaryRegex(rawText) {
    return buildSearchRegex(rawText);
}

// ============================================================
//  Section L — Fuzzy fallback regex (typo tolerance)
// ============================================================

function buildFuzzyText(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return null;
    return trimmed.replace(/[%_\\]/g, '').toLowerCase();
}

// ============================================================
//  Section E.4 — Smart score (JS-side, after the query)
// ============================================================

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
    const relevanceScore = relevance / 2;

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
//  Section R — Per-visit business rotation helpers
// ============================================================

const ROTATION_COOKIE_NAME = 'rotation_seed';
const ROTATION_COOKIE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

function isSafeRotationSeed(value) {
    if (value === undefined || value === null) return false;
    const s = String(value);
    return /^[0-9]{1,15}$/.test(s);
}

function getOrCreateRotationSeed(req, res) {
    const existing = req.cookies ? req.cookies[ROTATION_COOKIE_NAME] : undefined;

    if (isSafeRotationSeed(existing)) {
        return parseInt(existing, 10);
    }

    const fresh = Date.now() % Number.MAX_SAFE_INTEGER;

    try {
        res.cookie(ROTATION_COOKIE_NAME, String(fresh), {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: ROTATION_COOKIE_MAX_AGE_MS,
            path: '/'
        });
    } catch (err) {
        console.warn('Could not set rotation cookie:', err.message);
        return null;
    }

    return fresh;
}

function rotateArray(list, offset) {
    if (!Array.isArray(list) || list.length === 0) return list;
    const n = list.length;
    const normalized = ((offset % n) + n) % n;
    if (normalized === 0) return list;
    return list.slice(normalized).concat(list.slice(0, normalized));
}

// ============================================================
//  Business Search Tag — server-side helpers
// ============================================================

const SEARCH_TAG_MIN_LENGTH = 3;
const SEARCH_TAG_MAX_PREFIX_ATTEMPTS = 40;

function normalizeSearchTagText(value) {
    if (value === undefined || value === null) return '';
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function lookupBusinessesBySearchTag(rawSearch) {
    const normalized = normalizeSearchTagText(rawSearch);
    if (!normalized || normalized.length < SEARCH_TAG_MIN_LENGTH) {
        return null;
    }

    let attemptLength = Math.min(normalized.length, 160);
    let attempts = 0;

    while (attemptLength >= SEARCH_TAG_MIN_LENGTH && attempts < SEARCH_TAG_MAX_PREFIX_ATTEMPTS) {
        const prefix = normalized.slice(0, attemptLength);

        const result = await pool.query(`
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
                   ${CATEGORIES_SUBQUERY}
            FROM businesses b
            WHERE b.is_active = true
              AND b.search_tag IS NOT NULL
              AND b.search_tag LIKE $1 || '%'
            ORDER BY
                CASE WHEN b.search_tag = $1 THEN 0 ELSE 1 END,
                b.business_name ASC
            LIMIT 20
        `, [prefix]);

        if (result.rows.length > 0) {
            return { rows: result.rows, normalized: prefix };
        }

        attemptLength -= 1;
        attempts += 1;
    }

    return null;
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
        res.json([]);
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
//  SECTION J / N — PUBLIC ADS FEED (HERO SLIDER ON MARKETPLACE)
// ============================================================

const AD_ROTATION_SLOT_MS = 30 * 1000;   // 30 seconds per ad
const AD_ROTATION_EPOCH_MS = 0;          // Unix epoch — never changes
const AD_ROTATION_OFFSET = 0;            // fixed integer offset

router.get('/ads', async (req, res) => {
    try {
        const limitRaw = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0
            ? Math.min(limitRaw, 60)
            : 60;

        const result = await pool.query(`
            SELECT a.id,
                   a.business_id,
                   a.slot,
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
            ORDER BY a.slot ASC, a.business_id ASC, a.id ASC
            LIMIT $1
        `, [limit]);

        res.json({
            ads: result.rows,
            interleave_by: 'slot',
            max_slots_per_business: 3,

            rotation_slot_duration_ms: AD_ROTATION_SLOT_MS,
            rotation_epoch_ms: AD_ROTATION_EPOCH_MS,
            rotation_offset: AD_ROTATION_OFFSET,
            rotation_cycle_length: result.rows.length
        });
    } catch (err) {
        logError(err, 'Get marketplace ads');
        res.status(500).json({ error: 'Unable to load ads' });
    }
});

// ============================================================
//  J.7 — RECORD AD IMPRESSION
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
            'SELECT slug FROM businesses WHERE slug IS NOT NULL AND id = $1 AND is_active = true',
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

        const parsed = parseSearchQuery(search || '');
        const searchText = parsed.text;

        const searchRegex = searchText ? buildSearchRegex(searchText) : null;
        const fuzzyText = searchText ? buildFuzzyText(searchText) : null;

        let searchTagMatches = null;
        let searchTagNormalized = null;

        if (search) {
            try {
                const tagResult = await lookupBusinessesBySearchTag(search);
                if (tagResult && tagResult.rows.length > 0) {
                    searchTagMatches = tagResult.rows;
                    searchTagNormalized = tagResult.normalized;
                }
            } catch (tagErr) {
                console.warn('⚠️ Search tag lookup skipped:', tagErr.message);
            }
        }

        const noOtherFilters =
            (!category || category === 'all') &&
            featured !== 'true' &&
            verified !== 'true' &&
            sort !== 'urgent' &&
            !parsed.anchor &&
            !parsed.verified &&
            !parsed.featured &&
            !parsed.isNew &&
            !parsed.open &&
            !parsed.delivery &&
            !parsed.pickup &&
            !parsed.minRating &&
            !parsed.cheap;

        if (searchTagMatches && searchTagMatches.length === 1 && noOtherFilters) {
            const only = searchTagMatches[0];
            return res.json({
                businesses: [{
                    ...only,
                    product_keywords: coerceProductKeywords(only.product_keywords),
                    product_matches: [],
                    matched_word: searchTagNormalized,
                    search_mode: 'tag',
                    search_tag_match: true
                }],
                products: [],
                search_word: searchTagNormalized,
                search_mode: 'tag',
                raw_search: (search || '').trim() || null,
                anchor: null,
                anchor_place: null,
                radius_km: null,
                effective_radius_km: null,
                urgent: false,
                smart: false,
                preferred_anchor: null,
                rotation: {
                    applied: false,
                    seed: null,
                    cookie_name: ROTATION_COOKIE_NAME,
                    cookie_ttl_ms: ROTATION_COOKIE_MAX_AGE_MS
                },
                parsed: {
                    text: searchTagNormalized,
                    verified: false,
                    featured: false,
                    new: false,
                    open: false,
                    delivery: false,
                    pickup: false,
                    min_rating: null,
                    cheap: false
                },
                pagination: {
                    page: parseInt(page, 10),
                    limit: parseInt(limit, 10),
                    total: 1,
                    pages: 1
                }
            });
        }

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

        let effectiveRadiusKm = parsed.radiusKm;
        if (!effectiveRadiusKm && anchorSource === 'self') {
            effectiveRadiusKm = DEFAULT_NEAR_ME_RADIUS_KM;
        }

        const preferredCounty = req.query.preferred_county ? String(req.query.preferred_county).trim() : '';
        const preferredTown = req.query.preferred_town ? String(req.query.preferred_town).trim() : '';
        const hasPreferredAnchor = Boolean(preferredCounty || preferredTown);

        const smartMode =
            !sort &&
            !urgentMode &&
            !searchText &&
            !parsed.anchor &&
            !hasAnchor;

        const explicitSort = Boolean(sort);
        const rotateListing =
            !explicitSort &&
            !urgentMode &&
            !searchText &&
            !parsed.anchor &&
            !hasAnchor;

        let rotationSeed = null;
        let rotationOffset = 0;

        if (rotateListing) {
            rotationSeed = getOrCreateRotationSeed(req, res);
            if (rotationSeed !== null) {
                rotationOffset = rotationSeed;
            }
        }

        async function runSearch(mode) {
            const isFuzzy = mode === 'fuzzy';
            const likeParam = isFuzzy ? `%${fuzzyText}%` : `%${searchText}%`;

            let query = `
                SELECT b.*,
                       (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                       (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                       (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                       (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count,
                       (SELECT delivery_enabled FROM businesses WHERE id = b.id) as delivery_enabled,
                       b.online_orders_enabled,
                       ${CATEGORIES_SUBQUERY}
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
                if (isFuzzy) {
                    conditions.push(`(
                        b.business_name %> $${paramIndex}
                        OR b.description %> $${paramIndex}
                        OR EXISTS (
                            SELECT 1 FROM products p
                            WHERE p.business_id = b.id
                              AND p.is_active = true
                              AND (p.name %> $${paramIndex} OR p.description %> $${paramIndex})
                        )
                    )`);
                    params.push(fuzzyText);
                    paramIndex++;
                } else {
                    conditions.push(`(
                        b.business_name ~* $${paramIndex}
                        OR b.description ~* $${paramIndex}
                        OR CONCAT_WS(' ', ${locationSql}) ILIKE $${paramIndex + 1}
                        OR EXISTS (
                            SELECT 1 FROM products p
                            WHERE p.business_id = b.id
                              AND p.is_active = true
                              AND (p.name ~* $${paramIndex} OR p.description ~* $${paramIndex})
                        )
                    )`);
                    params.push(searchRegex, likeParam);
                    paramIndex += 2;
                }
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

            let productQuery = `
                SELECT p.id           AS product_id,
                       p.name         AS product_name,
                       p.price        AS product_price,
                       p.old_price    AS product_old_price,
                       p.discount_percent,
                       p.image        AS product_image,
                       p.category     AS legacy_category,
                       p.product_category_id,
                       pc.name        AS product_category_name,
                       pc.icon        AS product_category_icon,
                       b.id           AS business_id,
                       b.business_name,
                       b.slug         AS business_slug,
                       b.logo         AS business_logo,
                       b.location     AS business_location,
                       b.online_orders_enabled
            `;
            const productParams = [];
            let productParamIndex = 1;

            if (hasAnchor) {
                productQuery += `,
                      6371 * acos(LEAST(1, GREATEST(-1,
                          cos(radians($${productParamIndex})) * cos(radians(b.latitude::numeric)) *
                          cos(radians(b.longitude::numeric) - radians($${productParamIndex + 1})) +
                          sin(radians($${productParamIndex})) * sin(radians(b.latitude::numeric))
                       ))) AS distance_km`;
                productParams.push(anchorLat, anchorLng);
                productParamIndex += 2;
            }

            productQuery += `
                FROM products p
                JOIN businesses b ON b.id = p.business_id
                LEFT JOIN product_categories pc ON pc.id = p.product_category_id
                WHERE p.is_active = true
                  AND b.is_active = true
            `;

            if (isFuzzy) {
                productQuery += ` AND (p.name %> $${productParamIndex} OR p.description %> $${productParamIndex})`;
                productParams.push(fuzzyText);
                productParamIndex++;
            } else {
                productQuery += ` AND (p.name ~* $${productParamIndex} OR p.description ~* $${productParamIndex})`;
                productParams.push(searchRegex);
                productParamIndex++;
            }

            for (const field of LOCATION_FILTER_FIELDS) {
                const raw = req.query[field];
                if (!raw) continue;
                const value = String(raw).trim();
                if (!value) continue;
                productQuery += ` AND b.${field} ILIKE $${productParamIndex}`;
                productParams.push(`%${value}%`);
                productParamIndex++;
            }

            if (category && category !== 'all') {
                productQuery += ` AND EXISTS (
                    SELECT 1 FROM business_category_assignments bca
                    WHERE bca.business_id = b.id AND bca.category_id = $${productParamIndex}
                )`;
                productParams.push(parseInt(category, 10));
                productParamIndex++;
            }

            if (hasAnchor) {
                productQuery += ` ORDER BY distance_km ASC NULLS LAST, p.created_at DESC`;
            } else if (isFuzzy) {
                productQuery += ` ORDER BY similarity(p.name, $1) DESC, p.created_at DESC`;
            } else {
                productQuery += ` ORDER BY
                    CASE WHEN p.name ~* $1 THEN 0 ELSE 1 END,
                    p.created_at DESC`;
            }

            productQuery += ` LIMIT 60`;

            if (isFuzzy) {
                await pool.query(`SET pg_trgm.similarity_threshold = 0.4`);
            }

            const [businessResult, productResult] = await Promise.all([
                pool.query(query, params),
                pool.query(productQuery, productParams)
            ]);

            if (isFuzzy) {
                await pool.query(`SET pg_trgm.similarity_threshold = 0.3`).catch(() => {});
            }

            let businessRows = businessResult.rows;
            let productRows = productResult.rows;

            if (hasAnchor && effectiveRadiusKm) {
                businessRows = businessRows.filter(row =>
                    row.distance_km === null || Number(row.distance_km) <= effectiveRadiusKm
                );
                productRows = productRows.filter(row =>
                    row.distance_km === null || Number(row.distance_km) <= effectiveRadiusKm
                );
            }

            return { businessRows, productRows, isFuzzy };
        }

        let mode = 'exact';
        let { businessRows, productRows, isFuzzy } = await runSearch('exact');

        const hasMeaningfulResults =
            productRows.length > 0 ||
            businessRows.some(row => {
                if (!searchText) return true;
                const q = searchText.toLowerCase();
                return String(row.business_name || '').toLowerCase().includes(q)
                    || String(row.description || '').toLowerCase().includes(q);
            });

        if (searchText && !hasMeaningfulResults) {
            try {
                const fuzzyResult = await runSearch('fuzzy');
                if (fuzzyResult.productRows.length > 0 || fuzzyResult.businessRows.length > 0) {
                    businessRows = fuzzyResult.businessRows;
                    productRows = fuzzyResult.productRows;
                    isFuzzy = true;
                    mode = 'fuzzy';
                }
            } catch (fuzzyErr) {
                console.warn('⚠️ Fuzzy search fallback skipped:', fuzzyErr.message);
            }
        }

        if (searchTagMatches && searchTagMatches.length > 0) {
            const seen = new Set(searchTagMatches.map(r => r.id));
            const merged = searchTagMatches.map(row => ({
                ...row,
                product_keywords: coerceProductKeywords(row.product_keywords),
                product_matches: [],
                matched_word: searchTagNormalized,
                search_mode: 'tag',
                search_tag_match: true
            }));

            for (const row of businessRows) {
                if (seen.has(row.id)) continue;
                merged.push({
                    ...row,
                    product_keywords: coerceProductKeywords(row.product_keywords),
                    search_tag_match: false
                });
            }

            businessRows = merged;
            if (mode === 'exact') mode = 'tag';
        }

        if (smartMode && businessRows.length > 1) {
            businessRows = businessRows.map(row => ({
                ...row,
                smart_score: computeSmartScore(
                    row,
                    searchText,
                    hasAnchor,
                    preferredCounty,
                    preferredTown
                )
            }));
            businessRows.sort((a, b) => {
                const diff = (b.smart_score || 0) - (a.smart_score || 0);
                if (diff !== 0) return diff;
                return new Date(b.created_at) - new Date(a.created_at);
            });
        }

        let rotationApplied = false;
        let rotationSeedValue = null;

        if (rotateListing && rotationSeed !== null && businessRows.length > 1) {
            businessRows = rotateArray(businessRows, rotationOffset);
            if (productRows.length > 1) {
                productRows = rotateArray(productRows, rotationOffset);
            }
            rotationApplied = true;
            rotationSeedValue = rotationSeed;
        }

        const productMatches = productRows.map(row => ({
            product_id: row.product_id,
            product_name: row.product_name,
            product_price: row.product_price,
            product_old_price: row.product_old_price,
            product_discount_percent: row.discount_percent,
            product_image: row.product_image || productFallbackImage(row.product_name),
            legacy_category: row.legacy_category,
            product_category_id: row.product_category_id,
            product_category_name: row.product_category_name,
            product_category_icon: row.product_category_icon,
            business_id: row.business_id,
            business_name: row.business_name,
            business_slug: row.business_slug,
            business_logo: row.business_logo,
            business_location: row.business_location,
            online_orders_enabled: row.online_orders_enabled !== false,
            distance_km: row.distance_km !== undefined ? row.distance_km : null,
            matched_word: searchText || null,
            search_mode: mode
        }));

        const productMatchesByBusiness = new Map();
        for (const p of productMatches) {
            if (!productMatchesByBusiness.has(p.business_id)) {
                productMatchesByBusiness.set(p.business_id, []);
            }
            productMatchesByBusiness.get(p.business_id).push({
                product_id: p.product_id,
                product_name: p.product_name,
                matched_word: p.matched_word
            });
        }

        const businesses = businessRows.map(row => {
            const matches = productMatchesByBusiness.get(row.id) || [];
            const hasProductMatch = matches.length > 0;
            const isTagMatch = row.search_tag_match === true;

            return {
                ...row,
                product_keywords: coerceProductKeywords(row.product_keywords),
                product_matches: hasProductMatch ? matches : [],
                matched_word: isTagMatch
                    ? (searchTagNormalized || null)
                    : (hasProductMatch ? (searchText || null) : null),
                search_mode: isTagMatch
                    ? 'tag'
                    : (hasProductMatch ? mode : null)
            };
        });

        let countQuery = `SELECT COUNT(*) FROM businesses b WHERE b.is_active = true`;
        const countParams = [];
        let countIndex = 1;

        if (searchText) {
            if (mode === 'fuzzy') {
                countQuery += ` AND (
                    b.business_name %> $${countIndex}
                    OR b.description %> $${countIndex}
                    OR EXISTS (
                        SELECT 1 FROM products p
                        WHERE p.business_id = b.id
                          AND p.is_active = true
                          AND (p.name %> $${countIndex} OR p.description %> $${countIndex})
                    )
                )`;
                countParams.push(fuzzyText);
                countIndex++;
            } else {
                countQuery += ` AND (
                    b.business_name ~* $${countIndex}
                    OR b.description ~* $${countIndex}
                    OR CONCAT_WS(' ', ${locationSql}) ILIKE $${countIndex + 1}
                    OR EXISTS (
                        SELECT 1 FROM products p
                        WHERE p.business_id = b.id
                          AND p.is_active = true
                          AND (p.name ~* $${countIndex} OR p.description ~* $${countIndex})
                    )
                )`;
                countParams.push(searchRegex, `%${searchText}%`);
                countIndex += 2;
            }
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
            products: productMatches,

            search_word: searchText || null,
            search_mode: searchText ? mode : null,
            raw_search: (search || '').trim() || null,

            search_tag: searchTagNormalized || null,

            anchor: hasAnchor ? anchorSource : null,
            anchor_place: anchorSource === 'place' ? parsed.anchorPlace : null,
            radius_km: parsed.radiusKm || null,
            effective_radius_km: effectiveRadiusKm || null,
            urgent: urgentMode,
            smart: smartMode,
            preferred_anchor: hasPreferredAnchor ? {
                county: preferredCounty || null,
                town: preferredTown || null
            } : null,

            rotation: {
                applied: rotationApplied,
                seed: rotationSeedValue,
                cookie_name: ROTATION_COOKIE_NAME,
                cookie_ttl_ms: ROTATION_COOKIE_MAX_AGE_MS
            },

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

        const productKeywords = coerceProductKeywords(business.product_keywords);

        res.json({
            business: {
                ...business,
                product_keywords: productKeywords,
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
            search_tag: {
                prefix: business.search_prefix || null,
                name: business.search_name || null,
                tag: business.search_tag || null,
                display: business.search_display || null,
                confirmed: business.search_tag_confirmed === true
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
//
//  Business product categories (previous revision):
//   The query joins product_categories and returns
//   product_category_name, product_category_slug, and
//   product_category_icon alongside each product.
//
//  PHASE 1 / PHASE 2:
//   - The route now honours a `tab` query parameter with values
//     all | image | video. The filter is applied in SQL so it
//     composes correctly with search, category, product_category_id,
//     and pagination.
//       all   → every product of the business
//       image → products where the parent has an image, or any
//               active variant has an image
//       video → products where the parent has a video, or any
//               active variant has a video
//     A mixed product appears in all three tabs.
//   - Variant rows are resolved through variantService so the
//     inheritance chain (variant → parent) is applied in one place
//     and every variant carries media_kind.
//   - Each product carries a resolved thumbnail_url, a
//     thumbnail_kind, and a media_kind, so the client never walks
//     the chain itself.
// ============================================================
router.get('/:slug/products', async (req, res) => {
    try {
        const { slug } = req.params;
        const { search, category, product_category_id } = req.query;

        // Phase 2 — the three-tab media filter. Anything other than
        // the two known values falls back to 'all'.
        const rawTab = String(req.query.tab || 'all').toLowerCase();
        const tab = (rawTab === 'image' || rawTab === 'video') ? rawTab : 'all';

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const offset = (page - 1) * limit;

        const businessResult = await pool.query(
            'SELECT id, online_orders_enabled, heroImage, logo FROM businesses WHERE slug = $1 AND is_active = true',
            [slug]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'Business not found' });
        }

        const businessId = businessResult.rows[0].id;
        const onlineOrdersEnabled = businessResult.rows[0].online_orders_enabled !== false;

        // Phase 2 — the media filter. The subquery answers a single
        // question: does any active variant of this product carry
        // the media the tab is asking for? The parent check is
        // separate because a product can have a parent image or
        // video and no variant media at all.
        let mediaFilterClause = '';
        if (tab === 'image') {
            mediaFilterClause = `
                AND (
                    (p.image IS NOT NULL AND BTRIM(p.image) <> '')
                    OR EXISTS (
                        SELECT 1 FROM product_variants pv
                        WHERE pv.product_id = p.id
                          AND pv.is_active = TRUE
                          AND pv.image IS NOT NULL
                          AND BTRIM(pv.image) <> ''
                    )
                )
            `;
        } else if (tab === 'video') {
            mediaFilterClause = `
                AND (
                    (p.video IS NOT NULL AND BTRIM(p.video) <> '')
                    OR EXISTS (
                        SELECT 1 FROM product_variants pv
                        WHERE pv.product_id = p.id
                          AND pv.is_active = TRUE
                          AND pv.video IS NOT NULL
                          AND BTRIM(pv.video) <> ''
                    )
                )
            `;
        }

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

        // Phase 2 — append the media filter. It has no parameters of
        // its own, so the parameter indexes above are unaffected.
        query += mediaFilterClause;

        query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        // Count query mirrors the same filters so pagination is
        // honest when a tab is active.
        let countQuery = `
            SELECT COUNT(*)::int AS total
            FROM products p
            WHERE p.business_id = $1 AND p.is_active = true
        `;
        const countParams = [businessId];
        let countIndex = 2;

        if (search) {
            countQuery += ` AND (p.name ILIKE $${countIndex} OR p.description ILIKE $${countIndex})`;
            countParams.push(`%${search}%`);
            countIndex++;
        }
        if (category && category !== 'all') {
            countQuery += ` AND p.category = $${countIndex}`;
            countParams.push(category);
            countIndex++;
        }
        if (product_category_id) {
            countQuery += ` AND p.product_category_id = $${countIndex}`;
            countParams.push(parseInt(product_category_id, 10));
            countIndex++;
        }
        // The media filter has no parameters, so it is safe to
        // append directly to the count query.
        countQuery += mediaFilterClause;

        const countResult = await pool.query(countQuery, countParams);
        const total = countResult.rows[0].total || 0;

        // Phase 1 / Phase 2 — resolve each product's variants
        // through the service. The service applies the inheritance
        // chain (variant → parent) and sets media_kind on every
        // variant, so the client never walks the chain itself.
        const businessHero = businessResult.rows[0].heroImage || businessResult.rows[0].logo || null;
        const products = [];

        for (const product of result.rows) {
            let variants = [];
            try {
                variants = await variantService.listActiveVariants(product.id);
            } catch (variantErr) {
                console.warn(
                    `Unable to load variants for product ${product.id}:`,
                    variantErr.message
                );
            }

            // Resolve the grid thumbnail for this product using the
            // same fallback chain the detail page will use.
            const firstVariantWithImage = variants.find(v => v.image);
            const firstVariantWithVideo = variants.find(v => v.video_poster_url || v.video);

            let thumbnailUrl = null;
            let thumbnailKind = 'placeholder';

            if (tab === 'image') {
                if (firstVariantWithImage && firstVariantWithImage.image) {
                    thumbnailUrl = firstVariantWithImage.image;
                    thumbnailKind = 'image';
                } else if (product.image) {
                    thumbnailUrl = product.image;
                    thumbnailKind = 'image';
                } else if (businessHero) {
                    thumbnailUrl = businessHero;
                    thumbnailKind = 'image';
                }
            } else if (tab === 'video') {
                if (firstVariantWithVideo && (firstVariantWithVideo.video_poster_url || firstVariantWithVideo.video)) {
                    thumbnailUrl = firstVariantWithVideo.video_poster_url || firstVariantWithVideo.video;
                    thumbnailKind = 'video';
                } else if (product.video_poster_url || product.video) {
                    thumbnailUrl = product.video_poster_url || product.video;
                    thumbnailKind = 'video';
                } else if (businessHero) {
                    thumbnailUrl = businessHero;
                    thumbnailKind = 'image';
                }
            } else {
                if (product.image) {
                    thumbnailUrl = product.image;
                    thumbnailKind = 'image';
                } else if (product.video_poster_url) {
                    thumbnailUrl = product.video_poster_url;
                    thumbnailKind = 'video';
                } else if (firstVariantWithImage && firstVariantWithImage.image) {
                    thumbnailUrl = firstVariantWithImage.image;
                    thumbnailKind = 'image';
                } else if (firstVariantWithVideo && firstVariantWithVideo.video_poster_url) {
                    thumbnailUrl = firstVariantWithVideo.video_poster_url;
                    thumbnailKind = 'video';
                } else if (businessHero) {
                    thumbnailUrl = businessHero;
                    thumbnailKind = 'image';
                }
            }

            if (!thumbnailUrl) {
                thumbnailUrl = productFallbackImage(product.name);
                thumbnailKind = 'placeholder';
            }

            // media_kind describes the product as a whole.
            let mediaKind = 'placeholder';
            const anyImage = variants.some(v => v.image) || Boolean(product.image);
            const anyVideo = variants.some(v => v.video) || Boolean(product.video);
            if (anyImage && anyVideo) mediaKind = 'mixed';
            else if (anyVideo) mediaKind = 'video';
            else if (anyImage) mediaKind = 'image';

            products.push({
                ...product,
                variants,
                thumbnail_url: thumbnailUrl,
                thumbnail_kind: thumbnailKind,
                media_kind: mediaKind,
                online_orders_enabled: onlineOrdersEnabled
            });
        }

        res.json({
            products,
            business: {
                id: businessId,
                slug: slug,
                online_orders_enabled: onlineOrdersEnabled
            },
            tab,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
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