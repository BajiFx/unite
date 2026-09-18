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
//  Section 6 — Customer registration simplified:
//   Required: name, phone, password.
//   Optional: email (kept for password recovery).
//   Auto-generated: username (from name, unique suffix).
//   Login now accepts username OR email OR phone as the lookup.
//
//  Section 7 — Business registration simplified:
//   Required: business_name, category, email, phone, password,
//             location.
//   Optional / auto-generated:
//     - username       (from business name + random suffix)
//     - search_prefix  (random 3–4 digits, never 000/0000)
//     - search_name    (defaults to the business name)
//     - additional_categories
//     - description, mission, vision, address, website,
//       socials, payment fields
//   The route still accepts every old field, so an older client
//   or a Postman call continues to work. Missing pieces are
//   filled in on the server. Search-tag collisions retry with a
//   new random prefix.
//
//  Section — Business Search Tag:
//   Every business has a short, unique, human-typable tag of
//   the form <digits><name> (e.g. 3734Doppa Beddings). The DB
//   trigger in 004_business_search_tag.sql normalizes both
//   pieces and fills in search_tag / search_display.
//
//  Section 11.A — Customer account deletion:
//   POST /customer/request-deletion
//     Schedules the deletion 30 days out and stores the reason.
//     The password is re-verified against the customer's hash
//     before the deletion is scheduled.
//   POST /customer/cancel-deletion
//     Cancels a pending deletion on the requesting customer's
//     own row. Also called automatically from /customer/login.
//   The customer row is never hard-deleted. A daily cron job
//   in server.js anonymizes rows past the grace period.
//
//  Section 11.B — Business account deletion:
//   POST /business/request-deletion
//     Schedules the deletion 60 days out, hides the business
//     from the marketplace, and deactivates the admin account.
//     The password is re-verified against the admin's hash
//     before the deletion is scheduled.
//   POST /business/cancel-deletion
//     Cancels a pending deletion on the requesting admin's own
//     business and reactivates both the business and the admin
//     account. Also called automatically from /business/login.
//   The business row is never hard-deleted. A daily cron job
//   in server.js finalizes the row past the grace period.
//
//  Super Admin — registration & login hardening:
//   POST /register
//     - Server now blocks a second super admin from being
//       created, even when the caller races two requests.
//     - Response is always JSON and always includes
//       { success, role } so the admin-login.js redirect
//       logic cannot be fooled by a stray non-JSON body.
//   POST /login
//     - Response is always JSON and always includes
//       { success, role: 'super_admin' } on success.
//     - Any non-super-admin account is rejected with 403 and
//       an explicit error string, so the client never redirects
//       a customer or business admin into the admin dashboard.
//   GET /admin-exists
//     - Returns { exists: boolean } for the login/register tab
//       selection on admin.html.
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
// ============================================================

function normalisePreferred(value) {
    if (value === undefined || value === null) return undefined;   // "not sent"
    const str = String(value).trim();
    if (str === '') return null;                                    // "sent empty" → clear
    return str.slice(0, 100);
}

// ============================================================
//  BUSINESS SEARCH TAG — helpers
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
//  Section 7 — auto-generation helpers
// ============================================================

async function generateUniqueBusinessUsername(businessName) {
    const base = String(businessName || 'business')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 20) || 'business';

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const suffix = Math.floor(1000 + Math.random() * 9000);
        const candidate = `${base}${suffix}`;
        const clash = await pool.query(
            'SELECT id FROM admin_users WHERE username = $1 UNION SELECT id FROM customers WHERE username = $1',
            [candidate]
        );
        if (clash.rows.length === 0) return candidate;
    }

    return `${base}${Date.now().toString().slice(-6)}`;
}

async function pickRandomFreeSearchPrefix(searchName, maxAttempts = 20) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const useFour = Math.random() < 0.5;
        let candidate;
        if (useFour) {
            candidate = String(Math.floor(1000 + Math.random() * 9000));
        } else {
            candidate = String(Math.floor(100 + Math.random() * 900));
        }

        if (candidate === '000' || candidate === '0000') continue;

        const candidateTag = buildSearchTag(candidate, searchName);
        if (!candidateTag) continue;

        const clash = await pool.query(
            'SELECT id FROM businesses WHERE search_tag = $1 LIMIT 1',
            [candidateTag]
        );
        if (clash.rows.length === 0) return candidate;
    }
    return null;
}

// ============================================================
//  Section 11.A — customer deletion reason set
// ============================================================

