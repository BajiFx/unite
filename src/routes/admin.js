// ============================================================
//  ADMIN ROUTES - SUPER ADMIN COMPLETE VERSION
//  Location: src/routes/admin.js
//
//  B.6 — Platform admin can list, create, approve, reject, update,
//        and delete product categories.
//
//  F.4 — Platform admin can also list, create, update, deactivate,
//        and delete business categories.
//
//  Section 11 — Platform admin can see, suspend, activate, and
//        hard-delete customers and businesses.
//
//  Violations & Claims (this revision):
//   New endpoints under /api/admin/violations so the super admin
//   can record, list, filter, review, action, and delete
//   violations and claims. Each action writes to admin_logs.
//
//   GET    /api/admin/violations                 — list with filters
//   GET    /api/admin/violations/for/:type/:id   — violations for one subject
//   GET    /api/admin/violations/:id             — one violation
//   POST   /api/admin/violations                 — record a new violation
//   PUT    /api/admin/violations/:id             — update status / action
//   DELETE /api/admin/violations/:id             — hard-delete (admin only)
//
//  Complaints Inbox (this revision):
//   New endpoints under /api/admin/messages so the super admin
//   can read and reply to complaints from customers and
//   businesses, and escalate a complaint into a violation.
//
//   GET    /api/admin/messages                   — list with filters
//   GET    /api/admin/messages/counts            — unread badge
//   GET    /api/admin/messages/:id               — one message
//   PUT    /api/admin/messages/:id/read          — mark as read
//   POST   /api/admin/messages/:id/reply         — reply + close
//   POST   /api/admin/messages/:id/escalate      — convert to violation
//   PUT    /api/admin/messages/:id/close         — close without reply
//   DELETE /api/admin/messages/:id               — hard-delete
//
//  Dashboard (this revision):
//   /dashboard now returns the compact top-row stats, the
//   attention row, and the badge counts for the collapsible
//   sections in a single response.
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { authMiddleware, adminOnly, businessAdminOnly, getBusinessIdFromToken } = require('../middleware/auth');
const { appendOrderStatus, restockOrder, logAdminActivity } = require('../services/orderService');
const Customer = require('../models/Customer');
const router = express.Router();

// ============================================================
//  Ensure customers.is_active exists.
// ============================================================
async function ensureCustomersActiveColumn() {
  try {
    await pool.query(`
      ALTER TABLE customers
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
    `);
  } catch (err) {
    console.warn('⚠️ Could not ensure customers.is_active:', err.message);
  }
}
ensureCustomersActiveColumn();

// ============================================================
//  Ensure business_categories.is_active exists.
// ============================================================
async function ensureBusinessCategoryActiveColumn() {
  try {
    await pool.query(`
      ALTER TABLE business_categories
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
    `);
  } catch (err) {
    console.warn('⚠️ Could not ensure business_categories.is_active:', err.message);
  }
}
ensureBusinessCategoryActiveColumn();

// ============================================================
//  ADMIN DASHBOARD STATS (Platform-wide)
//
//  Returns three blocks:
//    top       — the six compact cards
//    attention — the five attention cards
//    badges    — the counters for the collapsible sections
//
//  The old fields (pending, confirmed, shipped, etc.) are still
//  returned for backward compatibility, but the frontend no
//  longer relies on them.
// ============================================================

