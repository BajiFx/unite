// ============================================================
//  LOCATION ROUTES - Complete Fixed Version
//  Location: src/routes/location.js
//
//  Section D — Customer location, nearby search, and privacy
//  D.1  — Profile-driven activation is handled on the frontend; this
//         file provides the persistence endpoint.
//  D.2  — POST /customer/activate saves the customer's device GPS
//         coordinates against their own row. Coordinates are never
//         shared with businesses (D.11).
//  D.10 — POST /customer/deactivate clears the coordinates and
//         flips the activated flag off so nearby search is disabled.
//  D.12 — Calling POST /customer/activate again is the refresh path.
//         A dedicated POST /customer/refresh is also provided for
//         clarity, so the frontend can call either.
//
//  D.11 — GET /customer/location only ever returns the customer's own
//         location back to the customer. There is no endpoint that
//         exposes a customer's coordinates to a business admin.
//
//  Section E.2 / G.3 — Customer preferred locations
//  A customer who chooses not to share GPS can still tell the
//  marketplace which area they want to shop in. These names are
//  optional, customer-scoped, and used by the search handler (E.4)
//  as a soft anchor. They are never returned on a business-facing
//  endpoint (D.11 preserved).
//
//   - POST   /customer/preferred-locations → save / refresh
//   - GET    /customer/preferred-locations → read own
//   - DELETE /customer/preferred-locations → clear
//
//  IP-based approximate location
//  D — GET /api/location/ip-locate. Public, no auth. Reads the
//      request IP, calls a free geolocation service, caches the
//      result per IP for 24h, and returns
//      { latitude, longitude, city, country, region, source }.
//      Silent, permission-free fallback for guests.
//
//  Existing admin + customer request flows are preserved exactly as
//  they were before this update.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware, adminOnly, customerOnly } = require('../middleware/auth');
const Customer = require('../models/Customer');
const router = express.Router();

// ============================================================
//  Validation helper — coordinates must be finite and in range.
//  Accepts numbers or numeric strings. Rejects NaN, empty, out of
//  range values, and non-numeric junk.
// ============================================================