const CUSTOMER_DELETION_REASONS = new Set([
    "I don't shop here anymore",
    'Privacy concerns',
    'Too many emails',
    'Found a better marketplace',
    'Other'
]);

// ============================================================
//  Section 11.B — business deletion reason set
// ============================================================

const BUSINESS_DELETION_REASONS = new Set([
    'Closing my business',
    'Too expensive',
    'Not enough sales',
    'Privacy concerns',
    'Moving to another platform',
    'Other'
]);

// ============================================================
//  Section 11.A / 11.B — grace periods
// ============================================================

const CUSTOMER_DELETION_GRACE_DAYS = 30;
const BUSINESS_DELETION_GRACE_DAYS = 60;

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
    const result = await pool.query(
      'SELECT COUNT(*) FROM admin_users WHERE role = $1',
      ['super_admin']
    );
    const count = parseInt(result.rows[0].count, 10);
    res.json({ exists: count > 0 });
  } catch (err) {
    console.error('❌ Admin exists error:', err);
    res.status(500).json({ exists: false, error: err.message });
  }
});

// ============================================================
//  REGISTER SUPER ADMIN (First-time setup only)
//
//  Hardening:
//   - Every response is JSON.
//   - The guard uses a single INSERT ... WHERE NOT EXISTS
//     statement so two concurrent requests cannot both succeed.
//   - The success body always includes { success: true,
//     role: 'super_admin' } so the client redirect is
//     deterministic.
// ============================================================

router.post('/register', [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: errors.array()[0].msg || 'Invalid registration data'
    });
  }

  try {
    const { email, password } = req.body;
    const username = email.split('@')[0];

    const existing = await pool.query(
      'SELECT COUNT(*) FROM admin_users WHERE role = $1',
      ['super_admin']
    );
    const count = parseInt(existing.rows[0].count, 10);

    if (count > 0) {
      return res.status(403).json({
        success: false,
        error: 'A super admin account already exists.'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Atomic guard: this INSERT only writes a row if no
    // super_admin exists at the moment the statement runs.
    const insertResult = await pool.query(`
      INSERT INTO admin_users (username, email, password, role)
      SELECT $1, $2, $3, 'super_admin'
      WHERE NOT EXISTS (
        SELECT 1 FROM admin_users WHERE role = 'super_admin'
      )
      RETURNING id, email, role
    `, [username, email, hashedPassword]);

    if (insertResult.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'A super admin account already exists.'
      });
    }

    const inserted = insertResult.rows[0];

    const token = generateToken(email, 'super_admin', inserted.id);
    setAuthCookie(res, token);

    try {
      await logAdminActivity(inserted.id, 'REGISTER_SUPER_ADMIN', { email });
    } catch (logErr) {
      console.warn('⚠️ Could not log super admin registration:', logErr.message);
    }

    console.log('✅ Super admin account created for:', email);

    res.json({
      success: true,
      role: 'super_admin',
      message: '✅ Super admin account created successfully!'
    });

  } catch (err) {
    console.error('❌ Register error:', err);

    // Map a unique-constraint violation to the same clean
    // 403 that the guard above returns, so a race can never
    // leak a raw 500.
    if (err && err.code === '23505') {
      return res.status(403).json({
        success: false,
        error: 'A super admin account already exists.'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Registration failed. Please try again.'
    });
  }
});

// ============================================================
//  SUPER ADMIN LOGIN
//
//  Hardening:
//   - Every response is JSON.
//   - Non super_admin roles are rejected with 403 and an
//     explicit error string before any token is issued.
//   - Success body always carries { success: true,
//     role: 'super_admin' }.
// ============================================================

router.post('/login', loginLimiter, [
  body('email').isEmail().withMessage('Invalid email'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: errors.array()[0].msg || 'Invalid login data'
    });
  }

  try {
    const { email, password } = req.body;
    console.log('🔑 Admin login attempt for:', email);

    const result = await pool.query(
      'SELECT id, email, password, role FROM admin_users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      console.log('❌ Admin not found:', email);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials - Admin not found'
      });
    }

    const user = result.rows[0];

    if (!user.password) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      console.log('❌ Invalid password for:', email);
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials - Wrong password'
      });
    }

    if (user.role !== 'super_admin') {
      console.log('❌ Not a super admin:', user.role);
      return res.status(403).json({
        success: false,
        error: 'This is not a super admin account.'
      });
    }

    const token = generateToken(email, 'super_admin', user.id);
    setAuthCookie(res, token);

    try {
      await logAdminActivity(user.id, 'SUPER_ADMIN_LOGIN', { email });
    } catch (logErr) {
      console.warn('⚠️ Could not log super admin login:', logErr.message);
    }

    console.log('✅ Super admin login successful for:', email);

    res.json({
      success: true,
      role: 'super_admin'
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({
      success: false,
      error: 'Login failed. Please try again.'
    });
  }
});