router.get('/dashboard', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('📊 Fetching super admin dashboard stats...');

    // ---------- Top row: 6 compact cards ----------
    const businessesActive = await pool.query(
      'SELECT COUNT(*) FROM businesses WHERE is_active = true'
    );
    const customersActive = await pool.query(
      'SELECT COUNT(*) FROM customers WHERE COALESCE(is_active, TRUE) = TRUE'
    );
    const productsActive = await pool.query(
      'SELECT COUNT(*) FROM products WHERE is_active = true'
    );
    const ordersThisMonth = await pool.query(
      `SELECT COUNT(*) FROM orders
        WHERE created_at >= date_trunc('month', NOW())`
    );
    const revenueThisMonth = await pool.query(
      `SELECT COALESCE(SUM(total), 0) FROM orders
        WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')
          AND created_at >= date_trunc('month', NOW())`
    );
    const pendingViolations = await pool.query(
      `SELECT COUNT(*) FROM violations
        WHERE status IN ('pending', 'under_review')`
    );

    const top = {
      businesses_active: parseInt(businessesActive.rows[0].count, 10),
      customers_active: parseInt(customersActive.rows[0].count, 10),
      products_active: parseInt(productsActive.rows[0].count, 10),
      orders_this_month: parseInt(ordersThisMonth.rows[0].count, 10),
      revenue_this_month: parseFloat(revenueThisMonth.rows[0].sum) || 0,
      pending_violations: parseInt(pendingViolations.rows[0].count, 10)
    };

    // ---------- Attention row: 5 cards ----------
    const pendingClaims = await pool.query(
      `SELECT COUNT(*) FROM violations
        WHERE kind = 'claim'
          AND status IN ('pending', 'under_review')`
    );
    const scheduledDeletions = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE deletion_scheduled_at IS NOT NULL)
       + (SELECT COUNT(*) FROM businesses WHERE deletion_scheduled_at IS NOT NULL)`
    );
    const pendingCategoryRequests = await pool.query(
      `SELECT COUNT(*) FROM product_categories
        WHERE is_requested = true AND is_active = false`
    );
    const pendingReturns = await pool.query(
      `SELECT COUNT(*) FROM returns WHERE status = 'pending'`
    );
    const failedPayments = await pool.query(
      `SELECT COUNT(*) FROM payments
        WHERE status = 'failed'
          AND created_at >= NOW() - INTERVAL '7 days'`
    );

    const attention = {
      pending_claims: parseInt(pendingClaims.rows[0].count, 10),
      scheduled_deletions: parseInt(scheduledDeletions.rows[0].count, 10),
      pending_category_requests: parseInt(pendingCategoryRequests.rows[0].count, 10),
      pending_returns: parseInt(pendingReturns.rows[0].count, 10),
      failed_payments_7d: parseInt(failedPayments.rows[0].count, 10)
    };

    // ---------- Badge counts ----------
    const unreadComplaints = await pool.query(
      `SELECT COUNT(*) FROM admin_messages WHERE status = 'unread'`
    );
    const totalCustomers = await pool.query('SELECT COUNT(*) FROM customers');
    const totalBusinesses = await pool.query('SELECT COUNT(*) FROM businesses');
    const totalViolations = await pool.query('SELECT COUNT(*) FROM violations');

    const badges = {
      unread_complaints: parseInt(unreadComplaints.rows[0].count, 10),
      total_customers: parseInt(totalCustomers.rows[0].count, 10),
      total_businesses: parseInt(totalBusinesses.rows[0].count, 10),
      total_violations: parseInt(totalViolations.rows[0].count, 10)
    };

    // ---------- Legacy fields (kept for backward compatibility) ----------
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment', 'completed'];
    const legacyStats = {};
    for (const status of statuses) {
      const result = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', [status]);
      legacyStats[status] = parseInt(result.rows[0].count, 10);
    }

    const replacementsPending = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE replacement_status IN ('pending', 'pending_payment', 'pending_refund')`
    );
    legacyStats.replacements_pending = parseInt(replacementsPending.rows[0].count, 10);

    const refundsPending = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE refund_status = 'pending'`
    );
    legacyStats.refunds_pending = parseInt(refundsPending.rows[0].count, 10);

    const urgent = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE urgent_delivery = true AND status NOT IN ('received', 'cancelled', 'completed')`
    );
    legacyStats.urgent = parseInt(urgent.rows[0].count, 10);

    const total = await pool.query('SELECT COUNT(*) FROM orders');
    legacyStats.total_orders = parseInt(total.rows[0].count, 10);

    const revenue = await pool.query(
      `SELECT COALESCE(SUM(total), 0) FROM orders
        WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')`
    );
    legacyStats.total_revenue = parseFloat(revenue.rows[0].sum) || 0;

    const returnsPending = await pool.query(
      `SELECT COUNT(*) FROM returns WHERE status = 'pending'`
    );
    legacyStats.returns_pending = parseInt(returnsPending.rows[0].count, 10);

    const totalBusinessesLegacy = await pool.query('SELECT COUNT(*) FROM businesses WHERE is_active = true');
    legacyStats.total_businesses = parseInt(totalBusinessesLegacy.rows[0].count, 10);

    const totalCustomersLegacy = await pool.query('SELECT COUNT(*) FROM customers');
    legacyStats.total_customers = parseInt(totalCustomersLegacy.rows[0].count, 10);

    const totalProductsLegacy = await pool.query('SELECT COUNT(*) FROM products WHERE is_active = true');
    legacyStats.total_products = parseInt(totalProductsLegacy.rows[0].count, 10);

    legacyStats.pending_product_categories = parseInt(pendingCategoryRequests.rows[0].count, 10);

    console.log('✅ Super admin dashboard stats fetched successfully');

    res.json({
      top,
      attention,
      badges,
      ...legacyStats
    });

  } catch (err) {
    console.error('❌ Dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET PLATFORM OVERVIEW
// ============================================================

router.get('/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const totalBusinesses = await pool.query('SELECT COUNT(*) FROM businesses WHERE is_active = true');
    const totalProducts = await pool.query('SELECT COUNT(*) FROM products WHERE is_active = true');
    const totalCustomers = await pool.query('SELECT COUNT(*) FROM customers');
    const totalOrders = await pool.query('SELECT COUNT(*) FROM orders');

    res.json({
      total_businesses: parseInt(totalBusinesses.rows[0].count, 10),
      total_products: parseInt(totalProducts.rows[0].count, 10),
      total_customers: parseInt(totalCustomers.rows[0].count, 10),
      total_orders: parseInt(totalOrders.rows[0].count, 10)
    });
  } catch (err) {
    console.error('❌ Overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET ALL BUSINESSES
// ============================================================

router.get('/businesses', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { search, status, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT b.*,
             a.email AS owner_email,
             (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
             (SELECT COUNT(*) FROM orders WHERE business_id = b.id) as order_count,
             (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue,
             (SELECT COUNT(*) FROM violations WHERE subject_type = 'business' AND subject_id = b.id AND status IN ('pending', 'under_review')) as pending_violations,
             (SELECT COUNT(*) FROM admin_messages WHERE sender_type = 'business' AND sender_id = b.id AND status = 'unread') as unread_messages
      FROM businesses b
      LEFT JOIN admin_users a ON b.owner_id = a.id
      WHERE 1=1
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(b.business_name ILIKE $${paramIndex} OR b.email ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status === 'active') {
      conditions.push(`b.is_active = true`);
    } else if (status === 'inactive') {
      conditions.push(`b.is_active = false`);
    } else if (status === 'verified') {
      conditions.push(`b.is_verified = true`);
    } else if (status === 'pending') {
      conditions.push(`b.is_verified = false AND b.is_active = true`);
    } else if (status === 'scheduled_deletion') {
      conditions.push(`b.deletion_scheduled_at IS NOT NULL`);
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += ' ORDER BY b.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get businesses error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE BUSINESS STATUS
// ============================================================

router.put('/businesses/:id/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const businessId = parseInt(req.params.id, 10);
    const { is_active, is_verified, is_featured } = req.body;

    const result = await pool.query(
      `UPDATE businesses
       SET is_active = COALESCE($1, is_active),
           is_verified = COALESCE($2, is_verified),
           is_featured = COALESCE($3, is_featured),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [is_active, is_verified, is_featured, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    await logAdminActivity(req.userId, 'UPDATE_BUSINESS_STATUS', {
      businessId,
      is_active,
      is_verified,
      is_featured
    });

    res.json({ success: true, business: result.rows[0] });
  } catch (err) {
    console.error('❌ Update business status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — list for super admin
// ============================================================

router.get('/product-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { is_active, is_requested, business_category_id } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (is_active !== undefined) {
      conditions.push(`pc.is_active = $${paramIndex}`);
      params.push(String(is_active) === 'true');
      paramIndex++;
    }
    if (is_requested !== undefined) {
      conditions.push(`pc.is_requested = $${paramIndex}`);
      params.push(String(is_requested) === 'true');
      paramIndex++;
    }
    if (business_category_id) {
      conditions.push(`pc.business_category_id = $${paramIndex}`);
      params.push(parseInt(business_category_id, 10));
      paramIndex++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        pc.*,
        bc.name AS business_category_name,
        bc.slug AS business_category_slug,
        b.business_name AS requested_by_business_name,
        b.slug AS requested_by_business_slug,
        (SELECT COUNT(*)::int FROM products WHERE product_category_id = pc.id) AS product_count
      FROM product_categories pc
      LEFT JOIN business_categories bc ON bc.id = pc.business_category_id
      LEFT JOIN businesses b ON b.id = pc.requested_by_business_id
      ${where}
      ORDER BY pc.is_requested DESC, pc.is_active ASC, bc.name NULLS FIRST, pc.name ASC
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get product categories error:', err);
    res.status(500).json({ error: 'Unable to load product categories' });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — create as platform admin
// ============================================================

router.post('/product-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, icon, description, business_category_id } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Product category name is required' });
    }

    const trimmedName = String(name).trim();
    const slugBase = trimmedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const slug = slugBase || `product-category-${Date.now()}`;

    const existing = await pool.query(
      'SELECT id FROM product_categories WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That product category already exists.' });
    }

    if (business_category_id) {
      const bc = await pool.query('SELECT id FROM business_categories WHERE id = $1', [business_category_id]);
      if (bc.rows.length === 0) {
        return res.status(400).json({ error: 'Selected business category does not exist' });
      }
    }

    const result = await pool.query(`
      INSERT INTO product_categories
        (name, slug, icon, description, business_category_id, is_active, is_requested)
      VALUES ($1, $2, $3, $4, $5, true, false)
      RETURNING *
    `, [trimmedName, slug, icon || null, description || null, business_category_id || null]);

    await logAdminActivity(req.userId, 'CREATE_PRODUCT_CATEGORY', {
      productCategoryId: result.rows[0].id,
      name: trimmedName
    });

    res.status(201).json({ success: true, product_category: result.rows[0] });
  } catch (err) {
    console.error('❌ Create product category error:', err);
    res.status(500).json({ error: 'Unable to create product category' });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — update as platform admin
// ============================================================

router.put('/product-categories/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product category ID' });

    const permitted = ['name', 'icon', 'description', 'business_category_id', 'is_active'];
    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of permitted) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(req.body[field]);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE product_categories SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product category not found' });
    }

    await logAdminActivity(req.userId, 'UPDATE_PRODUCT_CATEGORY', { productCategoryId: id });
    res.json({ success: true, product_category: result.rows[0] });
  } catch (err) {
    console.error('❌ Update product category error:', err);
    res.status(500).json({ error: 'Unable to update product category' });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — approve a business admin request
// ============================================================

router.post('/product-categories/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product category ID' });

    const result = await pool.query(`
      UPDATE product_categories
      SET is_active = true, is_requested = false, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product category not found' });
    }

    await logAdminActivity(req.userId, 'APPROVE_PRODUCT_CATEGORY', { productCategoryId: id });
    res.json({ success: true, product_category: result.rows[0] });
  } catch (err) {
    console.error('❌ Approve product category error:', err);
    res.status(500).json({ error: 'Unable to approve product category' });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — reject a business admin request
// ============================================================

router.post('/product-categories/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product category ID' });

    const inUse = await pool.query(
      'SELECT COUNT(*)::int AS count FROM products WHERE product_category_id = $1',
      [id]
    );
    if (inUse.rows[0].count > 0) {
      const result = await pool.query(`
        UPDATE product_categories
        SET is_active = false, is_requested = false, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Product category not found' });
      }
      await logAdminActivity(req.userId, 'REJECT_PRODUCT_CATEGORY_DEACTIVATED', { productCategoryId: id });
      return res.json({ success: true, deactivated: true, product_category: result.rows[0] });
    }

    const result = await pool.query(
      'DELETE FROM product_categories WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product category not found' });
    }

    await logAdminActivity(req.userId, 'REJECT_PRODUCT_CATEGORY', { productCategoryId: id });
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('❌ Reject product category error:', err);
    res.status(500).json({ error: 'Unable to reject product category' });
  }
});

// ============================================================
//  PRODUCT CATEGORIES — delete
// ============================================================

router.delete('/product-categories/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product category ID' });

    const inUse = await pool.query(
      'SELECT COUNT(*)::int AS count FROM products WHERE product_category_id = $1',
      [id]
    );
    if (inUse.rows[0].count > 0) {
      return res.status(400).json({
        error: `Cannot delete: ${inUse.rows[0].count} product(s) are still using this category.`
      });
    }

    const result = await pool.query(
      'DELETE FROM product_categories WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product category not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_PRODUCT_CATEGORY', { productCategoryId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete product category error:', err);
    res.status(500).json({ error: 'Unable to delete product category' });
  }
});

// ============================================================
//  BUSINESS CATEGORIES — list for super admin (F.4)
// ============================================================

router.get('/business-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { is_active } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (is_active !== undefined) {
      conditions.push(`bc.is_active = $${paramIndex}`);
      params.push(String(is_active) === 'true');
      paramIndex++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(`
      SELECT
        bc.id,
        bc.name,
        bc.slug,
        bc.icon,
        bc.description,
        bc.created_at,
        bc.is_active,
        (SELECT COUNT(*)::int
           FROM business_category_assignments bca
           JOIN businesses b ON b.id = bca.business_id
          WHERE bca.category_id = bc.id AND b.is_active = true) AS business_count,
        (SELECT COUNT(*)::int
           FROM product_categories pc
          WHERE pc.business_category_id = bc.id) AS product_category_count
      FROM business_categories bc
      ${where}
      ORDER BY bc.is_active DESC, bc.name ASC
    `, params);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get business categories error:', err);
    res.status(500).json({ error: 'Unable to load business categories' });
  }
});

// ============================================================
//  BUSINESS CATEGORIES — create (F.4)
// ============================================================

router.post('/business-categories', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name, icon, description } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Business category name is required' });
    }

    const trimmedName = String(name).trim();
    const slugBase = trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const slug = slugBase || `business-category-${Date.now()}`;

    const existing = await pool.query(
      'SELECT id FROM business_categories WHERE LOWER(name) = LOWER($1)',
      [trimmedName]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That business category already exists.' });
    }

    const result = await pool.query(`
      INSERT INTO business_categories (name, slug, icon, description, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING *
    `, [trimmedName, slug, icon || null, description || null]);

    await logAdminActivity(req.userId, 'CREATE_BUSINESS_CATEGORY', {
      businessCategoryId: result.rows[0].id,
      name: trimmedName
    });

    res.status(201).json({ success: true, business_category: result.rows[0] });
  } catch (err) {
    console.error('❌ Create business category error:', err);
    res.status(500).json({ error: 'Unable to create business category' });
  }
});

// ============================================================
//  BUSINESS CATEGORIES — update (F.4)
// ============================================================

router.put('/business-categories/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid business category ID' });
    }

    const permitted = ['name', 'icon', 'description', 'is_active'];
    const updates = [];
    const values = [];
    let paramIndex = 1;

    for (const field of permitted) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(req.body[field]);
        paramIndex++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE business_categories SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business category not found' });
    }

    await logAdminActivity(req.userId, 'UPDATE_BUSINESS_CATEGORY', { businessCategoryId: id });
    res.json({ success: true, business_category: result.rows[0] });
  } catch (err) {
    console.error('❌ Update business category error:', err);
    res.status(500).json({ error: 'Unable to update business category' });
  }
});

// ============================================================
//  BUSINESS CATEGORIES — delete (F.4, Q3)
// ============================================================

router.delete('/business-categories/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid business category ID' });
    }

    const exists = await pool.query('SELECT id, name FROM business_categories WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: 'Business category not found' });
    }

    const inUse = await pool.query(
      'SELECT COUNT(*)::int AS count FROM business_category_assignments WHERE category_id = $1',
      [id]
    );

    if (inUse.rows[0].count > 0) {
      const result = await pool.query(
        'UPDATE business_categories SET is_active = false WHERE id = $1 RETURNING *',
        [id]
      );
      await logAdminActivity(req.userId, 'DEACTIVATE_BUSINESS_CATEGORY', {
        businessCategoryId: id,
        assigned_businesses: inUse.rows[0].count
      });
      return res.json({
        success: true,
        deactivated: true,
        business_category: result.rows[0],
        message: `Category is used by ${inUse.rows[0].count} business(es); deactivated instead of deleted.`
      });
    }

    const result = await pool.query(
      'DELETE FROM business_categories WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business category not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_BUSINESS_CATEGORY', { businessCategoryId: id });
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('❌ Delete business category error:', err);
    res.status(500).json({ error: 'Unable to delete business category' });
  }
});

// ============================================================
//  VIOLATIONS & CLAIMS
// ============================================================

// ------------------------------------------------------------
//  LIST with filters
//    ?kind=violation|claim
//    ?subject_type=customer|business
//    ?status=pending|under_review|resolved|dismissed|escalated
//    ?severity=low|medium|high|critical
//    ?search=<text in title/description/subject_label>
//    ?limit=50&offset=0
// ------------------------------------------------------------
router.get('/violations', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      kind,
      subject_type,
      status,
      severity,
      search,
      limit = 50,
      offset = 0
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (kind) {
      conditions.push(`kind = $${paramIndex}`);
      params.push(kind);
      paramIndex++;
    }
    if (subject_type) {
      conditions.push(`subject_type = $${paramIndex}`);
      params.push(subject_type);
      paramIndex++;
    }
    if (status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    if (severity) {
      conditions.push(`severity = $${paramIndex}`);
      params.push(severity);
      paramIndex++;
    }
    if (search) {
      conditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR subject_label ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT *
      FROM violations
      ${where}
      ORDER BY
        CASE status
          WHEN 'pending' THEN 0
          WHEN 'under_review' THEN 1
          WHEN 'escalated' THEN 2
          WHEN 'resolved' THEN 3
          WHEN 'dismissed' THEN 4
          ELSE 5
        END,
        CASE severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(query, params);

    const countQuery = `SELECT COUNT(*)::int AS total FROM violations ${where}`;
    const countParams = params.slice(0, params.length - 2);
    const countResult = await pool.query(countQuery, countParams);
    const total = countResult.rows[0].total;

    res.json({
      violations: result.rows,
      total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (err) {
    console.error('❌ List violations error:', err);
    res.status(500).json({ error: 'Unable to load violations' });
  }
});

// ------------------------------------------------------------
//  LIST violations for one subject
// ------------------------------------------------------------
router.get('/violations/for/:type/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const type = req.params.type;
    const id = parseInt(req.params.id, 10);

    if (!['customer', 'business'].includes(type)) {
      return res.status(400).json({ error: 'Subject type must be customer or business' });
    }
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid subject id' });
    }

    const result = await pool.query(
      `SELECT *
         FROM violations
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY created_at DESC`,
      [type, id]
    );

    const summary = {
      total: result.rows.length,
      pending: result.rows.filter(v => v.status === 'pending' || v.status === 'under_review').length,
      resolved: result.rows.filter(v => v.status === 'resolved').length,
      dismissed: result.rows.filter(v => v.status === 'dismissed').length,
      escalations: result.rows.filter(v => v.status === 'escalated').length
    };

    res.json({ violations: result.rows, summary });
  } catch (err) {
    console.error('❌ List violations for subject error:', err);
    res.status(500).json({ error: 'Unable to load violations' });
  }
});

// ------------------------------------------------------------
//  GET one
// ------------------------------------------------------------
router.get('/violations/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid violation id' });
    }

    const result = await pool.query('SELECT * FROM violations WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' });
    }

    const row = result.rows[0];

    let subjectSnapshot = null;
    if (row.subject_type === 'customer') {
      const c = await pool.query(
        'SELECT id, name, email, phone, COALESCE(is_active, TRUE) AS is_active FROM customers WHERE id = $1',
        [row.subject_id]
      );
      subjectSnapshot = c.rows[0] || null;
    } else {
      const b = await pool.query(
        'SELECT id, business_name, slug, email, phone, is_active FROM businesses WHERE id = $1',
        [row.subject_id]
      );
      subjectSnapshot = b.rows[0] || null;
    }

    res.json({ violation: row, subject: subjectSnapshot });
  } catch (err) {
    console.error('❌ Get violation error:', err);
    res.status(500).json({ error: 'Unable to load violation' });
  }
});

// ------------------------------------------------------------
//  CREATE
// ------------------------------------------------------------
router.post('/violations', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      kind = 'violation',
      subject_type,
      subject_id,
      subject_label = null,
      reported_by_type = 'admin',
      reported_by_id = null,
      reporter_label = null,
      category = null,
      title,
      description = null,
      evidence_url = null,
      related_order_id = null,
      related_business_id = null,
      severity = 'medium',
      source_complaint_id = null
    } = req.body;

    if (!['violation', 'claim'].includes(kind)) {
      return res.status(400).json({ error: 'Invalid kind' });
    }
    if (!['customer', 'business'].includes(subject_type)) {
      return res.status(400).json({ error: 'Invalid subject type' });
    }
    if (!Number.isInteger(parseInt(subject_id, 10))) {
      return res.status(400).json({ error: 'Invalid subject id' });
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    const result = await pool.query(`
      INSERT INTO violations (
        kind, subject_type, subject_id, subject_label,
        reported_by_type, reported_by_id, reporter_label,
        category, title, description, evidence_url,
        related_order_id, related_business_id,
        severity, status, action_taken,
        source_complaint_id
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, 'pending', 'none',
        $15
      )
      RETURNING *
    `, [
      kind,
      subject_type,
      parseInt(subject_id, 10),
      subject_label,
      reported_by_type,
      reported_by_id,
      reporter_label,
      category,
      String(title).trim().slice(0, 255),
      description,
      evidence_url,
      related_order_id,
      related_business_id,
      severity,
      source_complaint_id
    ]);

    const row = result.rows[0];

    if (source_complaint_id) {
      await pool.query(
        `UPDATE admin_messages
            SET status = 'escalated',
                escalated_to_violation_id = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [row.id, source_complaint_id]
      );
    }

    await logAdminActivity(req.userId, 'CREATE_VIOLATION', {
      violationId: row.id,
      kind,
      subject_type,
      subject_id,
      severity
    });

    res.status(201).json({ success: true, violation: row });
  } catch (err) {
    console.error('❌ Create violation error:', err);
    res.status(500).json({ error: 'Unable to record violation' });
  }
});

// ------------------------------------------------------------
//  UPDATE status / action
//  Body: { status?, action_taken?, action_note?, severity? }
// ------------------------------------------------------------
router.put('/violations/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid violation id' });
    }

    const { status, action_taken, action_note, severity } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (status !== undefined) {
      if (!['pending', 'under_review', 'resolved', 'dismissed', 'escalated'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updates.push(`status = $${paramIndex}`);
      values.push(status);
      paramIndex++;
    }

    if (action_taken !== undefined) {
      if (!['none', 'warned', 'suspended', 'scheduled_deletion', 'deleted', 'restored'].includes(action_taken)) {
        return res.status(400).json({ error: 'Invalid action_taken' });
      }
      updates.push(`action_taken = $${paramIndex}`);
      values.push(action_taken);
      paramIndex++;
    }

    if (action_note !== undefined) {
      updates.push(`action_note = $${paramIndex}`);
      values.push(action_note);
      paramIndex++;
    }

    if (severity !== undefined) {
      if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity' });
      }
      updates.push(`severity = $${paramIndex}`);
      values.push(severity);
      paramIndex++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    if (status === 'resolved' || status === 'dismissed') {
      updates.push(`resolved_by_admin_id = $${paramIndex}`);
      values.push(req.userId);
      paramIndex++;
      updates.push(`resolved_at = NOW()`);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE violations
          SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $${paramIndex}
        RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' });
    }

    await logAdminActivity(req.userId, 'UPDATE_VIOLATION', {
      violationId: id,
      status,
      action_taken
    });

    res.json({ success: true, violation: result.rows[0] });
  } catch (err) {
    console.error('❌ Update violation error:', err);
    res.status(500).json({ error: 'Unable to update violation' });
  }
});

// ------------------------------------------------------------
//  DELETE
// ------------------------------------------------------------
router.delete('/violations/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid violation id' });
    }

    const result = await pool.query(
      'DELETE FROM violations WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_VIOLATION', { violationId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete violation error:', err);
    res.status(500).json({ error: 'Unable to delete violation' });
  }
});

// ============================================================
//  COMPLAINTS INBOX (admin_messages)
// ============================================================

// ------------------------------------------------------------
//  COUNTS (badge)
// ------------------------------------------------------------
router.get('/messages/counts', authMiddleware, adminOnly, async (req, res) => {
  try {
    const unread = await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_messages WHERE status = 'unread'`
    );
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_messages WHERE status IN ('unread', 'read')`
    );
    const replied = await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_messages WHERE status = 'replied'`
    );
    const escalated = await pool.query(
      `SELECT COUNT(*)::int AS n FROM admin_messages WHERE status = 'escalated'`
    );

    res.json({
      unread: unread.rows[0].n,
      pending: pending.rows[0].n,
      replied: replied.rows[0].n,
      escalated: escalated.rows[0].n
    });
  } catch (err) {
    console.error('❌ Message counts error:', err);
    res.status(500).json({ error: 'Unable to load message counts' });
  }
});

// ------------------------------------------------------------
//  LIST
//    ?status=unread|read|replied|escalated|closed
//    ?sender_type=customer|business
//    ?search=<text in subject/body/sender_label>
// ------------------------------------------------------------
router.get('/messages', authMiddleware, adminOnly, async (req, res) => {
  try {
    const {
      status,
      sender_type,
      search,
      limit = 50,
      offset = 0
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }
    if (sender_type) {
      conditions.push(`sender_type = $${paramIndex}`);
      params.push(sender_type);
      paramIndex++;
    }
    if (search) {
      conditions.push(`(subject ILIKE $${paramIndex} OR body ILIKE $${paramIndex} OR sender_label ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const query = `
      SELECT *
      FROM admin_messages
      ${where}
      ORDER BY
        CASE status
          WHEN 'unread' THEN 0
          WHEN 'read' THEN 1
          WHEN 'escalated' THEN 2
          WHEN 'replied' THEN 3
          WHEN 'closed' THEN 4
          ELSE 5
        END,
        created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(query, params);

    const countQuery = `SELECT COUNT(*)::int AS total FROM admin_messages ${where}`;
    const countParams = params.slice(0, params.length - 2);
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      messages: result.rows,
      total: countResult.rows[0].total,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });
  } catch (err) {
    console.error('❌ List messages error:', err);
    res.status(500).json({ error: 'Unable to load messages' });
  }
});

// ------------------------------------------------------------
//  GET one
// ------------------------------------------------------------
router.get('/messages/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const result = await pool.query('SELECT * FROM admin_messages WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Mark as read on open (only if it is currently unread).
    if (result.rows[0].status === 'unread') {
      await pool.query(
        `UPDATE admin_messages SET status = 'read', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      result.rows[0].status = 'read';
    }

    const row = result.rows[0];

    let senderSnapshot = null;
    if (row.sender_type === 'customer') {
      const c = await pool.query(
        'SELECT id, name, email, phone, COALESCE(is_active, TRUE) AS is_active FROM customers WHERE id = $1',
        [row.sender_id]
      );
      senderSnapshot = c.rows[0] || null;
    } else {
      const b = await pool.query(
        'SELECT id, business_name, slug, email, phone, is_active FROM businesses WHERE id = $1',
        [row.sender_id]
      );
      senderSnapshot = b.rows[0] || null;
    }

    let relatedOrder = null;
    if (row.related_order_id) {
      const o = await pool.query(
        'SELECT id, order_ref, status, total, created_at FROM orders WHERE id = $1',
        [row.related_order_id]
      );
      relatedOrder = o.rows[0] || null;
    }

    let relatedBusiness = null;
    if (row.related_business_id) {
      const b = await pool.query(
        'SELECT id, business_name, slug FROM businesses WHERE id = $1',
        [row.related_business_id]
      );
      relatedBusiness = b.rows[0] || null;
    }

    res.json({
      message: row,
      sender: senderSnapshot,
      related_order: relatedOrder,
      related_business: relatedBusiness
    });
  } catch (err) {
    console.error('❌ Get message error:', err);
    res.status(500).json({ error: 'Unable to load message' });
  }
});

