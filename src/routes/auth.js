// ============================================================
//  AUTH ROUTES - COMPLETE MULTI-VENDOR VERSION
//  WITH USERNAME SUPPORT & SMART LOGIN
//  Location: src/routes/auth.js
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
//  CHECK USERNAME AVAILABILITY
// ============================================================

router.get('/check-username', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username || username.length < 3) {
            return res.status(400).json({ error: 'Username must be at least 3 characters' });
        }

        // Check in customers table
        const customerResult = await pool.query(
            'SELECT id FROM customers WHERE username = $1',
            [username]
        );

        if (customerResult.rows.length > 0) {
            return res.json({ available: false, message: 'Username already taken' });
        }

        // Check in admin_users table (businesses)
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

    // Check if username already exists (in both customers and admin_users)
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

    // Check if input is email or username
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
//  BUSINESS REGISTRATION - WITH USERNAME
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
  body('username').isLength({ min: 3 }).withMessage('Username must be at least 3 characters')
], async (req, res) => {
  try {
    console.log('📝 Business registration request received');
    console.log('📝 Email:', req.body.email);
    console.log('📝 Username:', req.body.username);

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
      username
    } = req.body;

    const cleanPhone = phone.replace(/[^0-9]/g, '');

    // Validate required fields
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

    // Check if username already exists (in both customers and admin_users)
    const existingUsername = await pool.query(
      'SELECT id FROM customers WHERE username = $1 UNION SELECT id FROM admin_users WHERE username = $1',
      [username]
    );
    if (existingUsername.rows.length > 0) {
      return res.status(409).json({ error: 'Username already taken. Please choose another.' });
    }

    // Check existing admin
    const existingAdmin = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (existingAdmin.rows.length > 0) {
      console.log('❌ Email already registered:', email);
      return res.status(409).json({ error: 'Email already registered as admin.' });
    }

    // Generate unique slug
    let slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) slug = 'business-' + Date.now();
    const slugCheck = await pool.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
    if (slugCheck.rows.length > 0) {
      slug = `${slug}-${Date.now().toString().slice(-4)}`;
    }

    // Handle file uploads (optional)
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

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('✅ Password hashed');

    await pool.query('BEGIN');

    // 1. Create admin user with username
    const adminResult = await pool.query(
      `INSERT INTO admin_users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, email, hashedPassword, 'business_admin']
    );
    const adminId = adminResult.rows[0].id;
    console.log('✅ Admin user created:', adminId);

    // 2. Create business with all fields
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
        is_verified, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
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
      true, true
    ]);
    const businessId = businessResult.rows[0].id;
    console.log('✅ Business created:', businessId);

    // 3. Update admin with business_id
    await pool.query('UPDATE admin_users SET business_id = $1 WHERE id = $2', [businessId, adminId]);

    // 4. Create business stats
    await pool.query('INSERT INTO business_stats (business_id) VALUES ($1)', [businessId]);

    await pool.query('COMMIT');

    const businessData = await pool.query('SELECT * FROM businesses WHERE id = $1', [businessId]);
    const token = generateToken(email, 'business_admin', adminId);
    setAuthCookie(res, token);

    console.log('✅ Business registered successfully:', business_name);
    console.log('✅ Email:', email);
    console.log('✅ Username:', username);
    console.log('✅ Business ID:', businessId);

    res.status(201).json({
      success: true,
      role: 'business_admin',
      business_id: businessId,
      business: businessData.rows[0],
      slug: slug,
      message: 'Business registered successfully!'
    });

  } catch (err) {
    await pool.query('ROLLBACK');
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

    // Check if input is email or username
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
// ============================================================

router.get('/my-business', authMiddleware, async (req, res) => {
  try {
    console.log('📊 Fetching business for user...');
    console.log('📊 req.userId:', req.userId);
    console.log('📊 req.email:', req.email);
    console.log('📊 req.role:', req.role);

    let userId = req.userId;
    let email = req.email;

    // If userId is null but we have email, find user by email
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

    // Get user from database
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

    // If user is super admin or has no business
    if (user.role === 'super_admin') {
      console.log('ℹ️ Super admin - no business to return');
      return res.json({ business: null });
    }

    // If user is not a business admin
    if (user.role !== 'business_admin') {
      console.log('ℹ️ Not a business admin - role:', user.role);
      return res.json({ business: null });
    }

    // If user has no business_id
    if (!user.business_id) {
      console.log('ℹ️ User has no business_id');
      return res.json({ business: null });
    }

    // Get business data
    const businessResult = await pool.query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
        (SELECT COUNT(*) FROM orders WHERE business_id = b.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue
      FROM businesses b
      WHERE b.id = $1 AND b.is_active = true
    `, [user.business_id]);

    if (businessResult.rows.length === 0) {
      console.log('❌ Business not found for ID:', user.business_id);
      return res.json({ business: null });
    }

    console.log('✅ Business found:', businessResult.rows[0].business_name);
    res.json({ business: businessResult.rows[0], role: user.role });

  } catch (err) {
    console.error('❌ Get my business error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER VERIFY
// ============================================================

router.get('/customer/verify', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, username, email, phone, created_at FROM customers WHERE id = $1', [req.userId]);
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
  const { name, phone, email } = req.body;
  try {
    if (phone && !validateKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone number. Must be a valid Kenyan number.' });
    }
    const cleanPhone = phone ? phone.replace(/[^0-9]/g, '') : null;
    const result = await pool.query(
      'UPDATE customers SET name = COALESCE($1, name), phone = COALESCE($2, phone), email = COALESCE($3, email) WHERE id = $4 RETURNING id, name, username, email, phone',
      [name, cleanPhone, email, req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('❌ Profile update error:', err);
    res.status(500).json({ error: err.message });
  }
});

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

// Forgot password
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

    // Check admin first
    const adminResult = await pool.query('SELECT id, email FROM admin_users WHERE email = $1', [email]);
    if (adminResult.rows.length > 0) {
      user = adminResult.rows[0];
      userType = 'admin';
    } else {
      // Check customer
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

// Reset password
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