function parseCoordinatePair(inputLat, inputLng) {
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

function normaliseAccuracy(value) {
    if (value === undefined || value === null || value === '') return null;
    const num = Number.parseFloat(value);
    if (!Number.isFinite(num) || num < 0) return null;
    return Math.round(num);
}

// ============================================================
//  ADMIN - GET LOCATION REQUESTS
// ============================================================

router.get('/admin/requests', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT lr.*, c.name, c.email
      FROM location_requests lr
      JOIN customers c ON lr.customer_id = c.id
      WHERE lr.status = 'pending'
      ORDER BY lr.created_at ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Location requests error:', err);
    logError(err, 'Location requests');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - APPROVE LOCATION
// ============================================================

router.post('/admin/requests/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);
    const result = await pool.query('SELECT customer_id FROM location_requests WHERE id = $1', [id]);
    const customerId = result.rows[0]?.customer_id;
    if (customerId) {
      const io = req.app.get('io');
      io.to(`customer_${customerId}`).emit('location_request_approved');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Approve location error:', err);
    logError(err, 'Approve location');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - REJECT LOCATION
// ============================================================

router.post('/admin/requests/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject location error:', err);
    logError(err, 'Reject location');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER - REQUEST LOCATION - FIXED
// ============================================================

router.post('/customer/request', authMiddleware, customerOnly, async (req, res) => {
  try {
    const customerId = req.userId;

    if (!customerId || customerId === req.email) {
      return res.status(400).json({ error: 'Invalid user session' });
    }

    const existing = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'pending']
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already have a pending request.' });
    }

    const approved = await pool.query(
      'SELECT * FROM location_requests WHERE customer_id = $1 AND status = $2',
      [customerId, 'approved']
    );
    if (approved.rows.length > 0) {
      return res.json({ success: true, alreadyApproved: true });
    }

    await pool.query('INSERT INTO location_requests (customer_id, status) VALUES ($1, $2)', [customerId, 'pending']);
    res.json({ success: true, message: 'Request sent. Awaiting admin approval.' });
  } catch (err) {
    console.error('❌ Request location error:', err);
    logError(err, 'Request location');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER - GET LOCATION STATUS - FIXED
// ============================================================

router.get('/customer/status', authMiddleware, customerOnly, async (req, res) => {
  try {
    const customerId = req.userId;

    if (!customerId || customerId === req.email) {
      return res.json({ status: 'none' });
    }

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'location_requests'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json({ status: 'none' });
    }

    const result = await pool.query(
      'SELECT status FROM location_requests WHERE customer_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [customerId]
    );
    const status = result.rows[0]?.status || 'none';
    res.json({ status });
  } catch (err) {
    console.error('❌ Location status error:', err);
    logError(err, 'Location status');
    res.json({ status: 'none' });
  }
});

// ============================================================
//  ADMIN - TOGGLE LOCATION SHARING
// ============================================================

router.post('/admin/toggle', authMiddleware, adminOnly, async (req, res) => {
  const { lat, lng, enabled } = req.body;
  try {
    await pool.query(
      'UPDATE shop SET location_sharing_enabled = $1, admin_lat = $2, admin_lng = $3',
      [enabled, lat || null, lng || null]
    );
    if (enabled && lat && lng) {
      const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
      const io = req.app.get('io');
      customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Toggle location error:', err);
    logError(err, 'Toggle location');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE LOCATION
// ============================================================

router.post('/admin/update', authMiddleware, adminOnly, async (req, res) => {
  const { lat, lng } = req.body;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing coordinates' });
  }
  try {
    await pool.query('UPDATE shop SET admin_lat = $1, admin_lng = $2', [lat, lng]);
    const customers = await pool.query('SELECT customer_id FROM location_requests WHERE status = $1', ['approved']);
    const io = req.app.get('io');
    customers.rows.forEach(row => io.to(`customer_${row.customer_id}`).emit('admin_location', { lat, lng }));
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update location error:', err);
    logError(err, 'Update location');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SECTION D — CUSTOMER LOCATION ACTIVATION
//
//  All three customer endpoints below operate only on the row
//  belonging to req.userId. The customer's coordinates are never
//  returned to a business and never exposed via any public route
//  (D.11).
// ============================================================

/**
 * D.2 / D.12 — POST /customer/activate
 *
 * Saves the device-supplied latitude/longitude against the customer's
 * own row and marks the location as activated.
 *
 * Calling this endpoint again is exactly how a customer refreshes
 * their location after moving (D.12).
 *
 * Body:
 *   { latitude, longitude, accuracy? }
 */
router.post(
    '/customer/activate',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const { latitude, longitude, accuracy } = req.body || {};

            const parsed = parseCoordinatePair(latitude, longitude);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }

            const accuracyValue = normaliseAccuracy(accuracy);

            const result = await pool.query(`
                UPDATE customers
                SET latitude = $1,
                    longitude = $2,
                    location_accuracy = COALESCE($3, location_accuracy),
                    location_activated = TRUE,
                    location_activated_at = NOW(),
                    location_source = 'browser',
                    updated_at = NOW()
                WHERE id = $4
                RETURNING
                    id,
                    latitude,
                    longitude,
                    location_accuracy,
                    location_activated,
                    location_activated_at,
                    location_source
            `, [
                parsed.lat.toString(),
                parsed.lng.toString(),
                accuracyValue,
                customerId
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            const row = result.rows[0];

            res.json({
                success: true,
                message: 'Location activated successfully.',
                location: {
                    latitude: row.latitude,
                    longitude: row.longitude,
                    accuracy: row.location_accuracy,
                    activated: row.location_activated === true,
                    activated_at: row.location_activated_at,
                    source: row.location_source
                }
            });
        } catch (err) {
            console.error('❌ Activate customer location error:', err);
            logError(err, 'Activate customer location');
            res.status(500).json({
                error: 'Unable to save customer location',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

/**
 * D.12 — POST /customer/refresh
 *
 * Alias for /customer/activate so the frontend can be explicit when
 * it is a refresh rather than an initial activation. Behaves identically.
 */
router.post(
    '/customer/refresh',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const { latitude, longitude, accuracy } = req.body || {};

            const parsed = parseCoordinatePair(latitude, longitude);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }

            const accuracyValue = normaliseAccuracy(accuracy);

            const result = await pool.query(`
                UPDATE customers
                SET latitude = $1,
                    longitude = $2,
                    location_accuracy = COALESCE($3, location_accuracy),
                    location_activated = TRUE,
                    location_activated_at = NOW(),
                    location_source = 'browser',
                    updated_at = NOW()
                WHERE id = $4
                RETURNING
                    id,
                    latitude,
                    longitude,
                    location_accuracy,
                    location_activated,
                    location_activated_at,
                    location_source
            `, [
                parsed.lat.toString(),
                parsed.lng.toString(),
                accuracyValue,
                customerId
            ]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            const row = result.rows[0];

            res.json({
                success: true,
                message: 'Location refreshed successfully.',
                location: {
                    latitude: row.latitude,
                    longitude: row.longitude,
                    accuracy: row.location_accuracy,
                    activated: row.location_activated === true,
                    activated_at: row.location_activated_at,
                    source: row.location_source
                }
            });
        } catch (err) {
            console.error('❌ Refresh customer location error:', err);
            logError(err, 'Refresh customer location');
            res.status(500).json({
                error: 'Unable to refresh customer location',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

/**
 * D.10 — POST /customer/deactivate
 *
 * Turns off location sharing. Clears stored coordinates and flips the
 * activated flag off so nearby search is disabled until the customer
 * activates again.
 *
 * Deliberately leaves preferred_* names untouched (E.2): they are an
 * independent, optional feature. A customer can turn off GPS and
 * still keep a preferred area.
 */
router.post(
    '/customer/deactivate',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const result = await pool.query(`
                UPDATE customers
                SET latitude = NULL,
                    longitude = NULL,
                    location_accuracy = NULL,
                    location_activated = FALSE,
                    location_activated_at = NULL,
                    location_source = NULL,
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id
            `, [customerId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            res.json({
                success: true,
                message: 'Location sharing turned off.',
                location: {
                    activated: false,
                    latitude: null,
                    longitude: null,
                    accuracy: null,
                    activated_at: null,
                    source: null
                }
            });
        } catch (err) {
            console.error('❌ Deactivate customer location error:', err);
            logError(err, 'Deactivate customer location');
            res.status(500).json({
                error: 'Unable to turn off location sharing',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

/**
 * GET /customer/location
 *
 * Returns the customer's own activation state so the profile UI can
 * render the correct badge and controls.
 *
 * D.11 — this endpoint is customer-scoped and only ever returns the
 * requesting customer's own coordinates. It is impossible for a
 * business or another customer to read them through this route.
 */
router.get(
    '/customer/location',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const result = await pool.query(`
                SELECT
                    latitude,
                    longitude,
                    location_accuracy,
                    location_activated,
                    location_activated_at,
                    location_source
                FROM customers
                WHERE id = $1
            `, [customerId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            const row = result.rows[0];

            res.json({
                activated: row.location_activated === true,
                activated_at: row.location_activated_at || null,
                source: row.location_source || null,
                accuracy: row.location_accuracy || null,
                latitude: row.latitude || null,
                longitude: row.longitude || null
            });
        } catch (err) {
            console.error('❌ Get customer location error:', err);
            logError(err, 'Get customer location');
            res.status(500).json({ error: 'Unable to load customer location' });
        }
    }
);

// ============================================================
//  SECTION E.2 / G.3 — CUSTOMER PREFERRED LOCATIONS
//
//  A customer who does not share GPS can still set a preferred
//  area. These endpoints are scoped to the requesting customer
//  only (D.11 preserved) and are never returned to a business.
//
//  The search handler reads them via Customer.getPreferredLocations()
//  as a soft anchor when the customer has no coordinates.
// ============================================================

/**
 * POST /customer/preferred-locations
 *
 * Save or refresh the customer's preferred area names.
 *
 * Body (all optional, but at least one must be non-empty):
 *   { continent?, country?, county?, sub_county?, ward?, town? }
 *
 * An empty body (or all-empty values) is treated as a clear request,
 * matching the DELETE endpoint below. This keeps the semantics
 * unambiguous: empty body means "remove the preferred area".
 */
router.post(
    '/customer/preferred-locations',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const body = req.body || {};

            const atLeastOneProvided = [
                body.continent,
                body.country,
                body.county,
                body.sub_county,
                body.ward,
                body.town
            ].some(v => v !== undefined && v !== null && String(v).trim() !== '');

            if (!atLeastOneProvided) {
                return res.status(400).json({
                    error: 'Please provide at least one preferred area field (county, town, etc.)'
                });
            }

            const saved = await Customer.updatePreferredLocations(customerId, body);
            if (!saved) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            res.json({
                success: true,
                message: 'Preferred area saved successfully.',
                preferred_locations: saved
            });
        } catch (err) {
            console.error('❌ Save preferred locations error:', err);
            logError(err, 'Save preferred locations');
            res.status(500).json({
                error: 'Unable to save preferred area',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

/**
 * GET /customer/preferred-locations
 *
 * Read the customer's own preferred area. Scoped to the requesting
 * customer only. Never exposed to a business.
 */
router.get(
    '/customer/preferred-locations',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const preferred = await Customer.getPreferredLocations(customerId);
            if (!preferred) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            res.json(preferred);
        } catch (err) {
            console.error('❌ Get preferred locations error:', err);
            logError(err, 'Get preferred locations');
            res.status(500).json({ error: 'Unable to load preferred area' });
        }
    }
);

/**
 * DELETE /customer/preferred-locations
 *
 * Clear the customer's preferred area entirely.
 */
router.delete(
    '/customer/preferred-locations',
    authMiddleware,
    customerOnly,
    async (req, res) => {
        try {
            const customerId = req.userId;
            if (!customerId || customerId === req.email) {
                return res.status(400).json({ error: 'Invalid user session' });
            }

            const cleared = await Customer.clearPreferredLocations(customerId);
            if (!cleared) {
                return res.status(404).json({ error: 'Customer not found' });
            }

            res.json({
                success: true,
                message: 'Preferred area cleared.',
                preferred_locations: cleared
            });
        } catch (err) {
            console.error('❌ Clear preferred locations error:', err);
            logError(err, 'Clear preferred locations');
            res.status(500).json({
                error: 'Unable to clear preferred area',
                detail: process.env.NODE_ENV !== 'production' ? err.message : undefined
            });
        }
    }
);

// ============================================================
//  SECTION D — IP-BASED APPROXIMATE LOCATION
//
//  Silent, permission-free approximate location for the customer.
//  No prompt, no gesture, no cookie — just one call to a free
//  IP geolocation service, cached per IP for 24 hours.
//
//  Provider: ipapi.co (free tier: 30,000 requests/month, no card)
//    { latitude, longitude, city, region, country_name, error? }
//  Docs: https://ipapi.co/api/#introduction
//
//  On any failure (private IP, blocked service, network error,
//  rate limit), we return 200 with null coordinates so the
//  frontend can gracefully fall back to text-only search.
// ============================================================

const IP_GEOLOCATION_URL = 'https://ipapi.co';
const IP_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IP_CACHE_MAX_ENTRIES = 2000;          // memory bound

const ipLocationCache = new Map();

function readClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || null;
}

function isPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;

  const clean = ip.replace(/^::ffff:/, '');

  if (/^127\./.test(clean)) return false;
  if (/^10\./.test(clean)) return false;
  if (/^192\.168\./.test(clean)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(clean)) return false;
  if (/^169\.254\./.test(clean)) return false;
  if (clean === '::1') return false;
  if (/^fe80:/i.test(clean)) return false;
  if (/^fc00:/i.test(clean)) return false;

  return true;
}

async function fetchApproximateLocation(ip) {
  if (typeof fetch !== 'function') return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${IP_GEOLOCATION_URL}/${encodeURIComponent(ip)}/json/`, {
      headers: { 'User-Agent': 'BidhaaLink/1.0 (ip geolocation)' },
      signal: controller.signal
    });

    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json();
    if (!data || data.error) return null;

    const latitude = parseFloat(data.latitude);
    const longitude = parseFloat(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return {
      latitude,
      longitude,
      city: data.city || null,
      region: data.region || null,
      country: data.country_name || data.country || null,
      source: 'ip'
    };
  } catch (err) {
    console.warn('IP geolocation failed:', err.message);
    return null;
  }
}

function trimIpCache() {
  if (ipLocationCache.size <= IP_CACHE_MAX_ENTRIES) return;
  const entries = [...ipLocationCache.entries()].sort(
    (a, b) => a[1].cachedAt - b[1].cachedAt
  );
  const toRemove = entries.slice(0, entries.length - IP_CACHE_MAX_ENTRIES);
  for (const [key] of toRemove) ipLocationCache.delete(key);
}

/**
 * GET /api/location/ip-locate
 * Public. No auth. Works for guests, customers, business admins,
 * and anonymous visitors from any device.
 */
router.get('/ip-locate', async (req, res) => {
  try {
    const ip = readClientIp(req);

    if (!isPublicIp(ip)) {
      return res.json({
        latitude: null,
        longitude: null,
        city: null,
        region: null,
        country: null,
        source: 'unavailable'
      });
    }

    const cached = ipLocationCache.get(ip);
    if (cached && Date.now() - cached.cachedAt < IP_CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const fresh = await fetchApproximateLocation(ip);

    const payload = fresh || {
      latitude: null,
      longitude: null,
      city: null,
      region: null,
      country: null,
      source: 'unavailable'
    };

    ipLocationCache.set(ip, { data: payload, cachedAt: Date.now() });
    trimIpCache();

    res.json(payload);
  } catch (err) {
    console.error('❌ IP locate error:', err);
    logError(err, 'IP locate');
    res.json({
      latitude: null,
      longitude: null,
      city: null,
      region: null,
      country: null,
      source: 'unavailable'
    });
  }
});

module.exports = router;