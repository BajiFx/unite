// ============================================================
//  ORDERS ROUTES - Complete with Delivery Recording & Business Support
//  Location: src/routes/orders.js
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware, customerOnly, businessAdminOnly, adminOnly, checkBusinessActive } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { generateOrderRef, calculateShippingCost } = require('../utils/helpers');
const Business = require('../models/Business');
const { sendEmail, orderConfirmationEmail, statusUpdateEmail, receivedEmail } = require('../services/email');
const {
  appendOrderStatus,
  decrementStockAtomic,
  restockOrder,
  getSystemSetting,
  logAdminActivity
} = require('../services/orderService');
const Order = require('../models/Order');
const PDFDocument = require('pdfkit');
const router = express.Router();

// ============================================================
//  SEND ORDER CONFIRMATION MESSAGE
// ============================================================

router.post('/:id/send-confirmation', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, b.business_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN businesses b ON b.id = o.business_id
      WHERE o.id = $1
    `, [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = result.rows[0];
    if (req.role === 'business_admin' && order.business_id !== req.businessId) return res.status(403).json({ error: 'Forbidden' });
    if (!['admin', 'super_admin', 'business_admin'].includes(req.role)) return res.status(403).json({ error: 'Admin access required' });

    const message = `✅ Order ${order.order_ref || `#${order.id}`} has been confirmed by ${order.business_name || 'the shop'}.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'Seller', message]);
    await appendOrderStatus(orderId, order.status, 'Confirmation message sent to customer');
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message, timestamp: new Date() });
    res.json({ success: true, message });
  } catch (err) {
    console.error('❌ Send confirmation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CUSTOMER ORDER RECEIPT PDF
// ============================================================

router.get('/:id/receipt', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email, b.business_name
      FROM orders o JOIN customers c ON c.id = o.customer_id
      LEFT JOIN businesses b ON b.id = o.business_id WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    if (req.role === 'customer' && order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (req.role === 'business_admin' && order.business_id !== req.businessId) return res.status(403).json({ error: 'Forbidden' });

    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${order.order_ref || order.id}.pdf`);
    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);
    doc.fontSize(20).text(order.business_name || 'Shop Receipt', { align: 'center' });
    doc.moveDown().fontSize(12).text(`Order: ${order.order_ref || `#${order.id}`}`);
    doc.text(`Date: ${new Date(order.created_at).toLocaleString()}`);
    doc.text(`Customer: ${order.customer_name} (${order.customer_email})`);
    doc.moveDown();
    items.rows.forEach(item => {
      const price = parseFloat(String(item.price).replace(/[^0-9.]/g, '')) || 0;
      doc.text(`${item.product_name} | ${item.variant_name || 'Default'} | Qty: ${item.quantity} | Ksh ${(price * item.quantity).toFixed(2)} | ID: ${item.unique_id || 'N/A'}`);
    });
    doc.moveDown().fontSize(14).text(`Total: Ksh ${Number(order.total).toFixed(2)}`);
    doc.text(`Status: ${order.status}`);
    if (order.delivery_address) doc.text(`Delivery: ${order.delivery_address}`);
    doc.end();
  } catch (err) {
    console.error('❌ Receipt error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CREATE ORDER - COMPLETE WITH BUSINESS VALIDATION
// ============================================================

router.post('/', authMiddleware, customerOnly, sensitiveLimiter, [
  body('items').isArray().withMessage('Items must be array'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const customerId = req.userId;
  const {
    items, shipping_tier, order_notes,
    promo_code,
    delivery_address, recipient_name, recipient_phone,
    delivery_instructions, customer_lat, customer_lng, location_accuracy,
    delivery_method = 'pickup',
    delivery_fee = 0,
    delivery_area = null,
    delivery_time_slot = null,
    meeting_point_id = null,
    meeting_point_name = null,
    meeting_point_address = null,
    meeting_point_time = null,
    meeting_code = null,
    business_id, // Business ID from frontend
    payment_mode = 'online',
    pod_agreement_signed = false
  } = req.body;

  try {
    console.log('📦 ORDER CREATION STARTED');
    console.log('📦 User:', customerId);
    console.log('📦 Items:', items.length);

    let subtotal = 0;
    let finalBusinessId = business_id || null;

    // Validate items and determine business_id
    for (const item of items) {
      const productId = parseInt(item.productId || item.id, 10);
      const quantity = parseInt(item.quantity, 10);
      if (!Number.isInteger(productId) || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ error: 'Each order item must have a valid product and quantity.' });
      }

      // Get product info
      const productResult = await pool.query(
        'SELECT id, business_id, stock, name, price FROM products WHERE id = $1 AND is_active = true',
        [productId]
      );

      if (productResult.rows.length === 0) {
        return res.status(400).json({ error: `Product not found: ${item.name}` });
      }

      // Use business_id from product if not provided
      const productBusinessId = productResult.rows[0].business_id;

      if (!finalBusinessId) {
        finalBusinessId = productBusinessId;
      } else if (finalBusinessId !== productBusinessId) {
        return res.status(400).json({
          error: 'All items in an order must belong to the same business. Please separate your order.'
        });
      }

      const product = productResult.rows[0];
      let unitPrice = Number(product.price);
      let availableStock = product.stock;
      let variantName = 'Default';
      let variantId = null;
      if (item.variant_id) {
        const variantResult = await pool.query(
          'SELECT id, name, price, stock FROM product_variants WHERE id = $1 AND product_id = $2',
          [item.variant_id, productId]
        );
        if (variantResult.rows.length === 0) return res.status(400).json({ error: `Product variant not found: ${product.name}` });
        const variant = variantResult.rows[0];
        unitPrice = Number(variant.price ?? product.price);
        availableStock = variant.stock;
        variantName = variant.name || 'Default';
        variantId = variant.id;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) return res.status(400).json({ error: `Product has an invalid price: ${product.name}` });
      if (availableStock < quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${product.name}. Available: ${availableStock}`
        });
      }
      item.productId = productId;
      item.id = productId;
      item.name = product.name;
      item.price = unitPrice.toFixed(2);
      item.quantity = quantity;
      item.variant_id = variantId;
      item.variant_name = variantName;
      subtotal += unitPrice * quantity;
    }

    if (!finalBusinessId) {
      return res.status(400).json({ error: 'No valid products found in order.' });
    }

    // Check if business is active and accepting orders
    const businessCheck = await pool.query(
      `SELECT is_active, online_orders_enabled, business_name,
              online_payment_enabled, payment_on_delivery_enabled,
              require_pod_agreement, pod_agreement_text
       FROM businesses WHERE id = $1`,
      [finalBusinessId]
    );

    if (businessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found' });
    }

    if (!businessCheck.rows[0].is_active) {
      return res.status(400).json({ error: 'Business is currently inactive' });
    }

    if (!businessCheck.rows[0].online_orders_enabled) {
      return res.status(400).json({ error: 'Business is not accepting online orders at this time' });
    }

    const businessSettings = businessCheck.rows[0];
    const paymentMode = payment_mode === 'pod' ? 'pod' : 'online';
    if (paymentMode === 'online' && businessSettings.online_payment_enabled === false) {
      return res.status(400).json({ error: 'This business does not accept online payments.' });
    }
    if (paymentMode === 'pod' && !businessSettings.payment_on_delivery_enabled) {
      return res.status(400).json({ error: 'This business does not offer payment on delivery.' });
    }
    if (paymentMode === 'pod' && businessSettings.require_pod_agreement && pod_agreement_signed !== true) {
      return res.status(400).json({ error: 'You must accept the payment-on-delivery agreement before placing this order.' });
    }

    const businessName = businessCheck.rows[0].business_name;
    let trustedDeliveryFee = 0;
    if (delivery_method === 'delivery') {
      const delivery = await Business.calculateDeliveryFee(finalBusinessId, customer_lat, customer_lng, subtotal);
      if (!delivery.available) return res.status(400).json({ error: delivery.message || 'Delivery is not available for this order.' });
      trustedDeliveryFee = Number(delivery.fee) || 0;
    }

    const tier = shipping_tier || 'standard';
    const shippingCost = calculateShippingCost(subtotal, tier);

    let discount = 0;
    if (promo_code) {
      const promoResult = await pool.query(
        'SELECT * FROM promo_codes WHERE code = $1 AND active = true AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)',
        [promo_code.toUpperCase()]
      );
      if (promoResult.rows.length > 0) {
        const promo = promoResult.rows[0];
        if (subtotal >= promo.min_order_value) {
          if (promo.discount_type === 'percentage') {
            discount = subtotal * promo.discount_value / 100;
          } else {
            discount = promo.discount_value;
          }
          discount = Math.min(discount, subtotal);
          await pool.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
        }
      }
    }

    const total = subtotal + shippingCost + trustedDeliveryFee - discount;

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    const urgent = tier === 'overnight';
    const deliveryCode = generateDeliveryCode();

    await pool.query('BEGIN');

    const orderResult = await pool.query(`
      INSERT INTO orders (
        customer_id, business_id, total, status, order_ref, status_history,
        shipping_tier, shipping_cost, order_notes, promo_code, discount_applied,
        delivery_address, recipient_name, recipient_phone, delivery_instructions,
        customer_lat, customer_lng, location_accuracy, location_detected_at,
        urgent_delivery, payment_status,
       delivery_method, delivery_fee, delivery_area, delivery_time_slot,
        meeting_point_id, meeting_point_name, meeting_point_address,
        meeting_point_time, meeting_code, delivery_chosen_at,
        delivery_recipient_name, delivery_phone, delivery_status,
        pickup_recipient_name, pickup_phone, payment_mode, pod_agreement_signed,
        pod_agreement_signed_at, pod_agreement_ip
      )
      VALUES ($1, $2, $3, $32, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, NOW(), $18, 'pending',
              $19, $20, $21, $22, $23, $24, $25, $26, $27, NOW(),
              $28, $29, 'pending', $30, $31, $33, $34, $35, $36)
      RETURNING *
    `, [
      customerId, finalBusinessId, total, orderRef,
      JSON.stringify([{ status: paymentMode === 'pod' ? 'pending' : 'pending_payment', timestamp: new Date().toISOString() }]),
      tier, shippingCost,
      order_notes || null, promo_code || null, discount,
      delivery_address || null, recipient_name || null, recipient_phone || null,
      delivery_instructions || null, customer_lat || null, customer_lng || null,
       location_accuracy || null, urgent,
       delivery_method, trustedDeliveryFee, delivery_area, delivery_time_slot,
      meeting_point_id || null, meeting_point_name || null, meeting_point_address || null,
      meeting_point_time || null, deliveryCode,
      recipient_name || null, recipient_phone || null,
      recipient_name || null, recipient_phone || null,
      paymentMode === 'pod' ? 'pending' : 'pending_payment',
      paymentMode,
      paymentMode === 'pod' && pod_agreement_signed === true,
      paymentMode === 'pod' && pod_agreement_signed === true ? new Date() : null,
      paymentMode === 'pod' ? req.ip : null
    ]);

    const order = orderResult.rows[0];
    console.log('📦 Order created:', order.id);

    // Record a signed POD agreement inside the checkout transaction.  It used
    // to be (incorrectly) attempted by the receipt endpoint, where checkout
    // variables do not exist and every receipt request failed.
    if (paymentMode === 'pod') {
      await pool.query(
        `INSERT INTO pod_agreements (customer_id, order_id, business_id, agreement_text, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [customerId, order.id, finalBusinessId,
          businessSettings.pod_agreement_text || 'Payment on Delivery Agreement',
          req.ip, req.get('user-agent') || null]
      );
    }

    // Insert order items with business_id
    for (const item of items) {
      const uniqueId = generateOrderRef();
      await pool.query(`
        INSERT INTO order_items (
          order_id, product_id, product_name, price, quantity, image,
          unique_id, variant_name, variant_id, business_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        order.id, item.productId || 0, item.name, item.price, item.quantity,
        item.image || '', uniqueId, item.variant_name || 'Default',
        item.variant_id || null, finalBusinessId
      ]);

      await decrementStockAtomic(item.productId, item.quantity, item.variant_id);
    }

    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', customerId]);

    await pool.query('COMMIT');

    const io = req.app.get('io');
    io.emit('new-order', { orderId: order.id, businessId: finalBusinessId });
    io.to(`business_${finalBusinessId}`).emit('new-order', { orderId: order.id });

    // Send delivery record to seller via socket
    if (delivery_method !== 'pickup') {
      io.to(`business_${finalBusinessId}`).emit('delivery-choice-recorded', {
        order_id: order.id,
        delivery_method: delivery_method,
        customer_id: customerId,
        delivery_code: deliveryCode,
        recorded_at: new Date().toISOString()
      });
    }

    try {
      const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [customerId]);
      if (customerResult.rows.length > 0) {
        const orderWithItems = { ...order, items };
        const mailData = orderConfirmationEmail(orderWithItems, customerResult.rows[0].name, businessName);
        await sendEmail({
          to: customerResult.rows[0].email,
          ...mailData
        });
        console.log('📧 Order confirmation email sent to:', customerResult.rows[0].email);
      }
    } catch (emailErr) {
      console.error('⚠️ Email send failed:', emailErr.message);
    }

    res.status(201).json({ success: true, order, requiresPayment: paymentMode === 'online' });

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('❌ Order creation error:', err);
    logError(err, 'Order creation');
    res.status(500).json({
      error: err.message || 'Order creation failed',
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
//  GET ORDERS (Customer, Admin, Business Admin)
// ============================================================

router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status, search, startDate, endDate, limit = 50, page = 1 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name,
      (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

    if (req.role === 'customer') {
      conditions.push(`o.customer_id = $${paramIndex}`);
      params.push(req.userId);
      paramIndex++;
    }

    if (req.role === 'business_admin') {
      conditions.push(`o.business_id = $${paramIndex}`);
      params.push(req.businessId);
      paramIndex++;
    }

    if (req.role === 'super_admin' || req.role === 'admin') {
      if (status && status !== 'all') {
        conditions.push(`o.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }
      if (search) {
        conditions.push(`(c.name ILIKE $${paramIndex} OR c.email ILIKE $${paramIndex} OR o.order_ref ILIKE $${paramIndex})`);
        params.push(`%${search}%`);
        paramIndex++;
      }
      if (startDate) {
        conditions.push(`o.created_at >= $${paramIndex}`);
        params.push(startDate);
        paramIndex++;
      }
      if (endDate) {
        conditions.push(`o.created_at <= $${paramIndex}`);
        params.push(endDate + ' 23:59:59');
        paramIndex++;
      }
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY o.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Get orders error:', err);
    logError(err, 'Get orders');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET ORDER BY ID
// ============================================================

router.get('/:id', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name, b.location as business_location
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.id = $1
    `, [orderId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = result.rows[0];

    // Check permissions
    if (req.role === 'customer' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.role === 'business_admin' && order.business_id !== req.businessId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    console.error('❌ Get order error:', err);
    logError(err, 'Get order');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET ORDER TRACKING
// ============================================================

router.get('/:id/tracking', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    // Check permissions
    if (req.role === 'customer' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.role === 'business_admin' && order.business_id !== req.businessId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    order.items = itemsResult.rows;

    // Get custom status messages from business settings
    let statusMessage = '';
    const statusMessages = {
      'pending_payment': '⏳ Awaiting payment confirmation.',
      'pending': '📋 Your order is being reviewed.',
      'confirmed': '✅ Your order is confirmed and being prepared.',
      'shipped': '🚚 Your order is on the way.',
      'delivered': '📦 Please collect within 7 working days.',
      'received': '✔️ You have confirmed receipt. Thank you!',
      'cancelled': '❌ This order has been cancelled.',
      'completed': '✅ Order completed. Thank you for shopping!'
    };

    // Try to get custom status message from business settings
    if (order.business_id) {
      try {
        const settingsResult = await pool.query(
          'SELECT * FROM business_order_settings WHERE business_id = $1',
          [order.business_id]
        );
        if (settingsResult.rows.length > 0) {
          const settings = settingsResult.rows[0];
          statusMessage = settings[`status_${order.status}`] || statusMessages[order.status] || 'Status unknown.';
        } else {
          statusMessage = statusMessages[order.status] || 'Status unknown.';
        }
      } catch (err) {
        statusMessage = statusMessages[order.status] || 'Status unknown.';
      }
    } else {
      statusMessage = statusMessages[order.status] || 'Status unknown.';
    }

    // Delivery estimate
    let deliveryEstimate = '';
    if (order.estimated_delivery_days) {
      deliveryEstimate = `Estimated delivery: ${order.estimated_delivery_days} days`;
    } else if (order.shipping_tier === 'overnight') {
      deliveryEstimate = '🚀 Overnight delivery';
    } else if (order.shipping_tier === 'express') {
      deliveryEstimate = '⚡ Express delivery (1-2 days)';
    } else {
      deliveryEstimate = '📦 Standard delivery (3-5 days)';
    }

    res.json({ ...order, statusMessage, deliveryEstimate });
  } catch (err) {
    console.error('❌ Tracking error:', err);
    logError(err, 'Tracking');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  RECORD DELIVERY CHOICE (Customer)
// ============================================================

router.post('/record-delivery-choice', authMiddleware, customerOnly, [
  body('delivery_method').isIn(['delivery', 'pickup', 'chat']).withMessage('Invalid delivery method'),
  body('order_id').optional().isInt().withMessage('Invalid order ID')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const customerId = req.userId;
    const {
      order_id,
      delivery_method,
      delivery_recipient_name,
      delivery_phone,
      delivery_address,
      delivery_instructions,
      pickup_recipient_name,
      pickup_phone,
      chat_agreement,
      delivery_code,
      delivery_fee
    } = req.body;

    let orderId = order_id;

    // If no order ID, create a pending order
    if (!orderId) {
      // Create a pending order
      const orderRef = generateOrderRef();
      const newOrder = await pool.query(`
        INSERT INTO orders (
          customer_id, total, status, order_ref, status_history, payment_status,
          delivery_method, delivery_code, delivery_chosen_at,
          delivery_recipient_name, delivery_phone, delivery_status
        )
        VALUES ($1, 0, 'pending_delivery', $2, $3, 'pending', $4, $5, NOW(), $6, $7, 'pending')
        RETURNING id
      `, [
        customerId,
        orderRef,
        JSON.stringify([{ status: 'pending_delivery', timestamp: new Date().toISOString() }]),
        delivery_method,
        delivery_code || generateDeliveryCode(),
        delivery_recipient_name || null,
        delivery_phone || null
      ]);
      orderId = newOrder.rows[0].id;
    }

    // Record delivery choice
    const result = await Order.recordDeliveryChoice(orderId, customerId, {
      delivery_method,
      delivery_recipient_name,
      delivery_phone,
      delivery_address,
      delivery_instructions,
      pickup_recipient_name,
      pickup_phone,
      chat_agreement,
      delivery_code,
      delivery_fee
    });

    // Get delivery record for response
    const record = await Order.getDeliveryRecord(orderId);

    // Notify seller via Socket.IO
    if (result) {
      const io = req.app.get('io');
      const orderCheck = await pool.query(
        'SELECT business_id FROM orders WHERE id = $1',
        [orderId]
      );
      if (orderCheck.rows.length > 0 && orderCheck.rows[0].business_id) {
        io.to(`business_${orderCheck.rows[0].business_id}`).emit('delivery-choice-recorded', {
          order_id: orderId,
          delivery_method: delivery_method,
          customer_id: customerId,
          recorded_at: new Date().toISOString(),
          record: record
        });
      }
    }

    res.json({
      success: true,
      order_id: orderId,
      delivery_method: delivery_method,
      delivery_code: delivery_code || generateDeliveryCode(),
      recorded_at: new Date().toISOString(),
      message: '✅ Delivery choice recorded successfully!',
      record: record
    });

  } catch (err) {
    console.error('❌ Record delivery choice error:', err);
    logError(err, 'Record delivery');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET DELIVERY RECORD (Customer)
// ============================================================

router.get('/:orderId/delivery-record', authMiddleware, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);
    const customerId = req.userId;

    // Verify order belongs to customer or admin
    const orderCheck = await pool.query(
      'SELECT customer_id, business_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderCheck.rows[0];

    // Check permissions
    if (req.role === 'customer' && order.customer_id !== customerId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (req.role === 'business_admin') {
      const businessCheck = await pool.query(
        'SELECT id FROM businesses WHERE id = $1 AND owner_id = $2',
        [order.business_id, req.userId]
      );
      if (businessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const record = await Order.getDeliveryRecord(orderId);
    res.json(record || {});

  } catch (err) {
    console.error('❌ Get delivery record error:', err);
    logError(err, 'Get delivery record');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CONFIRM DELIVERY (Seller)
// ============================================================

router.put('/:orderId/confirm-delivery', authMiddleware, businessAdminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);

    // Get business_id from order
    const orderCheck = await pool.query(
      'SELECT customer_id, business_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const businessId = orderCheck.rows[0].business_id;
    const customerId = orderCheck.rows[0].customer_id;

    // Verify business ownership
    if (req.role !== 'admin' && req.role !== 'super_admin') {
      const businessCheck = await pool.query(
        'SELECT id FROM businesses WHERE id = $1 AND owner_id = $2',
        [businessId, req.userId]
      );
      if (businessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You do not own this business' });
      }
    }

    const result = await Order.confirmDeliveryBySeller(orderId, businessId);

    if (!result) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await appendOrderStatus(orderId, 'delivered', 'Delivery confirmed by seller');

    if (req.userId) {
      await logAdminActivity(req.userId, 'CONFIRM_DELIVERY', { orderId, businessId });
    }

    // Notify customer
    const io = req.app.get('io');
    io.to(`customer_${customerId}`).emit('delivery-confirmed', {
      order_id: orderId,
      confirmed_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: '✅ Delivery confirmed successfully!',
      order: result
    });

  } catch (err) {
    console.error('❌ Confirm delivery error:', err);
    logError(err, 'Confirm delivery');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CONFIRM PICKUP (Seller)
// ============================================================

router.put('/:orderId/confirm-pickup', authMiddleware, businessAdminOnly, async (req, res) => {
  try {
    const orderId = parseInt(req.params.orderId);

    const orderCheck = await pool.query(
      'SELECT customer_id, business_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const businessId = orderCheck.rows[0].business_id;
    const customerId = orderCheck.rows[0].customer_id;

    if (req.role !== 'admin' && req.role !== 'super_admin') {
      const businessCheck = await pool.query(
        'SELECT id FROM businesses WHERE id = $1 AND owner_id = $2',
        [businessId, req.userId]
      );
      if (businessCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You do not own this business' });
      }
    }

    const result = await Order.confirmPickupBySeller(orderId, businessId);

    if (!result) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await appendOrderStatus(orderId, 'delivered', 'Pickup confirmed by seller');

    if (req.userId) {
      await logAdminActivity(req.userId, 'CONFIRM_PICKUP', { orderId, businessId });
    }

    const io = req.app.get('io');
    io.to(`customer_${customerId}`).emit('pickup-confirmed', {
      order_id: orderId,
      confirmed_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: '✅ Pickup confirmed successfully!',
      order: result
    });

  } catch (err) {
    console.error('❌ Confirm pickup error:', err);
    logError(err, 'Confirm pickup');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REPORT DELIVERY DISPUTE (Customer)
// ============================================================

router.post('/:orderId/dispute', authMiddleware, customerOnly, [
  body('reason').notEmpty().withMessage('Please provide a reason')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const orderId = parseInt(req.params.orderId);
    const customerId = req.userId;
    const { reason } = req.body;

    // Verify order belongs to customer
    const orderCheck = await pool.query(
      'SELECT customer_id, business_id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (orderCheck.rows[0].customer_id !== customerId) {
      return res.status(403).json({ error: 'Not your order' });
    }

    const result = await Order.reportDeliveryDispute(orderId, customerId, reason);

    if (!result) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await appendOrderStatus(orderId, 'dispute', `Delivery dispute reported by customer. Reason: ${reason}`);

    // Notify admin and seller
    const io = req.app.get('io');
    io.emit('delivery-dispute', {
      order_id: orderId,
      customer_id: customerId,
      business_id: orderCheck.rows[0].business_id,
      reason: reason,
      reported_at: new Date().toISOString()
    });
    io.to(`business_${orderCheck.rows[0].business_id}`).emit('delivery-dispute', {
      order_id: orderId,
      customer_id: customerId,
      reason: reason,
      reported_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: '⚠️ Dispute reported. Admin will review it shortly.',
      order: result
    });

  } catch (err) {
    console.error('❌ Report dispute error:', err);
    logError(err, 'Report dispute');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET DELIVERY RECORDS FOR BUSINESS (Admin)
// ============================================================

router.get('/delivery-records', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    if (req.role === 'business_admin') {
      const records = await Order.getDeliveryRecordsForBusiness(
        req.businessId,
        parseInt(limit),
        parseInt(offset)
      );
      return res.json(records);
    }

    if (req.role === 'admin' || req.role === 'super_admin') {
      const result = await pool.query(`
        SELECT dr.*,
               o.order_ref, o.customer_id, o.business_id,
               c.name as customer_name, c.email as customer_email,
               b.business_name
        FROM delivery_records dr
        LEFT JOIN orders o ON dr.order_id = o.id
        LEFT JOIN customers c ON dr.customer_id = c.id
        LEFT JOIN businesses b ON dr.business_id = b.id
        ORDER BY dr.recorded_at DESC
        LIMIT $1 OFFSET $2
      `, [parseInt(limit), parseInt(offset)]);
      return res.json(result.rows);
    }

    return res.status(403).json({ error: 'Forbidden' });

  } catch (err) {
    console.error('❌ Get delivery records error:', err);
    logError(err, 'Get delivery records');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET DELIVERY RECORDS FOR CUSTOMER
// ============================================================

router.get('/my-delivery-records', authMiddleware, customerOnly, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const records = await Order.getDeliveryRecordsForCustomer(
      req.userId,
      parseInt(limit),
      parseInt(offset)
    );
    res.json(records);

  } catch (err) {
    console.error('❌ Get customer delivery records error:', err);
    logError(err, 'Get customer delivery records');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CANCEL ORDER
// ============================================================

router.put('/:id/cancel', authMiddleware, [
  body('reason').notEmpty().withMessage('Cancellation reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref, created_at FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    // Check permissions
    if (req.role === 'customer' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Not your order' });
    }
    if (req.role === 'business_admin') {
      const businessCheck = await pool.query(
        'SELECT business_id FROM orders WHERE id = $1',
        [orderId]
      );
      if (businessCheck.rows.length > 0 && businessCheck.rows[0].business_id !== req.businessId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    if (req.role !== 'super_admin' && req.role !== 'admin' && req.role !== 'business_admin') {
      const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
      const maxHours = parseInt(await getSystemSetting('replacement_hours', '6'));
      if (hoursSinceOrder > maxHours) {
        return res.status(400).json({ error: `Cancellation only allowed within ${maxHours} hours of order placement.` });
      }
    }

    if (!['pending', 'confirmed', 'pending_payment'].includes(order.status)) {
      return res.status(400).json({ error: 'This order cannot be cancelled.' });
    }

    await restockOrder(orderId);

    const cancelledBy = req.role === 'super_admin' || req.role === 'admin' ? 'admin' :
                        req.role === 'business_admin' ? 'business_admin' : 'customer';

    await pool.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW() WHERE id = $2`,
      [cancelledBy, orderId]
    );
    await appendOrderStatus(orderId, 'cancelled', `Cancelled by ${cancelledBy}. Reason: ${reason}`);
    const ref = order.order_ref || `#${orderId}`;
    const msg = `❌ Order ${ref} has been cancelled. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Order cancelled.' });
  } catch (err) {
    console.error('❌ Cancel order error:', err);
    logError(err, 'Cancel order');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REFUND ORDER
// ============================================================

router.put('/:id/refund', authMiddleware, customerOnly, [
  body('reason').notEmpty().withMessage('Refund reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const orderId = parseInt(req.params.id);
  const { reason } = req.body;
  try {
    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    if (orderCheck.rows[0].status === 'cancelled' || orderCheck.rows[0].status === 'received' || orderCheck.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'This order cannot be refunded.' });
    }
    await pool.query(`UPDATE orders SET refund_request = $1, refund_status = 'pending' WHERE id = $2`, [reason, orderId]);
    const msg = `💰 Refund requested for order #${orderId}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    res.json({ success: true, message: 'Refund request submitted.' });
  } catch (err) {
    console.error('❌ Refund error:', err);
    logError(err, 'Refund');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  RECEIVE ORDER
// ============================================================

router.put('/:id/receive', authMiddleware, customerOnly, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, status, order_ref FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Not your order.' });
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Order must be delivered before you can mark it as received.' });
    }
    await pool.query(`UPDATE orders SET status = 'received', received_at = NOW(), updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'received');
    const ref = order.order_ref || `#${orderId}`;
    const msg = `✅ Order ${ref} has been received by the customer.`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Customer', msg]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Customer', message: msg, timestamp: new Date() });

    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [req.userId]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        // Get business name
        const businessResult = await pool.query(
          'SELECT business_name FROM businesses WHERE id = (SELECT business_id FROM orders WHERE id = $1)',
          [orderId]
        );
        const businessName = businessResult.rows[0]?.business_name || null;
        const mailData = receivedEmail({ ...order, status: 'received' }, customer.name, businessName);
        await sendEmail({ to: customer.email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Receive order error:', err);
    logError(err, 'Receive order');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REORDER
// ============================================================

router.post('/:id/reorder', authMiddleware, customerOnly, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const itemsResult = await pool.query(
      'SELECT product_id, product_name, price, image, variant_name, variant_id, business_id FROM order_items WHERE order_id = $1',
      [orderId]
    );
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: 'No items to reorder.' });
    const cartItems = itemsResult.rows.map(item => ({
      id: item.product_id,
      name: item.product_name,
      price: item.price,
      image: item.image || '',
      quantity: 1,
      variant_name: item.variant_name || 'Default',
      variant_id: item.variant_id || null,
      business_id: item.business_id
    }));
    await pool.query('UPDATE carts SET items = $1, updated_at = NOW() WHERE customer_id = $2',
      [JSON.stringify(cartItems), req.userId]);
    res.json({ success: true, items: cartItems });
  } catch (err) {
    console.error('❌ Reorder error:', err);
    logError(err, 'Reorder');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CONFIRM ORDER (Admin/Business Admin)
// ============================================================

router.put('/:id/confirm', authMiddleware, async (req, res) => {
  if (req.role !== 'super_admin' && req.role !== 'admin' && req.role !== 'business_admin') {
    return res.status(403).json({ error: 'Admin or Business Admin only.' });
  }

  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.id = $1
    `, [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    // Check business admin permissions
    if (req.role === 'business_admin' && order.business_id !== req.businessId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (order.status !== 'pending') {
      return res.status(400).json({ error: `Order already processed (status: ${order.status})` });
    }
    await pool.query(`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`, [orderId]);
    await appendOrderStatus(orderId, 'confirmed');
    await logAdminActivity(req.userId, 'CONFIRM_ORDER', { orderId });

    const itemsResult = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const items = itemsResult.rows;

    const ref = order.order_ref || `#${order.id}`;
    let message = `✅ **Order ${ref} Confirmed!**\n\n`;
    message += `Dear ${order.customer_name},\n\n`;
    message += `Your order has been confirmed. Here are the details:\n\n`;
    message += `📦 **Order Items:**\n`;
    let total = 0;
    items.forEach((item, index) => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g, '')) || 0;
      const subtotal = priceNum * item.quantity;
      total += subtotal;
      const variant = item.variant_name || 'Default';
      const uniqueId = item.unique_id || '—';
      message += `${index+1}. ${item.product_name} (${variant}) x${item.quantity} – Ksh ${subtotal.toFixed(2)} (ID: ${uniqueId})\n`;
    });
    message += `\n💰 **Total:** Ksh ${Number(order.total).toFixed(2)}\n\n`;
    message += `📍 **Delivery Location:**\n`;
    message += `   ${order.delivery_address || 'Not provided'}\n`;
    if (order.recipient_name) message += `   👤 Recipient: ${order.recipient_name} (${order.recipient_phone || 'N/A'})\n`;
    if (order.delivery_instructions) message += `   📝 Instructions: ${order.delivery_instructions}\n`;
    if (order.customer_lat && order.customer_lng) {
      message += `   🗺️ GPS: ${order.customer_lat}, ${order.customer_lng}\n`;
    }
    message += `\n📅 Order Date: ${new Date(order.created_at).toLocaleString()}\n`;
    message += `🆔 Reference: ${ref}\n\n`;
    message += `Thank you for shopping with us! 🙏`;

    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', message]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: message, timestamp: new Date() });

    if (order.customer_email) {
      try {
        const businessName = order.business_name || null;
        const mailData = orderConfirmationEmail(order, order.customer_name, businessName);
        await sendEmail({ to: order.customer_email, ...mailData });
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true, message: '✅ Order confirmed.' });
  } catch (err) {
    console.error('❌ Confirm order error:', err);
    logError(err, 'Confirm order');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE ORDER STATUS (Admin/Business Admin)
// ============================================================

router.put('/:id/status', authMiddleware, async (req, res) => {
  if (req.role !== 'super_admin' && req.role !== 'admin' && req.role !== 'business_admin') {
    return res.status(403).json({ error: 'Admin or Business Admin only.' });
  }

  const orderId = parseInt(req.params.id);
  const { status, tracking_number } = req.body;
  try {
    const current = await pool.query('SELECT status, customer_id, order_ref, business_id FROM orders WHERE id = $1', [orderId]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    // Check business admin permissions
    if (req.role === 'business_admin' && current.rows[0].business_id !== req.businessId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const currentStatus = current.rows[0].status;
    if (currentStatus === 'pending') return res.status(400).json({ error: 'Order must be confirmed first.' });
    if (currentStatus === 'received' || currentStatus === 'cancelled' || currentStatus === 'completed') {
      return res.status(400).json({ error: 'Order already processed.' });
    }
    const updates = { status };
    if (status === 'shipped') {
      updates.shipped_at = new Date();
      if (tracking_number) updates.tracking_number = tracking_number;
    } else if (status === 'delivered') {
      updates.delivered_at = new Date();
    }
    await pool.query(
      `UPDATE orders SET status = $1, shipped_at = $2, delivered_at = $3, tracking_number = $4, updated_at = NOW() WHERE id = $5`,
      [updates.status, updates.shipped_at || null, updates.delivered_at || null, updates.tracking_number || null, orderId]
    );
    await appendOrderStatus(orderId, status);
    await logAdminActivity(req.userId, `UPDATE_ORDER_TO_${status.toUpperCase()}`, { orderId });

    const orderRef = current.rows[0].order_ref || `#${orderId}`;
    const msg = `📦 Order ${orderRef} status updated to: ${status.toUpperCase()}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)',
      [orderId, 'Seller', msg]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'Seller', message: msg, timestamp: new Date() });

    const customerResult = await pool.query('SELECT name, email FROM customers WHERE id = $1', [current.rows[0].customer_id]);
    const customer = customerResult.rows[0];
    if (customer && customer.email) {
      try {
        // Get business name
        const businessResult = await pool.query(
          'SELECT business_name FROM businesses WHERE id = (SELECT business_id FROM orders WHERE id = $1)',
          [orderId]
        );
        const businessName = businessResult.rows[0]?.business_name || null;
        const mailData = statusUpdateEmail({ ...current.rows[0], status, tracking_number }, status, customer.name, businessName);
        await sendEmail({ to: customer.email, ...mailData });
        console.log('📧 Status update email sent to:', customer.email);
      } catch (emailErr) {
        console.error('⚠️ Email send failed:', emailErr.message);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Update status error:', err);
    logError(err, 'Update status');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ORDER CHAT
// ============================================================

router.get('/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  try {
    const orderResult = await pool.query('SELECT customer_id, business_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    // Check permissions
    if (req.role === 'customer' && order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.role === 'business_admin' && order.business_id !== req.businessId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await pool.query('SELECT * FROM order_chat_messages WHERE order_id = $1 ORDER BY timestamp ASC', [orderId]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Order chat error:', err);
    logError(err, 'Order chat');
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/chat', authMiddleware, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  try {
    const orderResult = await pool.query('SELECT customer_id, business_id FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];

    // Determine sender
    let from = '';
    if (req.role === 'customer' && order.customer_id === req.userId) {
      from = 'Customer';
    } else if (req.role === 'business_admin' && order.business_id === req.businessId) {
      from = 'Seller';
    } else if (req.role === 'super_admin' || req.role === 'admin') {
      from = 'Seller';
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await pool.query(
      'INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3) RETURNING *',
      [orderId, from, message]
    );
    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', result.rows[0]);
    res.json({ success: true, msg: result.rows[0] });
  } catch (err) {
    console.error('❌ Send chat error:', err);
    logError(err, 'Send chat');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  REPLACE SIMPLE
// ============================================================

router.put('/:id/replace-simple', authMiddleware, customerOnly, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const { oldProductIds, newProductIds } = req.body;

  try {
    const orderCheck = await pool.query(
      `SELECT customer_id, status, created_at FROM orders WHERE id = $1`,
      [orderId]
    );
    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderCheck.rows[0];
    if (order.customer_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const hoursSinceOrder = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60);
    const maxHours = parseInt(await getSystemSetting('replacement_hours', '6'));
    if (hoursSinceOrder > maxHours) {
      return res.status(400).json({ error: `Replacement only allowed within ${maxHours} hours of order placement.` });
    }

    const oldItemsResult = await pool.query(
      `SELECT product_id, product_name, price, quantity
       FROM order_items
       WHERE order_id = $1 AND product_id = ANY($2::int[])`,
      [orderId, oldProductIds]
    );

    if (oldItemsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No matching items found in order.' });
    }

    let oldTotal = 0;
    oldItemsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      oldTotal += priceNum * item.quantity;
    });

    const newProductsResult = await pool.query(
      `SELECT id, name, price FROM products WHERE id = ANY($1::int[]) AND is_active = true`,
      [newProductIds]
    );

    if (newProductsResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid replacement products found.' });
    }

    let newTotal = 0;
    newProductsResult.rows.forEach(item => {
      const priceNum = parseFloat(item.price.replace(/[^0-9.]/g,'')) || 0;
      newTotal += priceNum;
    });

    const diff = newTotal - oldTotal;

    let replacementStatus = 'pending';
    let paymentStatus = 'none';
    let refundStatus = 'none';

    if (diff === 0) {
      replacementStatus = 'approved';
      paymentStatus = 'approved';
      refundStatus = 'approved';
    } else if (diff > 0) {
      paymentStatus = 'pending';
    } else {
      refundStatus = 'pending';
    }

    const replacementData = {
      old_items: oldItemsResult.rows,
      new_items: newProductsResult.rows,
      old_total: oldTotal,
      new_total: newTotal,
      diff: diff,
      status: replacementStatus
    };

    await pool.query(
      `UPDATE orders
       SET replacement_request = $1,
           replacement_status = $2,
           replacement_diff = $3,
           replacement_payment_status = $4,
           replacement_refund_status = $5
       WHERE id = $6`,
      [JSON.stringify(replacementData), replacementStatus, diff, paymentStatus, refundStatus, orderId]
    );

    let msg = `🔄 Replacement request submitted: ${oldItemsResult.rows.map(i => i.product_name).join(', ')} → ${newProductsResult.rows.map(i => i.name).join(', ')}. `;

    if (diff === 0) {
      msg += `✅ Prices are equal. Replacement auto-approved!`;
      await pool.query(
        `UPDATE orders SET replacement_status = 'approved' WHERE id = $1`,
        [orderId]
      );
    } else if (diff > 0) {
      msg += `You need to pay Ksh ${diff.toFixed(2)} extra.`;
    } else {
      msg += `You will get a refund of Ksh ${Math.abs(diff).toFixed(2)}.`;
    }

    await pool.query(
      `INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, 'System', $2)`,
      [orderId, msg]
    );

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', {
      order_id: orderId,
      from_user: 'System',
      message: msg,
      timestamp: new Date()
    });

    res.json({
      success: true,
      replacement: replacementData,
      diff,
      status: replacementStatus,
      payment_status: paymentStatus,
      refund_status: refundStatus
    });

  } catch (err) {
    console.error('❌ Replacement error:', err);
    logError(err, 'Replacement');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET RETURNS - CUSTOMER
// ============================================================

router.get('/returns/customer', authMiddleware, customerOnly, async (req, res) => {
  try {
    const customerId = req.userId;
    const result = await pool.query(
      `SELECT * FROM returns WHERE customer_id = $1 ORDER BY requested_at DESC`,
      [customerId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Customer returns error:', err);
    logError(err, 'Customer returns');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  RETURN REQUEST (Customer)
// ============================================================

router.post('/:id/return', authMiddleware, customerOnly, [
  body('product_id').isInt().withMessage('Product ID required'),
  body('reason').notEmpty().withMessage('Return reason required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const orderId = parseInt(req.params.id);
  const { product_id, reason, photos } = req.body;
  try {
    // Check if product is returnable
    const productCheck = await pool.query('SELECT return_enabled, business_id FROM products WHERE id = $1', [product_id]);
    if (productCheck.rows.length === 0) return res.status(404).json({ error: 'Product not found.' });
    if (!productCheck.rows[0].return_enabled) {
      return res.status(400).json({ error: 'This product is non-returnable.' });
    }

    const orderCheck = await pool.query('SELECT customer_id, status FROM orders WHERE id = $1', [orderId]);
    if (orderCheck.rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    if (orderCheck.rows[0].customer_id !== req.userId) return res.status(403).json({ error: 'Forbidden.' });
    if (!['delivered', 'received', 'completed'].includes(orderCheck.rows[0].status)) {
      return res.status(400).json({ error: 'Return only allowed after delivery.' });
    }

    const existingReturn = await pool.query(
      'SELECT id FROM returns WHERE order_id = $1 AND product_id = $2 AND status IN ($3,$4)',
      [orderId, product_id, 'pending', 'approved']
    );
    if (existingReturn.rows.length > 0) return res.status(400).json({ error: 'Return already requested for this product.' });

    // Get business_id for the return
    const businessId = productCheck.rows[0].business_id;

    await pool.query(
      'INSERT INTO returns (order_id, customer_id, product_id, business_id, reason, photos, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [orderId, req.userId, product_id, businessId, reason, photos || null, 'pending']
    );
    const msg = `📦 Return requested for product #${product_id}. Reason: ${reason}`;
    await pool.query('INSERT INTO order_chat_messages (order_id, from_user, message) VALUES ($1, $2, $3)', [orderId, 'System', msg]);

    const io = req.app.get('io');
    io.to(`order_${orderId}`).emit('new-order-chat-message', { order_id: orderId, from_user: 'System', message: msg, timestamp: new Date() });
    io.emit('return-requested', { orderId });
    res.json({ success: true, message: 'Return request submitted.' });
  } catch (err) {
    console.error('❌ Return request error:', err);
    logError(err, 'Return request');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  HELPER: Generate Delivery Code
// ============================================================

function generateDeliveryCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'DLV-';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

module.exports = router;
