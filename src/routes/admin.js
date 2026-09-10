// ============================================================
//  ADMIN ROUTES - SUPER ADMIN COMPLETE VERSION
//  Location: src/routes/admin.js
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { authMiddleware, adminOnly, businessAdminOnly, getBusinessIdFromToken } = require('../middleware/auth');
const { appendOrderStatus, restockOrder, logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  ADMIN DASHBOARD STATS (Platform-wide)
// ============================================================

router.get('/dashboard', authMiddleware, adminOnly, async (req, res) => {
  try {
    console.log('📊 Fetching super admin dashboard stats...');

    // Platform-wide stats
    const statuses = ['pending', 'confirmed', 'shipped', 'delivered', 'received', 'cancelled', 'pending_payment', 'completed'];
    const stats = {};

    for (const status of statuses) {
      const result = await pool.query('SELECT COUNT(*) FROM orders WHERE status = $1', [status]);
      stats[status] = parseInt(result.rows[0].count);
    }

    const replacementsPending = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE replacement_status IN ('pending', 'pending_payment', 'pending_refund')`
    );
    stats.replacements_pending = parseInt(replacementsPending.rows[0].count);

    const refundsPending = await pool.query(`SELECT COUNT(*) FROM orders WHERE refund_status = 'pending'`);
    stats.refunds_pending = parseInt(refundsPending.rows[0].count);

    const urgent = await pool.query(
      `SELECT COUNT(*) FROM orders WHERE urgent_delivery = true AND status NOT IN ('received', 'cancelled', 'completed')`
    );
    stats.urgent = parseInt(urgent.rows[0].count);

    const total = await pool.query('SELECT COUNT(*) FROM orders');
    stats.total_orders = parseInt(total.rows[0].count);

    const revenue = await pool.query(
      `SELECT COALESCE(SUM(total), 0) FROM orders WHERE status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')`
    );
    stats.total_revenue = parseFloat(revenue.rows[0].sum) || 0;

    const returnsPending = await pool.query(`SELECT COUNT(*) FROM returns WHERE status = 'pending'`);
    stats.returns_pending = parseInt(returnsPending.rows[0].count);

    // Business stats
    const totalBusinesses = await pool.query('SELECT COUNT(*) FROM businesses WHERE is_active = true');
    stats.total_businesses = parseInt(totalBusinesses.rows[0].count);

    const totalCustomers = await pool.query('SELECT COUNT(*) FROM customers');
    stats.total_customers = parseInt(totalCustomers.rows[0].count);

    const totalProducts = await pool.query('SELECT COUNT(*) FROM products WHERE is_active = true');
    stats.total_products = parseInt(totalProducts.rows[0].count);

    console.log('✅ Super admin dashboard stats fetched successfully');
    res.json(stats);

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
      total_businesses: parseInt(totalBusinesses.rows[0].count),
      total_products: parseInt(totalProducts.rows[0].count),
      total_customers: parseInt(totalCustomers.rows[0].count),
      total_orders: parseInt(totalOrders.rows[0].count)
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
             (SELECT COALESCE(SUM(total), 0) FROM orders WHERE business_id = b.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_revenue
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
    }

    if (conditions.length > 0) {
      query += ' AND ' + conditions.join(' AND ');
    }

    query += ' ORDER BY b.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

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
    const businessId = parseInt(req.params.id);
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
//  ADMIN - GET RECENT ORDERS (Platform-wide)
// ============================================================

router.get('/recent-orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

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
      params.push(parseInt(business_id));
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
    params.push(parseInt(limit), parseInt(offset));

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
    const orderId = parseInt(req.params.id);

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
    const orderId = parseInt(req.params.id);
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
    const orderId = parseInt(req.params.id);
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
    const orderId = parseInt(req.params.id);
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
    const orderId = parseInt(req.params.id);
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
    const orderId = parseInt(req.params.id);
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
// ============================================================

router.get('/customers', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, email, phone, created_at,
        (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
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
    const id = parseInt(req.params.id);
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
    const id = parseInt(req.params.id);

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
    const id = parseInt(req.params.id);
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
    const result = await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100'
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
    const id = parseInt(req.params.id);
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