// ============================================================
//  CUSTOMER REGISTER — Section 6 simplified form
// ============================================================

router.post('/customer/register', [
  body('name').notEmpty().withMessage('Name required'),
  body('phone').notEmpty().withMessage('Phone number required'),
  body('phone').custom(value => validateKenyanPhone(value)).withMessage('Invalid phone number. Must be a valid Kenyan number (e.g., 0712345678)'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().withMessage('Invalid email'),
  body('username').optional({ nullable: true, checkFalsy: true }).isLength({ min: 3 }).withMessage('Username must be at least 3 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, phone, password } = req.body;
    const email = (req.body.email && String(req.body.email).trim()) || null;
    let username = (req.body.username && String(req.body.username).trim()) || null;

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    const existingPhone = await pool.query('SELECT id FROM customers WHERE phone = $1', [cleanPhone]);
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    if (email) {
      const existingEmail = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
      if (existingEmail.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered.' });
      }
    }

    if (username) {
      const existingUsername = await pool.query(
        'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
        [username]
      );
      if (existingUsername.rows.length > 0) {
        return res.status(409).json({ error: 'Username already taken. Please choose another.' });
      }
    } else {
      username = await generateUniqueCustomerUsername(name);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO customers (username, name, email, password, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, name, email, phone, created_at',
      [username, name, email, hashedPassword, cleanPhone]
    );
    const customer = result.rows[0];

    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2)', [customer.id, '[]']);

    const tokenSubject = email || cleanPhone;
    const token = generateToken(tokenSubject, 'customer', customer.id);
    setAuthCookie(res, token);

    res.json({ success: true, customer });
  } catch (err) {
    console.error('❌ Customer register error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function generateUniqueCustomerUsername(name) {
  const base = String(name || 'customer')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 20) || 'customer';

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${base}${suffix}`;
    const clash = await pool.query(
      'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
      [candidate]
    );
    if (clash.rows.length === 0) return candidate;
  }

  return `${base}${Date.now().toString().slice(-6)}`;
}

// ============================================================
//  CUSTOMER LOGIN — SMART
// ============================================================

router.post('/customer/login', loginLimiter, [
  body('username').notEmpty().withMessage('Username/Email/Phone required'),
  body('password').notEmpty().withMessage('Password required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, password } = req.body;

    const raw = String(username).trim();
    const isEmail = raw.includes('@');
    const digitsOnly = raw.replace(/[^0-9]/g, '');
    const looksLikePhone = !isEmail && digitsOnly.length >= 7;

    let result;

    if (isEmail) {
      result = await pool.query('SELECT * FROM customers WHERE email = $1', [raw]);
    } else if (looksLikePhone) {
      result = await pool.query(
        'SELECT * FROM customers WHERE phone = $1 OR phone = $2 LIMIT 1',
        [digitsOnly, raw]
      );
    } else {
      result = await pool.query('SELECT * FROM customers WHERE username = $1', [raw]);
    }

    if (result.rows.length === 0 && !isEmail && digitsOnly.length >= 7) {
      result = await pool.query('SELECT * FROM customers WHERE phone = $1 LIMIT 1', [digitsOnly]);
    }

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const customer = result.rows[0];

    if (!customer.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, customer.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let deletionCancelled = false;
    let cancellationContext = null;

    try {
      if (customer.deletion_scheduled_at) {
        const scheduledFor = new Date(customer.deletion_scheduled_at);
        await pool.query(
          `UPDATE customers
              SET deletion_scheduled_at = NULL,
                  deletion_reason = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [customer.id]
        );
        deletionCancelled = true;
        cancellationContext = { previous_scheduled_at: scheduledFor.toISOString() };
        console.log(`♻️ Customer #${customer.id} deletion auto-cancelled on login.`);
      }
    } catch (cancelErr) {
      console.warn('⚠️ Could not cancel pending customer deletion:', cancelErr.message);
    }

    await pool.query('UPDATE customers SET last_login_at = NOW() WHERE id = $1', [customer.id]);
    await pool.query('INSERT INTO carts (customer_id, items) VALUES ($1, $2) ON CONFLICT (customer_id) DO NOTHING', [customer.id, '[]']);

    const tokenSubject = customer.email || customer.phone || customer.username;
    const token = generateToken(tokenSubject, 'customer', customer.id);
    setAuthCookie(res, token);

    res.json({
      success: true,
      customer: {
        id: customer.id,
        name: customer.name,
        username: customer.username,
        email: customer.email,
        phone: customer.phone || ''
      },
      deletion_cancelled: deletionCancelled,
      deletion_context: cancellationContext
    });
  } catch (err) {
    console.error('❌ Customer login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  BUSINESS REGISTRATION — Section 7 simplified form
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
  body('category').notEmpty().withMessage('Business category required'),
  body('username').optional({ nullable: true, checkFalsy: true }).isLength({ min: 3 }).withMessage('Username must be at least 3 characters')
], async (req, res) => {
  try {
    console.log('📝 Business registration request received');
    console.log('📝 Email:', req.body.email);
    console.log('📝 Username (may be absent):', req.body.username);
    console.log('📝 Category:', req.body.category);
    console.log('📝 Additional categories:', req.body.additional_categories);
    console.log('📝 Search prefix (may be absent):', req.body.search_prefix);
    console.log('📝 Search name (may be absent):', req.body.search_name);

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
      category
    } = req.body;

    const additional_categories = req.body.additional_categories;

    let username = (req.body.username && String(req.body.username).trim()) || null;
    let search_prefix = (req.body.search_prefix && String(req.body.search_prefix).trim()) || null;
    let search_name = (req.body.search_name && String(req.body.search_name).trim()) || null;

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
    if (!category) {
      return res.status(400).json({ error: 'Business category is required' });
    }

    const primaryCategoryId = parseInt(category, 10);
    if (Number.isNaN(primaryCategoryId)) {
      return res.status(400).json({ error: 'Invalid business category' });
    }

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

    if (username) {
      const existingUsername = await pool.query(
        'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
        [username]
      );
      if (existingUsername.rows.length > 0) {
        return res.status(409).json({ error: 'Username already taken. Please choose another.' });
      }
    } else {
      username = await generateUniqueBusinessUsername(business_name);
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

    let resolvedPrefix = null;
    let resolvedName = null;

    if (search_prefix && search_name) {
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

      resolvedPrefix = prefixCheck.value;
      resolvedName = nameCheck.value;
    } else {
      resolvedName = String(business_name || '').trim().slice(0, 120) || 'My Shop';

      resolvedPrefix = await pickRandomFreeSearchPrefix(resolvedName);
      if (!resolvedPrefix) {
        return res.status(500).json({
          error: 'Could not allocate a search tag right now. Please try again.'
        });
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
    console.log('✅ Admin user created:', adminId, 'username:', username);

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
      resolvedPrefix, resolvedName, true
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
      username: username,
      category_ids: allCategoryIds,
      primary_category_id: primaryCategoryId,
      additional_category_ids: additionalCategoryIds,
      search_display: savedBusiness.search_display || null,
      search_tag: savedBusiness.search_tag || null,
      message: 'Business registered successfully!'
    });

  } catch (err) {
    await pool.query('ROLLBACK');

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

    if (!user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

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
      'SELECT id, business_name, is_active, slug, deletion_scheduled_at FROM businesses WHERE id = $1',
      [user.business_id]
    );

    if (businessCheck.rows.length === 0) {
      console.log('❌ Business not found for ID:', user.business_id);
      return res.status(403).json({ error: 'Business not found.' });
    }

    const businessRow = businessCheck.rows[0];

    let deletionCancelled = false;
    let cancellationContext = null;

    if (businessRow.deletion_scheduled_at || user.is_active === false) {
      try {
        const previousScheduledFor = businessRow.deletion_scheduled_at
          ? new Date(businessRow.deletion_scheduled_at).toISOString()
          : null;

        await pool.query(
          `UPDATE businesses
              SET deletion_scheduled_at = NULL,
                  deletion_reason = NULL,
                  is_active = TRUE,
                  updated_at = NOW()
            WHERE id = $1`,
          [businessRow.id]
        );

        await pool.query(
          `UPDATE admin_users
              SET is_active = TRUE
            WHERE id = $1`,
          [user.id]
        );

        deletionCancelled = true;
        cancellationContext = { previous_scheduled_at: previousScheduledFor };
        console.log(`♻️ Business #${businessRow.id} deletion auto-cancelled on login.`);
      } catch (cancelErr) {
        console.warn('⚠️ Could not cancel pending business deletion:', cancelErr.message);
      }
    }

    if (!businessRow.is_active && !deletionCancelled) {
      console.log('❌ Business is inactive:', user.business_id);
      return res.status(403).json({ error: 'Business is inactive.' });
    }

    const token = generateToken(user.email, 'business_admin', user.id);
    setAuthCookie(res, token);
    await logAdminActivity(user.id, 'BUSINESS_LOGIN', { email: user.email, businessId: user.business_id });

    console.log('✅ Business admin login successful for:', username);
    console.log('✅ Business:', businessRow.business_name);

    res.json({
      success: true,
      role: 'business_admin',
      business_id: user.business_id,
      business_name: businessRow.business_name,
      slug: businessRow.slug,
      email: user.email,
      deletion_cancelled: deletionCancelled,
      deletion_context: cancellationContext
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
//  SECTION 11.A — CUSTOMER ACCOUNT DELETION
// ============================================================

router.post('/customer/request-deletion', authMiddleware, customerOnly, [
  body('password').notEmpty().withMessage('Password required'),
  body('reason').notEmpty().withMessage('Reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const customerId = req.userId;
    if (!customerId || customerId === req.email) {
      return res.status(400).json({ error: 'Invalid user session' });
    }

    const { password, reason } = req.body;

    if (!CUSTOMER_DELETION_REASONS.has(String(reason))) {
      return res.status(400).json({ error: 'Please select a valid reason.' });
    }

    const customerResult = await pool.query(
      'SELECT id, password FROM customers WHERE id = $1',
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    if (!customer.password) {
      return res.status(400).json({ error: 'This account cannot be scheduled for deletion.' });
    }

    const passwordOk = await bcrypt.compare(password, customer.password);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    const result = await pool.query(`
      UPDATE customers
      SET deletion_scheduled_at = NOW() + ($1::text || ' days')::interval,
          deletion_reason = $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING deletion_scheduled_at, deletion_reason
    `, [String(CUSTOMER_DELETION_GRACE_DAYS), String(reason).slice(0, 100), customerId]);

    const row = result.rows[0];

    clearAuthCookie(res);

    console.log(`🗓️ Customer #${customerId} deletion scheduled for ${row.deletion_scheduled_at}.`);

    res.json({
      success: true,
      message: `Your account is scheduled for deletion in ${CUSTOMER_DELETION_GRACE_DAYS} days.`,
      deletion_scheduled_for: row.deletion_scheduled_at,
      deletion_reason: row.deletion_reason,
      grace_days: CUSTOMER_DELETION_GRACE_DAYS
    });
  } catch (err) {
    console.error('❌ Customer request-deletion error:', err);
    res.status(500).json({ error: 'Could not schedule account deletion.' });
  }
});

router.post('/customer/cancel-deletion', authMiddleware, customerOnly, async (req, res) => {
  try {
    const customerId = req.userId;
    if (!customerId || customerId === req.email) {
      return res.status(400).json({ error: 'Invalid user session' });
    }

    const result = await pool.query(`
      UPDATE customers
      SET deletion_scheduled_at = NULL,
          deletion_reason = NULL,
          updated_at = NOW()
      WHERE id = $1 AND deletion_scheduled_at IS NOT NULL
      RETURNING id
    `, [customerId]);

    if (result.rows.length === 0) {
      return res.json({ success: true, cancelled: false, message: 'No pending deletion to cancel.' });
    }

    console.log(`♻️ Customer #${customerId} deletion cancelled on request.`);
    res.json({ success: true, cancelled: true, message: 'Your account is safe.' });
  } catch (err) {
    console.error('❌ Customer cancel-deletion error:', err);
    res.status(500).json({ error: 'Could not cancel account deletion.' });
  }
});

// ============================================================
//  SECTION 11.B — BUSINESS ACCOUNT DELETION
// ============================================================

router.post('/business/request-deletion', authMiddleware, businessAdminOnly, getBusinessIdFromToken, [
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
      'SELECT id, password, business_id FROM admin_users WHERE id = $1',
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

    clearAuthCookie(res);

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
    res.status(500).json({ error: 'Could not schedule business deletion.' });
  }
});

router.post('/business/cancel-deletion', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
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
      return res.json({ success: true, cancelled: false, message: 'No pending deletion to cancel.' });
    }

    console.log(`♻️ Business #${businessId} deletion cancelled on request.`);
    res.json({ success: true, cancelled: true, message: 'Your business is safe.' });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Business cancel-deletion error:', err);
    res.status(500).json({ error: 'Could not cancel business deletion.' });
  }
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
//  PASSWORD RESET
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