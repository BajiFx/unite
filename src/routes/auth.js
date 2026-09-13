// ============================================================
//  AUTH ROUTES - COMPLETE MULTI-VENDOR VERSION
//  WITH USERNAME SUPPORT & SMART LOGIN
//  Location: src/routes/auth.js
//
//  Section A — Business registration category fix:
//   A.4 — category validated before saving
//   A.5 — primary category saved with the business record
//   A.6 — primary + additional categories supported
//
//  Section D — Customer location (profile-bound):
//   D.1 — PUT /customer/profile now accepts latitude/longitude and
//         marks the customer's location as activated when supplied.
//   D.2 — Coordinates are persisted on the customer's own row.
//   D.10 — PUT /customer/profile accepts location_activated = false
//          to turn off location sharing (clears the stored coords).
//   D.11 — GET /customer/verify still does NOT return coordinates.
//          No auth route exposes a customer's coordinates.
//   D.12 — The same PUT endpoint is used to refresh coordinates.
//
//  Section E.2 / G.3 — Customer preferred locations:
//   PUT /customer/profile now also accepts preferred area names
//   (preferred_continent, preferred_country, preferred_county,
//   preferred_sub_county, preferred_ward, preferred_town). Any
//   value supplied is saved against the requesting customer's own
//   row. Nothing is exposed on GET /customer/verify (D.11
//   preserved).
//
//  Section — Business Search Tag (new):
//   Every business now has a short, unique, human-typable tag of
//   the form <digits><name> (e.g. 3734Doppa Beddings). The owner
//   picks the digits (3 or 4) and the name during registration,
//   and the server rejects the choice if the combination is
//   already used by another business.
//
//   - GET  /check-business-tag   → availability check used by the
//                                  registration form to mark the
//                                  prefix input red when taken.
//   - POST /business/register    → accepts search_prefix and
//                                  search_name, validates them,
//                                  rejects duplicates, and lets
//                                  the DB trigger fill in the
//                                  normalized search_tag.
//
//   Normalization and the final tag shape are handled by the
//   database trigger defined in migrations/sql/004_business_search_tag.sql,
//   so the write path and the search path can never drift apart.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');
const {
  generateToken,
  authMiddleware,
  adminOnly,
  businessAdminOnly,
  customerOnly,
  getBusinessIdFromToken,
  setAuthCookie,
  clearAuthCookie
} = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimiter');
const { validateKenyanPhone, generateResetToken } = require('../utils/helpers');
const { sendEmail, forgotPasswordEmail } = require('../services/email');
const { logAdminActivity } = require('../services/orderService');
const { uploadToCloudinary } = require('../config/cloudinary');
const router = express.Router();

// ============================================================
//  MULTER SETUP FOR FILE UPLOADS
// ============================================================

const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'businesses');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: JPEG, PNG, WebP, GIF.'));
    }
  }
});

// ============================================================
//  Section D — coordinate validation helpers
//  Kept local so the auth route never trusts an unvalidated pair.
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
//  Section E.2 — preferred-location normaliser
//  Accepts any scalar, trims it, caps the length at 100, and
//  returns null for empty values so the caller can COALESCE or
//  clear as required.
// ============================================================

function normalisePreferred(value) {
    if (value === undefined || value === null) return undefined;   // "not sent"
    const str = String(value).trim();
    if (str === '') return null;                                    // "sent empty" → clear
    return str.slice(0, 100);
}

// ============================================================
//  BUSINESS SEARCH TAG — helpers
//
//  A tag is <digits><name> where digits are 3 or 4 numeric
//  characters and name is any non-empty string. The DB trigger
//  in 004_business_search_tag.sql normalizes both pieces, but
//  we also do a defensive server-side check here so the register
//  route can respond with a clean 400 before touching the
//  database.
// ============================================================

