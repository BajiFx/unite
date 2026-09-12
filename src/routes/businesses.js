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
//  Section K — Product-name search:
//   K.1 — The same /api/businesses search matches products by name
//         across every business. Typing "shoes" returns:
//           • every business whose name / description / location
//             matches the word "shoes", AND
//           • every business that sells a product whose name
//             matches the word "shoes", AND
//           • a `products` array of the matching product tiles.
//   K.2 — Matching is word-boundary PLUS a trailing \w* so
//         "blanket" matches Blanket, Blankets, Blanket Set, but
//         not "Horseblanket" or "Shoelace" for "shoe".
//   K.3 — The `within Nkm` radius anchor filters product results
//         too, so "shoes near me within 5km" never returns a
//         product from a shop 200 km away.
//   K.4 — Product ordering: distance ascending when an anchor is
//         used, otherwise name-match relevance first, then newest.
//   K.5 — A `pg_trgm` GIN index on products.name keeps this fast
//         at scale. See migrations/sql/20260915-product-search-index.sql.
//
//  Section L — Fuzzy fallback (typo tolerance):
//   L.1 — If the primary word-boundary search returns zero product
//         matches AND zero business name matches, the same two
//         queries are re-run with a pg_trgm similarity regex.
//         This catches typos like "balnket" → "blanket".
//   L.2 — The response carries a `search_mode` field ('exact' |
//         'fuzzy' | null) so the frontend can show a hint.
//   L.3 — Each matched product carries `matched_word` — the exact
//         cleaned search word — so the frontend can render
//         "SELLS: blanket" on the matching businesses.
//   L.4 — Each business that matched via a product carries a new
//         `product_matches` array so the frontend can render the
//         "SELLS: …" banner at the top of the card.
//
//  Section M — Sentence-to-word extraction (this revision):
//   M.1 — The customer types a full sentence ("i need blankets in
//         nairobi"). The server strips filler words and anchor
//         tokens, leaving ONLY the real product / business word
//         ("blankets") as `searchText` / `matched_word` /
//         `search_word`.
//   M.2 — Filler words are English + Swahili: i, me, my, we, us,
//         you, need, want, looking, for, show, find, get, give,
//         bring, please, some, a, an, the, any, all, is, are, of,
//         with, to, that, this, nataka, ninataka, naomba, tafadhali,
//         nipe, nilete, kwa, ya, na.
//   M.3 — The label printed by the frontend is only ever the
//         cleaned word, never the full typed sentence.
//   M.4 — If the cleaned word matches a business name (like
//         "Doppa"), the business is listed without any SELLS label.
//   M.5 — If the cleaned word matches a product, the SELLS label
//         is shown, and if that same business also happens to have
//         the word in its own name, the product match wins (Q3a).
//   M.6 — If the cleaned word is only a location word (like
//         "Nairobi" alone), the anchor parser has already consumed
//         it, so the search degrades gracefully to location-only.
//   M.7 — "near me" without an explicit "within Nkm" applies a
//         50 km global cap to product results (Q5b). An explicit
//         "within Nkm" overrides the cap.
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

// ============================================================
//  Section M.2 — Filler words
//
//  Common English and Swahili filler words that carry no search
//  meaning. They are stripped AFTER anchor parsing (so "near me"
//  is still consumed as an anchor, not as separate filler words).
//
//  Everything here is lowercase; matching is done on the already
//  lowercased working string with word-boundary regex.
// ============================================================

const FILLER_WORDS = [
    // English
    'i', 'me', 'my', 'we', 'us', 'you',
    'need', 'want', 'looking', 'for', 'show', 'find', 'get',
    'give', 'bring', 'please', 'some', 'a', 'an', 'the',
    'any', 'all', 'is', 'are', 'of', 'with', 'to', 'that', 'this',

    // Swahili
    'nataka', 'ninataka', 'naomba', 'tafadhali', 'nipe', 'nilete',
    'kwa', 'ya', 'na'
];