// ------------------------------------------------------------
//  MARK AS READ
// ------------------------------------------------------------
router.put('/messages/:id/read', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const result = await pool.query(
      `UPDATE admin_messages
          SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('❌ Mark read error:', err);
    res.status(500).json({ error: 'Unable to mark message as read' });
  }
});

// ------------------------------------------------------------
//  REPLY
//  Body: { reply: string }
// ------------------------------------------------------------
router.post('/messages/:id/reply', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const reply = String(req.body.reply || '').trim();
    if (!reply) {
      return res.status(400).json({ error: 'Reply is required' });
    }

    const result = await pool.query(
      `UPDATE admin_messages
          SET admin_reply = $1,
              replied_by_admin_id = $2,
              replied_at = NOW(),
              status = 'replied',
              updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [reply.slice(0, 5000), req.userId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await logAdminActivity(req.userId, 'REPLY_ADMIN_MESSAGE', { messageId: id });

    const io = req.app.get('io');
    if (io) io.emit('admin-message-updated', { id, status: 'replied' });

    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('❌ Reply message error:', err);
    res.status(500).json({ error: 'Unable to send reply' });
  }
});

// ------------------------------------------------------------
//  ESCALATE to violation
//  Body: { subject_type, subject_id, severity?, category? }
// ------------------------------------------------------------
router.post('/messages/:id/escalate', authMiddleware, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const {
      subject_type,
      subject_id,
      severity = 'medium',
      category = null
    } = req.body;

    if (!['customer', 'business'].includes(subject_type)) {
      return res.status(400).json({ error: 'Invalid subject type' });
    }
    if (!Number.isInteger(parseInt(subject_id, 10))) {
      return res.status(400).json({ error: 'Invalid subject id' });
    }
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
      return res.status(400).json({ error: 'Invalid severity' });
    }

    await client.query('BEGIN');

    const msgResult = await client.query(
      'SELECT * FROM admin_messages WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (msgResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Message not found' });
    }
    const msg = msgResult.rows[0];

    if (msg.escalated_to_violation_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This message has already been escalated.' });
    }

    const insertResult = await client.query(`
      INSERT INTO violations (
        kind, subject_type, subject_id, subject_label,
        reported_by_type, reported_by_id, reporter_label,
        category, title, description, evidence_url,
        related_order_id, related_business_id,
        severity, status, action_taken,
        source_complaint_id
      )
      VALUES (
        'claim', $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, 'pending', 'none',
        $14
      )
      RETURNING *
    `, [
      subject_type,
      parseInt(subject_id, 10),
      null,
      msg.sender_type,
      msg.sender_id,
      msg.sender_label,
      category || msg.category,
      String(msg.subject || '').slice(0, 255) || 'Escalated complaint',
      msg.body,
      msg.attachment_url,
      msg.related_order_id,
      msg.related_business_id,
      severity,
      msg.id
    ]);

    await client.query(
      `UPDATE admin_messages
          SET status = 'escalated',
              escalated_to_violation_id = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [insertResult.rows[0].id, id]
    );

    await client.query('COMMIT');

    await logAdminActivity(req.userId, 'ESCALATE_ADMIN_MESSAGE', {
      messageId: id,
      violationId: insertResult.rows[0].id,
      severity
    });

    const io = req.app.get('io');
    if (io) io.emit('admin-message-updated', { id, status: 'escalated' });

    res.json({ success: true, violation: insertResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Escalate message error:', err);
    res.status(500).json({ error: 'Unable to escalate message' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
//  CLOSE without reply
// ------------------------------------------------------------
router.put('/messages/:id/close', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const result = await pool.query(
      `UPDATE admin_messages
          SET status = 'closed', updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await logAdminActivity(req.userId, 'CLOSE_ADMIN_MESSAGE', { messageId: id });
    res.json({ success: true, message: result.rows[0] });
  } catch (err) {
    console.error('❌ Close message error:', err);
    res.status(500).json({ error: 'Unable to close message' });
  }
});