function normalizeSearchTagPart(value) {
    if (value === undefined || value === null) return '';
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildSearchTag(prefix, name) {
    const p = normalizeSearchTagPart(prefix);
    const n = normalizeSearchTagPart(name);
    return p && n ? p + n : null;
}

function validateSearchPrefix(prefix) {
    const str = String(prefix || '').trim();
    if (!/^[0-9]{3,4}$/.test(str)) {
        return {
            ok: false,
            error: 'Search number must be 3 or 4 digits (e.g. 363 or 3734).'
        };
    }

    // ----------------------------------------------------------
    //  SECTION 2B FIX — reserved namespace.
    //
    //  The 004_business_search_tag.sql migration uses "000" as
    //  the prefix for auto-generated placeholder tags assigned
    //  to legacy businesses. If a new owner were allowed to pick
    //  "000" or "0000", their tag would collide with those
    //  placeholders. Block both exact strings here.
    //
    //  Only the exact strings "000" and "0000" are blocked.
    //  "001", "0001", "100", "1000", etc. remain valid.
    // ----------------------------------------------------------
    if (str === '000' || str === '0000') {
        return {
            ok: false,
            error: '000 and 0000 are reserved. Please pick another number.'
        };
    }

    return { ok: true, value: str };
}

function validateSearchName(name) {
    const str = String(name || '').trim();
    if (str.length < 2) {
        return {
            ok: false,
            error: 'Search name must be at least 2 characters.'
        };
    }
    if (str.length > 120) {
        return {
            ok: false,
            error: 'Search name must be 120 characters or fewer.'
        };
    }
    return { ok: true, value: str };
}

// ============================================================
//  CHECK USERNAME AVAILABILITY
// ============================================================

router.get('/check-username', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }

        const customerResult = await pool.query(
            'SELECT id FROM customers WHERE username = $1',
            [username]
        );

        if (customerResult.rows.length > 0) {
            return res.json({ available: false, message: 'Username already taken' });
        }

        const adminResult = await pool.query(
            'SELECT id FROM admin_users WHERE username = $1',
            [username]
        );

        if (adminResult.rows.length > 0) {
            return res.json({ available: false, message: 'Username already taken' });
        }

        res.json({ available: true, message: 'Username available' });
    } catch (err) {
        console.error('❌ Username check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
//  CHECK BUSINESS SEARCH TAG AVAILABILITY
//
//  Called by the registration form (debounced on input) and by
//  the business-admin panel when the owner changes their tag.
//  The response tells the UI whether the digits + name combo is
//  free so it can turn the prefix input red and show the message
//  "This number is already used. Please try another."
//
//  Query params:
//    prefix   — the 3–4 digit number (required)
//    name     — the name the owner wants customers to type (required)
//    exclude  — optional business id to ignore (used when the
//               owner is editing their own tag and the row
//               already holds the same values)
// ============================================================

router.get('/check-business-tag', async (req, res) => {
    try {
        const prefixCheck = validateSearchPrefix(req.query.prefix);
        if (!prefixCheck.ok) {
            return res.status(400).json({
                available: false,
                error: prefixCheck.error
            });
        }

        const nameCheck = validateSearchName(req.query.name);
        if (!nameCheck.ok) {
            return res.status(400).json({
                available: false,
                error: nameCheck.error
            });
        }

        const excludeId = Number.parseInt(req.query.exclude, 10);
        const hasExclude = Number.isInteger(excludeId) && excludeId > 0;

        // The DB trigger recomputes search_tag from
        // search_prefix + search_name, and the stored value is
        // already normalized (lowercase, only [a-z0-9]). We use
        // the same normalization here so the check matches the
        // unique index exactly.
        const candidateTag = buildSearchTag(prefixCheck.value, nameCheck.value);

        const params = [candidateTag];
        let query =
            'SELECT id, business_name, search_display FROM businesses WHERE search_tag = $1';

        if (hasExclude) {
            query += ' AND id <> $2';
            params.push(excludeId);
        }

        const result = await pool.query(query, params);

        if (result.rows.length > 0) {
            return res.json({
                available: false,
                message: 'This number is already used. Please try another.',
                taken_by: result.rows[0].business_name || null,
                display: result.rows[0].search_display || null
            });
        }

        return res.json({
            available: true,
            message: 'This search tag is available.',
            display: `${prefixCheck.value}${nameCheck.value}`
        });
    } catch (err) {
        console.error('❌ Check business tag error:', err);
        res.status(500).json({
            available: false,
            error: 'Could not check the search tag right now. Please try again.'
        });
    }
});

// ============================================================
//  CHECK IF ADMIN EXISTS (Super Admin Check)
// ============================================================

router.get('/admin-exists', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM admin_users WHERE role = $1', ['super_admin']);
    const count = parseInt(result.rows[0].count);
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error('❌ Admin exists error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REGISTER SUPER ADMIN (First-time setup only)
// ============================================================

router.post('/register', [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    const username = email.split('@')[0];

    const existsResult = await pool.query('SELECT COUNT(*) FROM admin_users WHERE role = $1', ['super_admin']);
    const count = parseInt(existsResult.rows[0].count);

    if (count > 0) {
      return res.status(403).json({ error: 'A super admin account already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO admin_users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, email, hashedPassword, 'super_admin']
    );

    const token = generateToken(email, 'super_admin');
    setAuthCookie(res, token);
    await logAdminActivity(result.rows[0].id, 'REGISTER_SUPER_ADMIN', { email });

    console.log('✅ Super admin account created for:', email);
    res.json({ success: true, message: '✅ Super admin account created successfully!' });

  } catch (err) {
    console.error('❌ Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  SUPER ADMIN LOGIN
// ============================================================

router.post('/login', loginLimiter, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, password } = req.body;
    console.log('🔑 Admin login attempt for:', email);

    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      console.log('❌ Admin not found:', email);
      return res.status(401).json({ error: 'Invalid credentials - Admin not found' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({ error: 'Invalid credentials - Wrong password' });
    }

    if (user.role !== 'super_admin') {
      console.log('❌ Not a super admin:', user.role);
      return res.status(403).json({ error: 'This is not a super admin account.' });
    }

    const token = generateToken(email, 'super_admin');
    setAuthCookie(res, token);
    await logAdminActivity(user.id, 'SUPER_ADMIN_LOGIN', { email });

    console.log('✅ Super admin login successful for:', email);
    res.json({ success: true, role: 'super_admin' });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER REGISTER - WITH USERNAME
// ============================================================

router.post('/customer/register', [
  body('username').notEmpty().withMessage('Username required'),
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('name').notEmpty().withMessage('Name required'),
  body('email').isEmail().withMessage('Invalid email'),
  body('phone').notEmpty().withMessage('Phone number required'),
  body('phone').custom(value => validateKenyanPhone(value)).withMessage('Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, name, email, phone, password } = req.body;
    const cleanPhone = phone.replace(/[^0-9]/g, '');

    const existingUsername = await pool.query(
      'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
      [username]
    );
    if (existingUsername.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken. Please choose another.' });
    }

    const existing = await pool.query('SELECT * FROM customers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }

    const existingPhone = await pool.query('SELECT * FROM customers WHERE phone = $1', [cleanPhone]);
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO customers (username, name, email, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, name, email, phone, created_at',
      [username, name, email, hashedPassword, cleanPhone]
    );
    const customer = result.rows[0];
    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2)', [customer.id, '[]']);
    const token = generateToken(email, 'customer', customer.id);
    setAuthCookie(res, token);
    res.json({ success: true, customer });
  } catch (err) {
    console.error('❌ Customer register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER LOGIN - SMART (Username or Email)
// ============================================================

router.post('/customer/login', loginLimiter, [
  body('username').notEmpty().withMessage('Username/Email required'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, password } = req.body;

    const isEmail = username.includes('@');

    let result;
    if (isEmail) {
      result = await pool.query('SELECT * FROM customers WHERE email = $1', [username]);
    } else {
      result = await pool.query('SELECT * FROM customers WHERE username = $1', [username]);
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const customer = result.rows[0];
    const match = await bcrypt.compare(password, customer.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = $1', [customer.id]);
    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2) ON CONFLICT (customer_id) DO NOTHING', [customer.id, '[]']);
    const token = generateToken(customer.email, 'customer', customer.id);
    setAuthCookie(res, token);
    res.json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.name,
        username: customer.username,
        email: customer.email,
        phone: customer.phone || ''
      }
    });
  } catch (err) {
    console.error('❌ Customer login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  BUSINESS REGISTRATION - WITH USERNAME AND MULTIPLE CATEGORIES
//  A.4 — Validate category
//  A.5 — Save selected category with the business record
//  A.6 — Support primary + additional categories
//
//  Search tag (new):
//   - accepts `search_prefix` (3 or 4 digits) and `search_name`
//     (the name the owner wants customers to type);
//   - validates both, checks that the normalized combination is
//     not already used by another business, and rejects the
//     request with 409 if it is;
//   - stores the raw prefix and name on the row; the DB trigger
//     fills in search_tag and search_display automatically.
// ============================================================

router.post('/business/register', upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'heroImage', maxCount: 1 }
]), [
  body('business_name').notEmpty().withMessage('Business name required'),
  body('email').isEmail().withMessage('Invalid email'),
  body('phone').notEmpty().withMessage('Phone number required'),
  body('location').notEmpty().withMessage('Location required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('username').notEmpty().withMessage('Username required'),
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('category').notEmpty().withMessage('Business category required')
], async (req, res) => {
  try {
    console.log('📝 Business registration request received');
    console.log('📝 Email:', req.body.email);
    console.log('📝 Username:', req.body.username);
    console.log('📝 Category:', req.body.category);
    console.log('📝 Additional categories:', req.body.additional_categories);
    console.log('📝 Search prefix:', req.body.search_prefix);
    console.log('📝 Search name:', req.body.search_name);

    const validationErrors = validationResult(req);
    if (!validationErrors.isEmpty()) {
      return res.status(400).json({ errors: validationErrors.array() });
    }

    const {
      business_name, email, phone, location, password,
      description, mission, vision, address,
      whatsapp, tiktok, instagram, facebook, website,
      mpesa_enabled, mpesa_number,
      airtel_enabled, airtel_number,
      bank_enabled, bank_name, bank_account, bank_account_name,
      paypal_enabled, paypal_email,
      shipping_policy, return_policy, terms_policy, privacy_policy,
      delivery_enabled, online_orders_enabled,
      username,
      category,
      search_prefix,
      search_name
    } = req.body;

    const additional_categories = req.body.additional_categories;

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    if (!business_name || !business_name.trim()) {
      return res.status(400).json({ error: 'Business name is required' });
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!location || !location.trim()) {
      return res.status(400).json({ error: 'Location is required' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!category) {
      return res.status(400).json({ error: 'Business category is required' });
    }

    // A.4 / A.5 — primary category ID
    const primaryCategoryId = parseInt(category, 10);
    if (Number.isNaN(primaryCategoryId)) {
      return res.status(400).json({ error: 'Invalid business category' });
    }

    // A.6 — additional categories
    const additionalCategoryIds = [
      ...new Set(
        String(additional_categories || '')
          .split(',')
          .map(value => parseInt(value.trim(), 10))
          .filter(value => Number.isInteger(value))
      )
    ].filter(id => id !== primaryCategoryId);

    const allCategoryIds = [primaryCategoryId, ...additionalCategoryIds];
    const categoryCheck = await pool.query(
      'SELECT id FROM business_categories WHERE id = ANY($1::int[])',
      [allCategoryIds]
    );

    if (categoryCheck.rows.length !== allCategoryIds.length) {
      const foundIds = categoryCheck.rows.map(row => row.id);
      const missingIds = allCategoryIds.filter(id => !foundIds.includes(id));
      console.warn('❌ Missing business categories:', missingIds);
      return res.status(400).json({
        error: 'One or more selected business categories do not exist',
        missing_category_ids: missingIds
      });
    }

    // ----------------------------------------------------------
    //  Business Search Tag — validate the two pieces
    // ----------------------------------------------------------
    const prefixCheck = validateSearchPrefix(search_prefix);
    if (!prefixCheck.ok) {
      return res.status(400).json({
        error: prefixCheck.error,
        field: 'search_prefix'
      });
    }

    const nameCheck = validateSearchName(search_name);
    if (!nameCheck.ok) {
      return res.status(400).json({
        error: nameCheck.error,
        field: 'search_name'
      });
    }

    const candidateTag = buildSearchTag(prefixCheck.value, nameCheck.value);

    const tagConflict = await pool.query(
      'SELECT id, business_name FROM businesses WHERE search_tag = $1 LIMIT 1',
      [candidateTag]
    );

    if (tagConflict.rows.length > 0) {
      return res.status(409).json({
        error: 'This number is already used. Please try another.',
        field: 'search_prefix',
        taken_by: tagConflict.rows[0].business_name || null
      });
    }

    // ----------------------------------------------------------
    //  Existing username + email checks
    // ----------------------------------------------------------

    const existingUsername = await pool.query(
      'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
      [username]
    );
    if (existingUsername.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken. Please choose another.' });
    }

    const existingAdmin = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (existingAdmin.rows.length > 0) {
      console.log('❌ Email already registered:', email);
      return res.status(409).json({ error: 'Email already registered as admin.' });
    }

    let slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = 'business-' + Date.now();
    const slugCheck = await pool.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      slug = `${slug}-${Date.now().toString().slice(-4)}`;
    }

    let logo = null, heroImage = null;
    if (req.files) {
      if (req.files.logo && req.files.logo[0]) {
        try {
          logo = await uploadToCloudinary(req.files.logo[0].path, { folder: 'business_shop/logos' });
          console.log('✅ Logo uploaded');
        } catch (e) { console.error('Logo upload error:', e); }
      }
      if (req.files.heroImage && req.files.heroImage[0]) {
        try {
          heroImage = await uploadToCloudinary(req.files.heroImage[0].path, { folder: 'business_shop/hero' });
          console.log('✅ Hero image uploaded');
        } catch (e) { console.error('Hero upload error:', e); }
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('✅ Password hashed');

    await pool.query('BEGIN');

    const adminResult = await pool.query(
      `INSERT INTO admin_users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, email, hashedPassword, 'business_admin']
    );
    const adminId = adminResult.rows[0].id;
    console.log('✅ Admin user created:', adminId);

    // ----------------------------------------------------------
    //  Insert the business row.
    //
    //  search_prefix and search_name are written raw. The DB
    //  trigger set_business_search_tag() fills in search_tag,
    //  search_display and search_tag_updated_at in the same
    //  statement. search_tag_confirmed is set TRUE here because
    //  the owner is choosing it deliberately during registration.
    // ----------------------------------------------------------
    const businessResult = await pool.query(`
      INSERT INTO businesses (
        business_name, slug, owner_id, location, address,
        latitude, longitude, description, mission, vision,
        logo, heroImage, whatsapp, tiktok, instagram, facebook,
        phone, email, website,
        mpesa_enabled, mpesa_number,
        airtel_enabled, airtel_number,
        bank_enabled, bank_name, bank_account, bank_account_name,
        paypal_enabled, paypal_email,
        shipping_policy, return_policy, terms_policy, privacy_policy,
        delivery_enabled, online_orders_enabled,
        is_verified, is_active,
        search_prefix, search_name, search_tag_confirmed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40)
      RETURNING id
    `, [
      business_name.trim(), slug, adminId,
      location || 'Nairobi, Kenya', address || null,
      null, null,
      description || null, mission || null, vision || null,
      logo, heroImage,
      whatsapp || null, tiktok || null, instagram || null, facebook || null,
      cleanPhone, email, website || null,
      mpesa_enabled === 'true' || mpesa_enabled === true || false,
      mpesa_number || null,
      airtel_enabled === 'true' || airtel_enabled === true || false,
      airtel_number || null,
      bank_enabled === 'true' || bank_enabled === true || false,
      bank_name || null, bank_account || null, bank_account_name || null,
      paypal_enabled === 'true' || paypal_enabled === true || false,
      paypal_email || null,
      shipping_policy || null, return_policy || null,
      terms_policy || null, privacy_policy || null,
      delivery_enabled !== 'false', online_orders_enabled !== 'false',
      true, true,
      prefixCheck.value, nameCheck.value, true
    ]);
    const businessId = businessResult.rows[0].id;
    console.log('✅ Business created:', businessId);

    await pool.query(
      `INSERT INTO business_category_assignments (business_id, category_id)
       SELECT $1, UNNEST($2::int[])
       ON CONFLICT (business_id, category_id) DO NOTHING`,
      [businessId, allCategoryIds]
    );
    console.log('✅ Business categories assigned:', allCategoryIds.join(', '));

    await pool.query('UPDATE admin_users SET business_id = $1 WHERE id = $2', [businessId, adminId]);

    await pool.query('INSERT INTO business_stats (business_id) VALUES ($1)', [businessId]);

    await pool.query('COMMIT');

    const businessData = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
    const token = generateToken(email, 'business_admin', adminId);
    setAuthCookie(res, token);

    const savedBusiness = businessData.rows[0];

    console.log('✅ Business registered successfully:', business_name);
    console.log('✅ Email:', email);
    console.log('✅ Username:', username);
    console.log('✅ Business ID:', businessId);
    console.log('✅ Category IDs saved:', allCategoryIds.join(', '));
    console.log('✅ Search tag saved:', savedBusiness.search_display || '(none)');

    res.status(201).json({
      success: true,
      role: 'business_admin',
      business_id: businessId,
      business: savedBusiness,
      slug: slug,
      category_ids: allCategoryIds,
      primary_category_id: primaryCategoryId,
      additional_category_ids: additionalCategoryIds,
      search_display: savedBusiness.search_display || null,
      search_tag: savedBusiness.search_tag || null,
      message: 'Business registered successfully!'
    });

  } catch (err) {
    await pool.query('ROLLBACK');

    // The unique index on search_tag is the last line of defense
    // against a race between two simultaneous registrations that
    // picked the same digits + name. Convert the raw Postgres
    // error into the same friendly message the pre-check returns.
    if (err && err.code === '23505' && err.constraint === 'idx_businesses_search_tag_unique') {
      return res.status(409).json({
        error: 'This number is already used. Please try another.',
        field: 'search_prefix'
      });
    }

    console.error('❌ Business registration error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  BUSINESS LOGIN - SMART (Username or Email)
// ============================================================

router.post('/business/login', loginLimiter, [
  body('username').notEmpty().withMessage('Username/Email required'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, password } = req.body;
    console.log('🔑 Business login attempt:', username);

    const isEmail = username.includes('@');

    let result;
    if (isEmail) {
      result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [username]);
    } else {
      result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    }

    if (result.rows.length === 0) {
      console.log('❌ Admin not found:', username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    console.log('👤 User found, checking password...');

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      console.log('❌ Password mismatch for:', username);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    console.log('✅ Password matched for:', username);

    if (user.role !== 'business_admin') {
      console.log('❌ Not a business admin:', user.role);
      return res.status(403).json({ error: 'This is not a business admin account.' });
    }

    if (!user.business_id) {
      console.log('❌ No business_id for user:', username);
      return res.status(403).json({ error: 'Account not associated with any business.' });
    }

    const businessCheck = await pool.query(
      'SELECT id, business_name, is_active, slug FROM businesses WHERE id = $1',
      [user.business_id]
    );

    if (businessCheck.rows.length === 0) {
      console.log('❌ Business not found for ID:', user.business_id);
      return res.status(403).json({ error: 'Business not found.' });
    }

    if (!businessCheck.rows[0].is_active) {
      console.log('❌ Business is inactive:', user.business_id);
      return res.status(403).json({ error: 'Business is inactive.' });
    }

    const token = generateToken(user.email, 'business_admin', user.id);
    setAuthCookie(res, token);
    await logAdminActivity(user.id, 'BUSINESS_LOGIN', { email: user.email, businessId: user.business_id });

    console.log('✅ Business admin login successful for:', username);
    console.log('✅ Business:', businessCheck.rows[0].business_name);

    res.json({
      success: true,
      role: 'business_admin',
      business_id: user.business_id,
      business_name: businessCheck.rows[0].business_name,
      slug: businessCheck.rows[0].slug,
      email: user.email
    });

  } catch (err) {
    console.error('❌ Business login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  VERIFY TOKEN (Generic)
// ============================================================

router.get('/verify', authMiddleware, (req, res) => {
  res.json({ authenticated: true, role: req.role, userId: req.userId });
});

// ============================================================
//  GET MY BUSINESS (For logged-in business admin)
//
//  Section B: returns `has_business_category` so the admin UI can
//  warn businesses that registered before Section B and have no
//  business category assigned yet.
//
//  Search tag: returns search_prefix / search_name / search_tag /
//  search_display / search_tag_confirmed so the business admin
//  panel can show the owner their current tag and let them change
//  it without a second request.
// ============================================================

router.get('/my-business', authMiddleware, async (req, res) => {
  try {
    console.log('📊 Fetching business for user...');
    console.log('📊 req.userId:', req.userId);
    console.log('📊 req.email:', req.email);
    console.log('📊 req.role:', req.role);

    let userId = req.userId;
    let email = req.email;

    if (!userId && email) {
      console.log('🔍 Looking up user by email:', email);
      const userResult = await pool.query(
        'SELECT id, role, business_id FROM admin_users WHERE email = $1',
        [email]
      );

      if (userResult.rows.length === 0) {
        console.log('❌ User not found for email:', email);
        return res.json({ business: null });
      }

      userId = userResult.rows[0].id;
      req.userId = userId;
      req.role = userResult.rows[0].role;

      console.log('✅ User found by email - ID:', userId, 'Role:', req.role);
    }

    if (!userId) {
      console.log('❌ No userId or email provided');
      return res.json({ business: null });
    }

    const userResult = await pool.query(
      'SELECT id, role, business_id, email FROM admin_users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      console.log('❌ User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    console.log('👤 User found:', user.email, 'Role:', user.role, 'Business ID:', user.business_id);

    if (user.role === 'super_admin') {
      console.log('ℹ️ Super admin - no business to return');
      return res.json({ business: null });
    }

    if (user.role !== 'business_admin') {
      console.log('ℹ️ Not a business admin - role:', user.role);
      return res.json({ business: null });
    }

    if (!user.business_id) {
      console.log('ℹ️ User has no business_id');
      return res.json({ business: null });
    }

    const businessResult = await pool.query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
        (SELECT COUNT(*) FROM orders WHERE business_id = b.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue,
        (SELECT COUNT(*) FROM business_category_assignments WHERE business_id = b.id) as business_category_count
      FROM businesses b
      WHERE b.id = $1 AND b.is_active = true
    `, [user.business_id]);

    if (businessResult.rows.length === 0) {
      console.log('❌ Business not found for ID:', user.business_id);
      return res.json({ business: null });
    }

    const business = businessResult.rows[0];
    console.log('✅ Business found:', business.business_name);
    console.log('✅ Business category count:', business.business_category_count);
    console.log('✅ Search tag:', business.search_display || '(none)');

    res.json({
      business,
      role: user.role,
      has_business_category: parseInt(business.business_category_count, 10) > 0,
      has_search_tag: Boolean(business.search_tag) && business.search_tag_confirmed === true
    });

  } catch (err) {
    console.error('❌ Get my business error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE MY BUSINESS SEARCH TAG
//
//  Lets a business admin change the search tag from the admin
//  panel after registration. Uses the same validation and
//  uniqueness rules as the register route, and returns the new
//  tag so the UI can render it immediately.
//
//  Body:
//    search_prefix   — 3 or 4 digits
//    search_name     — the name customers will type
// ============================================================

router.put('/my-business/search-tag', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
  try {
    const { search_prefix, search_name } = req.body || {};

    const prefixCheck = validateSearchPrefix(search_prefix);
    if (!prefixCheck.ok) {
      return res.status(400).json({ error: prefixCheck.error, field: 'search_prefix' });
    }

    const nameCheck = validateSearchName(search_name);
    if (!nameCheck.ok) {
      return res.status(400).json({ error: nameCheck.error, field: 'search_name' });
    }

    const candidateTag = buildSearchTag(prefixCheck.value, nameCheck.value);

    const conflict = await pool.query(
      'SELECT id, business_name FROM businesses WHERE search_tag = $1 AND id <> $2 LIMIT 1',
      [candidateTag, req.businessId]
    );

    if (conflict.rows.length > 0) {
      return res.status(409).json({
        error: 'This number is already used. Please try another.',
        field: 'search_prefix',
        taken_by: conflict.rows[0].business_name || null
      });
    }

    const result = await pool.query(`
      UPDATE businesses
      SET search_prefix = $1,
          search_name = $2,
          search_tag_confirmed = TRUE,
          updated_at = NOW()
      WHERE id = $3
      RETURNING id, business_name, search_prefix, search_name,
                search_tag, search_display, search_tag_confirmed,
                search_tag_updated_at
    `, [prefixCheck.value, nameCheck.value, req.businessId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    const row = result.rows[0];
    await logAdminActivity(req.userId, 'UPDATE_SEARCH_TAG', {
      businessId: req.businessId,
      search_display: row.search_display
    });

    res.json({
      success: true,
      business: {
        search_prefix: row.search_prefix,
        search_name: row.search_name,
        search_tag: row.search_tag,
        search_display: row.search_display,
        search_tag_confirmed: row.search_tag_confirmed,
        search_tag_updated_at: row.search_tag_updated_at
      }
    });
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'idx_businesses_search_tag_unique') {
      return res.status(409).json({
        error: 'This number is already used. Please try another.',
        field: 'search_prefix'
      });
    }
    console.error('❌ Update search tag error:', err);
    res.status(500).json({ error: 'Unable to save the search tag right now.' });
  }
});

// ============================================================
//  CUSTOMER VERIFY
//
//  D.11 — this endpoint deliberately does NOT return latitude,
//  longitude, location_accuracy, or any other location field.
//  No auth route exposes a customer's coordinates.
//
//  E.2 — preferred_* names are also omitted from this response.
//  The customer's own preferred area is only readable via
//  GET /api/location/customer/preferred-locations.
// ============================================================

router.get('/customer/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, username, email, phone, created_at FROM customers WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('❌ Customer verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER UPDATE PROFILE
//
//  Section D.1 / D.2 / D.10 / D.12 — the same endpoint now also
//  accepts location fields so the profile UI can activate, refresh,
//  or turn off location sharing without a separate page:
//
//    * body.latitude  + body.longitude  → save and mark activated
//    * body.location_activated === false → clear coordinates and
//                                          deactivate
//    * body.accuracy (optional)          → store the browser accuracy
//
//  Section E.2 — the endpoint also accepts preferred area names:
//
//    * body.preferred_continent, preferred_country,
//      preferred_county, preferred_sub_county,
//      preferred_ward, preferred_town
//
//    A field that is not sent  → left unchanged.
//    A field sent as "" or null → cleared.
//
//  Coordinates and preferred names are written only to the
//  requesting customer's own row. The response echoes back the
//  activation state and the saved preferred block so the UI can
//  update without a second request.
// ============================================================

router.put('/customer/profile', authMiddleware, async (req, res) => {
  const {
    name, phone, email,
    latitude, longitude, accuracy, location_activated,
    preferred_continent, preferred_country, preferred_county,
    preferred_sub_county, preferred_ward, preferred_town
  } = req.body;

  try {
    if (phone && !validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
    }

    const cleanPhone = phone ? phone.replace(/[^0-9]/g, '') : null;

    // ----------------------------------------------------------
    //  E.2 — Determine whether any preferred field was sent.
    //  "Sent" means the key exists on req.body, even if empty.
    //  This lets the caller clear a single field by passing ''.
    // ----------------------------------------------------------
    const preferredUpdates = {};
    const preferredKeys = [
      ['preferred_continent', preferred_continent],
      ['preferred_country', preferred_country],
      ['preferred_county', preferred_county],
      ['preferred_sub_county', preferred_sub_county],
      ['preferred_ward', preferred_ward],
      ['preferred_town', preferred_town]
    ];
    let preferredSent = false;
    let preferredHasValue = false;
    for (const [column, raw] of preferredKeys) {
      const normalised = normalisePreferred(raw);
      if (normalised !== undefined) {
        preferredUpdates[column] = normalised;
        preferredSent = true;
        if (normalised !== null) preferredHasValue = true;
      }
    }

    // ----------------------------------------------------------
    //  D.10 — explicit deactivation: clear stored coordinates
    //  and turn the activation flag off.
    // ----------------------------------------------------------
    if (location_activated === false) {
      const clearResult = await pool.query(`
        UPDATE customers
        SET name = COALESCE($1, name),
            phone = COALESCE($2, phone),
            email = COALESCE($3, email),
            latitude = NULL,
            longitude = NULL,
            location_accuracy = NULL,
            location_activated = FALSE,
            location_activated_at = NULL,
            location_source = NULL,
            updated_at = NOW()
        WHERE id = $4
        RETURNING id, name, username, email, phone,
                  latitude, longitude, location_accuracy,
                  location_activated, location_activated_at, location_source
      `, [name || null, cleanPhone, email || null, req.userId]);

      if (clearResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Apply any preferred updates that were also sent in the
      // same request.
      let preferredBlock = null;
      if (preferredSent) {
        preferredBlock = await applyPreferredUpdates(req.userId, preferredUpdates, preferredHasValue);
      }

      return res.json({
        user: clearResult.rows[0],
        location: {
          activated: false,
          latitude: null,
          longitude: null,
          accuracy: null,
          activated_at: null,
          source: null
        },
        preferred_locations: preferredBlock
      });
    }

    // ----------------------------------------------------------
    //  D.1 / D.2 / D.12 — coordinate save (initial activation or
    //  refresh). Only runs when both coordinates were supplied.
    // ----------------------------------------------------------
    const wantsLocationSave =
      latitude !== undefined && latitude !== null && latitude !== '' &&
      longitude !== undefined && longitude !== null && longitude !== '';

    if (wantsLocationSave) {
      const parsed = parseCoordinatePair(latitude, longitude);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }

      const accuracyValue = normaliseAccuracy(accuracy);

      const result = await pool.query(`
        UPDATE customers
        SET name = COALESCE($1, name),
            phone = COALESCE($2, phone),
            email = COALESCE($3, email),
            latitude = $4,
            longitude = $5,
            location_accuracy = COALESCE($6, location_accuracy),
            location_activated = TRUE,
            location_activated_at = NOW(),
            location_source = 'browser',
            updated_at = NOW()
        WHERE id = $7
        RETURNING id, name, username, email, phone,
                  latitude, longitude, location_accuracy,
                  location_activated, location_activated_at, location_source
      `, [
        name || null,
        cleanPhone,
        email || null,
        parsed.lat.toString(),
        parsed.lng.toString(),
        accuracyValue,
        req.userId
      ]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const row = result.rows[0];

      let preferredBlock = null;
      if (preferredSent) {
        preferredBlock = await applyPreferredUpdates(req.userId, preferredUpdates, preferredHasValue);
      }

      return res.json({
        user: row,
        location: {
          activated: row.location_activated === true,
          latitude: row.latitude,
          longitude: row.longitude,
          accuracy: row.location_accuracy,
          activated_at: row.location_activated_at,
          source: row.location_source
        },
        preferred_locations: preferredBlock
      });
    }

    // ----------------------------------------------------------
    //  Plain profile update — no location fields were sent.
    //  Apply preferred updates separately if any were sent.
    // ----------------------------------------------------------
    const result = await pool.query(
      'UPDATE customers SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email) WHERE id = $4 RETURNING id, name, username, email, phone',
      [name, cleanPhone, email, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    let preferredBlock = null;
    if (preferredSent) {
      preferredBlock = await applyPreferredUpdates(req.userId, preferredUpdates, preferredHasValue);
    }

    res.json({
      user: result.rows[0],
      preferred_locations: preferredBlock
    });

  } catch (err) {
    console.error('❌ Profile update error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Internal helper — apply a set of preferred_* updates to the
 * customer's row. Any key present in `updates` is written, even if
 * its value is null (which clears the column). If
 * `hasValue` is false, every column ends up NULL and we also reset
 * the updated_at marker, matching the "cleared" state.
 */
async function applyPreferredUpdates(customerId, updates, hasValue) {
  const columns = [
    'preferred_continent',
    'preferred_country',
    'preferred_county',
    'preferred_sub_county',
    'preferred_ward',
    'preferred_town'
  ];

  const values = columns.map(col =>
    Object.prototype.hasOwnProperty.call(updates, col) ? updates[col] : null
  );

  const result = await pool.query(`
    UPDATE customers
    SET preferred_continent = $1,
        preferred_country = $2,
        preferred_county = $3,
        preferred_sub_county = $4,
        preferred_ward = $5,
        preferred_town = $6,
        preferred_locations_updated_at = CASE WHEN $7 THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE id = $8
    RETURNING
      preferred_continent,
      preferred_country,
      preferred_county,
      preferred_sub_county,
      preferred_ward,
      preferred_town,
      preferred_locations_updated_at
  `, [...values, hasValue, customerId]);

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const block = {
    continent: row.preferred_continent || null,
    country: row.preferred_country || null,
    county: row.preferred_county || null,
    sub_county: row.preferred_sub_county || null,
    ward: row.preferred_ward || null,
    town: row.preferred_town || null,
    updated_at: row.preferred_locations_updated_at || null
  };
  block.has_any = Boolean(
    block.continent || block.country || block.county ||
    block.sub_county || block.ward || block.town
  );
  return block;
}

// ============================================================
//  CUSTOMER LOGOUT
// ============================================================

router.post('/customer/logout', authMiddleware, (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// ============================================================
//  CHECK EMAIL EXISTS
// ============================================================

router.post('/customer/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    console.error('❌ Check email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DELETE CUSTOMER ACCOUNT
// ============================================================

router.delete('/customer/delete', authMiddleware, async (req, res) => {
  try {
    const customerId = req.userId;
    await pool.query('BEGIN');
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await pool.query(`DELETE FROM order_chat_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`, [customerId]);
    await pool.query('DELETE FROM orders WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM carts WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customer_addresses WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM wishlist WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM returns WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM product_reviews WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM payments WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM location_requests WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM chat_messages WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM notifications WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customers WHERE id = $1', [customerId]);
    await pool.query('COMMIT');
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Delete account error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PASSWORD RESET (Supports both admin and customer)
// ============================================================

router.post('/forgot-password', [
  body('email').isEmail().withMessage('Invalid email')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email } = req.body;

    let user = null;
    let userType = null;

    const adminResult = await pool.query('SELECT id, email FROM admin_users WHERE email = $1', [email]);
    if (adminResult.rows.length > 0) {
      user = adminResult.rows[0];
      userType = 'admin';
    } else {
      const customerResult = await pool.query('SELECT id, email FROM customers WHERE email = $1', [email]);
      if (customerResult.rows.length > 0) {
        user = customerResult.rows[0];
        userType = 'customer';
      }
    }

    if (!user) {
      return res.json({ success: true, message: 'If your email is registered, you will receive a reset link.' });
    }

    const token = generateResetToken();
    const expiresAt = new Date(Date.now() + 3600000);

    await pool.query(
      `INSERT INTO password_resets (email, token, expires_at, user_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET token = $2, expires_at = $3, user_type = $4`,
      [email, token, expiresAt, userType]
    );

    const resetLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
    const mailData = forgotPasswordEmail(email, resetLink);
    await sendEmail({
      to: email,
      subject: mailData.subject,
      html: mailData.html,
      text: mailData.text
    });

    res.json({ success: true, message: 'If your email is registered, you will receive a reset link.' });
  } catch (err) {
    console.error('❌ Forgot password error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset-password', [
  body('token').notEmpty().withMessage('Token required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { token, password } = req.body;
    const result = await pool.query(
      'SELECT email, user_type FROM password_resets WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    const { email, user_type } = result.rows[0];
    const hashedPassword = await bcrypt.hash(password, 10);

    if (user_type === 'admin') {
      await pool.query('UPDATE admin_users SET password = $1 WHERE email = $2', [hashedPassword, email]);
    } else {
      await pool.query('UPDATE customers SET password = $1 WHERE email = $2', [hashedPassword, email]);
    }

    await pool.query('DELETE FROM password_resets WHERE token = $1', [token]);

    res.json({ success: true, message: '✅ Password reset successfully! You can now login.' });
  } catch (err) {
    console.error('❌ Reset password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CSRF TOKEN ENDPOINT
// ============================================================

router.get('/csrf-token', (req, res) => {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    res.json({ csrfToken: token });
  } catch (err) {
    console.error('❌ CSRF token error:', err);
    res.status(500).json({ error: 'Failed to generate CSRF token' });
  }
});

module.exports = router;