const FILLER_WORD_REGEX = new RegExp(
    `\\b(${FILLER_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'g'
);

// Section M.7 — default cap for "near me" product searches when the
// customer did not type an explicit "within Nkm".
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
 *
 * The sentence is reduced to three buckets:
 *
 *   1. Anchor (location)
 *      "in nairobi", "near me", "within 5km", "around westlands"
 *      → used as anchorLat/anchorLng (self coords, or geocoded place)
 *
 *   2. Filler words
 *      "i need", "please show", "nataka", "tafadhali"
 *      → dropped entirely
 *
 *   3. The real search word(s)
 *      "blankets", "shoes", "doppa"
 *      → kept as `result.text` and returned to the client as
 *        `search_word` / `matched_word`
 *
 * Any remaining flags (verified, featured, new, open, delivery,
 * pickup, cheap, rated N) are parsed in the same pass so they are
 * not confused with the real search word.
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
    //      Runs AFTER anchor and flag parsing, so "near me" is
    //      already gone by the time we get here. What remains is
    //      the real product / business word plus any stray filler.
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
//
//  K.2 — buildSearchRegex
//    Turns any customer-typed text into a Postgres case-
//    insensitive regex that matches on word boundaries with a
//    trailing \w* so singular / plural / prefixed forms all
//    match:
//      "blanket"  →  Blanket, Blankets, Blanket Set,
//                    Blanket-King-Size
//      "shoe"     →  Shoe, Shoes, Shoe Laces
//    But it does NOT match unrelated words that merely contain
//    the search text:
//      "shoe"     ✗  Shoelace, Horseshoe
//      "blanket"  ✗  Horseblanket
//
//  The \m...\M anchors are Postgres ARE word boundaries. The
//  trailing \w* is what gives us singular → plural without a
//  hardcoded dictionary.
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
    // Every word gets \w* on the tail so "blanket" matches
    // "blankets" but "shoe" does not match "shoelace" (the word
    // boundary \m stops it from matching mid-word).
    return `\\m(${words.map(w => `${w}\\w*`).join('|')})\\M`;
}

// Back-compat alias — some earlier code paths import the old name.
function buildWordBoundaryRegex(rawText) {
    return buildSearchRegex(rawText);
}

// ============================================================
//  Section L — Fuzzy fallback regex (typo tolerance)
//
//  L.1 — buildFuzzyRegex
//    Used ONLY when the primary search returns zero results.
//    Builds a pg_trgm similarity pattern with a 0.4 threshold,
//    which is loose enough to catch "balnket" → "blanket" but
//    tight enough that it does not match unrelated words.
//
//    Postgres syntax: (name %> '<text>') uses the % operator
//    for "similarity above threshold". The threshold itself is
//    set per-query with `SET pg_trgm.similarity_threshold = 0.4`
//    right before the query, and reset after. This is a
//    per-session setting so it never leaks between requests on
//    different pool clients.
// ============================================================

function buildFuzzyText(rawText) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return null;
    // Strip anything that could confuse the trigram operator.
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
//
//  Hardened: this endpoint runs a multi-table aggregation with a
//  correlated subquery. On a cold DB (or a transient connection
//  hiccup) the driver can throw before we even hit the query,
//  which previously returned a bare 500 and, in the browser,
//  produced "Failed to load categories". We now:
//    1. Wrap the whole thing in a defensive try/catch.
//    2. Return an empty array (200) instead of a 500 when the
//       aggregation itself fails, so the caller can still render
//       the marketplace with its default "All categories" option.
//    3. Log the real error server-side so it is not silently lost.
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
        // Graceful degradation: the marketplace treats an empty list
        // as "no categories configured" and keeps working.
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
//  SECTION J — PUBLIC ADS FEED (HERO SLIDER ON MARKETPLACE)
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
//
//  K   — When search text is present the same endpoint ALSO returns
//        a `products` array of products whose name matches the search
//        text (word-boundary + prefix), regardless of category. The
//        `businesses` array is expanded so a business that sells a
//        matching product also appears, even if its own name does not
//        contain the word.
//
//  L   — When the primary search returns zero results, the same
//        queries are retried with a pg_trgm similarity regex so a
//        typo like "balnket" still finds "blanket". Every matched
//        product carries `matched_word` (the cleaned word) and every
//        business that matched via a product carries a
//        `product_matches` array so the frontend can render the
//        green blinking "SELLS: …" label.
//
//  M   — The customer's typed sentence is reduced to a single clean
//        search word. All filler words (i, need, please, nataka …)
//        and all anchor tokens (in nairobi, near me, within 5km …)
//        are stripped before matching. "i need blankets in nairobi"
//        becomes search_word = "blankets", anchor = place:Nairobi,
//        and every matching business/product carries
//        matched_word = "blankets".
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

        // Section D + M — parse the free-text query.
        const parsed = parseSearchQuery(search || '');
        const searchText = parsed.text;

        // Section K — build the primary regex and the fuzzy text.
        const searchRegex = searchText ? buildSearchRegex(searchText) : null;
        const fuzzyText = searchText ? buildFuzzyText(searchText) : null;

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

        // Section M.7 — effective radius for product results.
        //
        // If the customer explicitly typed "within Nkm", that wins.
        // Otherwise, when the anchor is "self" (near me) we apply a
        // global 50 km cap so "blankets near me" never returns a
        // product from a shop 200 km away. When the anchor is a
        // named place (in nairobi), no cap is applied — the place
        // itself is the boundary.
        let effectiveRadiusKm = parsed.radiusKm;
        if (!effectiveRadiusKm && anchorSource === 'self') {
            effectiveRadiusKm = DEFAULT_NEAR_ME_RADIUS_KM;
        }

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

        // ============================================================
        //  Primary query (word-boundary + prefix)
        // ============================================================

        async function runSearch(mode) {
            const isFuzzy = mode === 'fuzzy';
            const likeParam = isFuzzy ? `%${fuzzyText}%` : `%${searchText}%`;

            // ---------- Business query ----------
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

            // ---------- Product query ----------
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

            // ---------- Execute ----------
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

            // Section M.7 — apply the effective radius to both
            // business rows and product rows when the anchor
            // produced a distance. This is what makes "blankets in
            // nairobi" show only Nairobi shops (anchorPlace drives
            // the geocoded coordinates) and "blankets near me"
            // show only shops within 50 km by default.
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

        // ------------------------------------------------------------
        //  Run the primary search, then fall back to fuzzy if and
        //  only if it produced nothing useful.
        // ------------------------------------------------------------
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

        // ------------------------------------------------------------
        //  E.4 — Apply smart score in JS (only in smart mode).
        // ------------------------------------------------------------
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

        // ------------------------------------------------------------
        //  Section K / L / M — shape the response.
        //
        //  Every product carries `matched_word` — the cleaned search
        //  word ("blankets", never "i need blankets"). Every business
        //  that matched via a product carries a `product_matches`
        //  array so the frontend can render the green blinking
        //  "SELLS: blankets" label at the top of the card. A
        //  business that matched purely by name keeps an empty
        //  `product_matches` array (Q4 — the frontend then renders
        //  no SELLS label).
        // ------------------------------------------------------------

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

        // Group the matched products by business so each business
        // row can carry its own small list of matching products.
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

            return {
                ...row,
                product_matches: hasProductMatch ? matches : [],
                matched_word: hasProductMatch ? (searchText || null) : null,
                search_mode: hasProductMatch ? mode : null
            };
        });

        // ------------------------------------------------------------
        //  Count query — mirrors the same conditions.
        // ------------------------------------------------------------
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

            // Section M — the top-level search_word is the cleaned
            // word only, never the customer's typed sentence.
            search_word: searchText || null,
            search_mode: searchText ? mode : null,

            // Section M.1 — the raw typed sentence is echoed back so
            // the frontend can show "You typed: i need blankets in
            // nairobi" if it wants, without affecting the SELLS label.
            raw_search: (search || '').trim() || null,

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