// ------------------------------------------------------------
//  DELETE
// ------------------------------------------------------------
router.delete('/messages/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const result = await pool.query(
      'DELETE FROM admin_messages WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_ADMIN_MESSAGE', { messageId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete message error:', err);
    res.status(500).json({ error: 'Unable to delete message' });
  }
});

// ============================================================
//  ADMIN - GET RECENT ORDERS (Platform-wide)
// ============================================================

router.get('/recent-orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;

    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      ORDER BY o.created_at DESC
      LIMIT $1
    `, [limit]);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Recent orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET ALL ORDERS (with filtering)
// ============================================================

router.get('/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, search, business_id, startDate, endDate, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE 1=1
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      const virtualFilters = {
        replacements: `o.replacement_status IN ('pending', 'pending_payment', 'pending_refund')`,
        refunds: `o.refund_status = 'pending'`,
        urgent: `o.urgent_delivery = true AND o.status NOT IN ('received', 'cancelled', 'completed')`
      };
      if (virtualFilters[status]) {
        conditions.push(virtualFilters[status]);
      } else {
        conditions.push(`o.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }
    }

    if (search) {
      conditions.push(`(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR o.order_ref ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (business_id) {
      conditions.push(`o.business_id = $${paramIndex}`);
      params.push(parseInt(business_id, 10));
      paramIndex++;
    }

    if (startDate) {
      conditions.push(`o.created_at >= $${paramIndex}`);
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      conditions.push(`o.created_at <= $${paramIndex}`);
      params.push(`${endDate} 23:59:59`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += ' ORDER BY o.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CONFIRM ORDER
// ============================================================

router.put('/orders/:id/confirm', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);

    const orderResult = await pool.query(
      `SELECT o.*, c.name AS customer_name, c.email AS customer_email
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id = $1`,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already processed (status: ${order.status})` });
    }

    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed', 'Order confirmed by admin');
    await logAdminActivity(req.userId, 'CONFIRM_ORDER', { orderId });

    const ref = order.order_ref || `#${order.id}`;
    const message = `✅ **Order ${ref} Confirmed!**\n\nDear ${order.customer_name},\n\nYour order has been confirmed and is being prepared for shipping.\n\nThank you for shopping with us! 🙏`;

    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'Seller',
      message: message,
      timestamp: new Date()
    });
    io.emit('order-status-updated', { orderId });

    res.json({ success: true, message: '✅ Order confirmed.' });
  } catch (err) {
    console.error('❌ Confirm order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE ORDER STATUS
// ============================================================

router.put('/orders/:id/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { status, tracking_number } = req.body;

    const current = await pool.query('SELECT status, customer_id, order_ref FROM orders WHERE id = $1', [orderId]);

    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentStatus = current.rows[0].status;

    const validTransitions = {
      'pending': ['confirmed', 'cancelled'],
      'confirmed': ['shipped', 'cancelled'],
      'shipped': ['delivered', 'cancelled'],
      'delivered': ['received', 'cancelled'],
      'received': ['completed'],
      'pending_payment': ['pending', 'cancelled']
    };

    if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${currentStatus} to ${status}` });
    }

    const updates = { status };
    if (status === 'shipped') {
      updates.shipped_at = new Date();
      if (tracking_number) updates.tracking_number = tracking_number;
    } else if (status === 'delivered') {
      updates.delivered_at = new Date();
    } else if (status === 'received') {
      updates.received_at = new Date();
    } else if (status === 'completed') {
      updates.completed_at = new Date();
    }

    await pool.query(
      `UPDATE orders SET status = $1, shipped_at = $2, delivered_at = $3, received_at = $4, tracking_number = $5, completed_at = $6, updated_at = NOW() WHERE id = $7`,
      [
        updates.status,
        updates.shipped_at || null,
        updates.delivered_at || null,
        updates.received_at || null,
        updates.tracking_number || null,
        updates.completed_at || null,
        orderId
      ]
    );

    await appendOrderStatus(orderId, status, `Status updated by admin`);
    await logAdminActivity(req.userId, `UPDATE_ORDER_TO_${status.toUpperCase()}`, { orderId });

    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const message = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;

    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'Seller',
      message: message,
      timestamp: new Date()
    });
    io.emit('order-status-updated', { orderId });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - BULK UPDATE ORDER STATUS
// ============================================================

router.put('/orders/bulk-status', authMiddleware, adminOnly, async (req, res) => {
  const { orderIds, status } = req.body;
  const allowedStatuses = ['confirmed', 'shipped', 'delivered', 'received', 'cancelled'];
  if (!Array.isArray(orderIds) || orderIds.length === 0 || !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Order IDs and a valid status are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orders = await client.query('SELECT id, status FROM orders WHERE id = ANY($1::int[]) FOR UPDATE', [orderIds.map(Number)]);
    const transitions = {
      pending: ['confirmed', 'cancelled'],
      pending_payment: ['confirmed', 'cancelled'],
      confirmed: ['shipped', 'cancelled'],
      shipped: ['delivered', 'cancelled'],
      delivered: ['received', 'cancelled']
    };
    const invalid = orders.rows.filter(order => !(transitions[order.status] || []).includes(status));
    if (invalid.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Some orders cannot transition to ${status}.` });
    }
    const timestamps = {
      shipped: 'shipped_at', delivered: 'delivered_at', received: 'received_at'
    };
    const timestampColumn = timestamps[status];
    const setTimestamp = timestampColumn ? `, ${timestampColumn} = NOW()` : '';
    await client.query(`UPDATE orders SET status = $1, updated_at = NOW()${setTimestamp} WHERE id = ANY($2::int[])`, [status, orderIds.map(Number)]);
    await client.query('COMMIT');
    for (const order of orders.rows) await appendOrderStatus(order.id, status, 'Bulk status update by admin');
    const io = req.app.get('io');
    io.emit('order-status-updated', { orderIds, status });
    res.json({ success: true, updated: orders.rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Bulk status error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================
//  ADMIN - BULK DELETE CLOSED ORDERS
// ============================================================

router.delete('/orders/bulk', authMiddleware, adminOnly, async (req, res) => {
  const { orderIds } = req.body;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'Order IDs are required.' });
  }

  try {
    const result = await pool.query(
      `DELETE FROM orders WHERE id = ANY($1::int[]) AND status IN ('cancelled', 'completed') RETURNING id`,
      [orderIds.map(Number)]
    );
    await logAdminActivity(req.userId, 'BULK_DELETE_ORDERS', { orderIds: result.rows.map(row => row.id) });
    res.json({ success: true, deleted: result.rowCount });
  } catch (err) {
    console.error('❌ Bulk delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CANCEL ORDER
// ============================================================

router.put('/orders/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Cancellation reason required' });
    }

    const orderResult = await pool.query('SELECT status, order_ref FROM orders WHERE id = $1', [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.status === 'cancelled') {
      return res.status(400).json({ error: 'Order already cancelled' });
    }

    if (order.status === 'received' || order.status === 'completed') {
      return res.status(400).json({ error: 'Order cannot be cancelled' });
    }

    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'admin', updated_at = NOW() WHERE id = $1`,
      [orderId]
    );

    await appendOrderStatus(orderId, 'cancelled', `Cancelled by admin. Reason: ${reason}`);
    await restockOrder(orderId);
    await logAdminActivity(req.userId, 'CANCEL_ORDER', { orderId, reason });

    const ref = order.order_ref || `#${orderId}`;
    const message = `❌ Order ${ref} has been cancelled by admin. Reason: ${reason}`;

    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', message]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: message,
      timestamp: new Date()
    });
    io.emit('order-status-updated', { orderId });

    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    console.error('❌ Cancel order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - HANDLE REFUND
// ============================================================

router.put('/orders/:id/refund', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { action } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action.' });
    }

    const orderResult = await pool.query('SELECT refund_status, business_id FROM orders WHERE id = $1', [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (!['admin', 'super_admin', 'business_admin'].includes(req.role) ||
        (req.role === 'business_admin' && orderResult.rows[0].business_id !== req.businessId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (orderResult.rows[0].refund_status !== 'pending') {
      return res.status(400).json({ error: 'Refund not pending.' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await pool.query(`UPDATE orders SET refund_status = $1 WHERE id = $2`, [newStatus, orderId]);

    const msg = action === 'approve' ? '✅ Refund approved.' : '❌ Refund rejected.';
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', msg]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: msg,
      timestamp: new Date()
    });

    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_REFUND' : 'REJECT_REFUND', { orderId });
    res.json({ success: true, message: `Refund ${action}d.` });
  } catch (err) {
    console.error('❌ Refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - HANDLE REPLACEMENT
// ============================================================

router.put('/orders/:id/replace', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { action } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action.' });
    }

    const result = await pool.query(
      'SELECT replacement_status, order_ref, business_id FROM orders WHERE id = $1',
      [orderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (!['admin', 'super_admin', 'business_admin'].includes(req.role) ||
        (req.role === 'business_admin' && result.rows[0].business_id !== req.businessId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['pending', 'pending_payment', 'pending_refund'].includes(result.rows[0].replacement_status)) {
      return res.status(400).json({ error: 'Replacement is not pending.' });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    await pool.query('UPDATE orders SET replacement_status = $1, updated_at = NOW() WHERE id = $2', [status, orderId]);
    const message = action === 'approve' ? '✅ Replacement approved.' : '❌ Replacement rejected.';
    await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'System', message]
    );
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message, timestamp: new Date() });
    await logAdminActivity(req.userId, `${action.toUpperCase()}_REPLACEMENT`, { orderId });
    res.json({ success: true, message });
  } catch (err) {
    console.error('❌ Replacement error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - SEND DELIVERY REMINDER
// ============================================================

router.post('/orders/:id/remind', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const result = await pool.query(
      `SELECT o.order_ref, o.status, o.business_id, c.name, c.email
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
      [orderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (!['admin', 'super_admin', 'business_admin'].includes(req.role) ||
        (req.role === 'business_admin' && result.rows[0].business_id !== req.businessId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (result.rows[0].status !== 'delivered') return res.status(400).json({ error: 'Reminder is only available for delivered orders.' });

    const message = `📦 Reminder: Order ${result.rows[0].order_ref || `#${orderId}`} is awaiting your confirmation of receipt.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', message]);
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message, timestamp: new Date() });
    await logAdminActivity(req.userId, 'SEND_DELIVERY_REMINDER', { orderId });
    res.json({ success: true, message });
  } catch (err) {
    console.error('❌ Reminder error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET CUSTOMERS
//
//  Adds pending_violations and unread_messages so the
//  dashboard can warn before suspend.
// ============================================================

router.get('/customers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, email, phone, created_at,
        COALESCE(is_active, TRUE) AS is_active,
        (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent,
        (SELECT COUNT(*) FROM violations WHERE subject_type = 'customer' AND subject_id = customers.id AND status IN ('pending', 'under_review')) as pending_violations,
        (SELECT COUNT(*) FROM admin_messages WHERE sender_type = 'customer' AND sender_id = customers.id AND status = 'unread') as unread_messages,
        deletion_scheduled_at,
        deletion_reason
      FROM customers
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Customers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - SUSPEND / ACTIVATE A CUSTOMER
// ============================================================

router.put('/customers/:id/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!Number.isInteger(customerId)) {
      return res.status(400).json({ error: 'Invalid customer ID' });
    }

    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active (boolean) is required' });
    }

    const result = await pool.query(
      `UPDATE customers
         SET is_active = $1,
             updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, email, phone, is_active, updated_at`,
      [is_active, customerId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    await logAdminActivity(req.userId, is_active ? 'ACTIVATE_CUSTOMER' : 'SUSPEND_CUSTOMER', { customerId });

    res.json({ success: true, customer: result.rows[0] });
  } catch (err) {
    console.error('❌ Update customer status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - DELETE A CUSTOMER
// ============================================================

router.delete('/customers/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const customerId = parseInt(req.params.id, 10);
    if (!Number.isInteger(customerId)) {
      return res.status(400).json({ error: 'Invalid customer ID' });
    }

    const deleted = await Customer.delete(customerId);
    if (!deleted) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_CUSTOMER', { customerId });

    res.json({ success: true, deleted_id: customerId });
  } catch (err) {
    console.error('❌ Delete customer error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - DELETE A BUSINESS
// ============================================================

router.delete('/businesses/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const businessId = parseInt(req.params.id, 10);
    if (!Number.isInteger(businessId)) {
      return res.status(400).json({ error: 'Invalid business ID' });
    }

    const result = await pool.query(
      'DELETE FROM businesses WHERE id = $1 RETURNING id, business_name',
      [businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    await logAdminActivity(req.userId, 'DELETE_BUSINESS', {
      businessId,
      businessName: result.rows[0].business_name
    });

    res.json({ success: true, deleted_id: businessId });
  } catch (err) {
    console.error('❌ Delete business error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET PROMO CODES
// ============================================================

router.get('/promo-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Promo codes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - CREATE PROMO CODE
// ============================================================

router.post('/promo-codes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order_value, expires_at, usage_limit } = req.body;

    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'Code, type, and value are required' });
    }

    await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_value, expires_at, usage_limit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code.toUpperCase(), discount_type, discount_value, min_order_value || 0, expires_at || null, usage_limit || null]
    );

    await logAdminActivity(req.userId, 'CREATE_PROMO', { code });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Create promo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - DELETE PROMO CODE
// ============================================================

router.delete('/promo-codes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM promo_codes WHERE id = $1', [id]);
    await logAdminActivity(req.userId, 'DELETE_PROMO', { id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete promo error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET LOCATION REQUESTS
// ============================================================

router.get('/location-requests', authMiddleware, adminOnly, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - APPROVE LOCATION REQUEST
// ============================================================

router.post('/location-requests/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['approved', id]);

    const result = await pool.query('SELECT customer_id FROM location_requests WHERE id = $1', [id]);
    const customerId = result.rows[0]?.customer_id;

    if (customerId) {
      const io = req.app.get('io');
      io.to(`customer_${customerId}`).emit('location_request_approved');
    }

    await logAdminActivity(req.userId, 'APPROVE_LOCATION', { requestId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Approve location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - REJECT LOCATION REQUEST
// ============================================================

router.post('/location-requests/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query('UPDATE location_requests SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);
    await logAdminActivity(req.userId, 'REJECT_LOCATION', { requestId: id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject location error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET ADMIN LOGS
// ============================================================

router.get('/logs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const result = await pool.query(
      `SELECT l.*, a.email AS admin_email, a.username AS admin_username
         FROM admin_logs l
         LEFT JOIN admin_users a ON a.id = l.admin_id
        ORDER BY l.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - EXPORT ORDERS CSV
// ============================================================

router.get('/orders/export', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.id, o.order_ref, o.created_at, o.status, o.total,
             c.name as customer_name, c.email as customer_email,
             b.business_name,
             o.delivery_address, o.recipient_name, o.recipient_phone
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      ORDER BY o.created_at DESC
    `);

    const rows = result.rows;

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No orders to export.' });
    }

    let csv = 'Order ID,Reference,Date,Status,Total,Customer,Email,Business,Delivery Address,Recipient,Phone\n';
    rows.forEach(row => {
      csv += `${row.id},${row.order_ref || 'N/A'},${new Date(row.created_at).toLocaleDateString()},${row.status},${row.total},${row.customer_name},${row.customer_email},${row.business_name || 'N/A'},${row.delivery_address || 'N/A'},${row.recipient_name || 'N/A'},${row.recipient_phone || 'N/A'}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=orders-${new Date().toISOString().slice(0,10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('❌ Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - GET RETURNS
// ============================================================

router.get('/returns', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, o.order_ref, c.name AS customer_name,
             b.business_name
      FROM returns r
      JOIN orders o ON r.order_id = o.id
      JOIN customers c ON r.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      ORDER BY r.requested_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Returns error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADMIN - UPDATE RETURN STATUS
// ============================================================

router.put('/returns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { action } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const approvedAt = action === 'approve' ? new Date() : null;

    await pool.query(
      `UPDATE returns SET status = $1, approved_at = $2 WHERE id = $3`,
      [newStatus, approvedAt, id]
    );

    await logAdminActivity(req.userId, action === 'approve' ? 'APPROVE_RETURN' : 'REJECT_RETURN', { returnId: id });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update return error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;