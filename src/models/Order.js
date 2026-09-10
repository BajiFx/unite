// ============================================================
//  ORDER MODEL - Complete with Delivery Recording & Business Support
//  Location: src/models/Order.js
// ============================================================

const { pool } = require('../config/database');
const { generateOrderRef } = require('../utils/helpers');

class Order {
  /**
   * Find order by ID
   */
  static async findById(id) {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.id = $1
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Find order by reference
   */
  static async findByRef(orderRef) {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.order_ref = $1
    `, [orderRef]);
    return result.rows[0] || null;
  }

  /**
   * Get orders for a customer
   */
  static async findByCustomer(customerId, limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT o.*,
             b.business_name,
        (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `, [customerId, limit, offset]);
    return result.rows;
  }

  /**
   * Get orders with filters (admin)
   */
  static async findAll({ status, search, startDate, endDate, limit = 50, offset = 0 }) {
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

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY o.created_at DESC';
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Get orders for a business
   */
  static async findByBusiness(businessId, { status, limit = 50, offset = 0 }) {
    let query = `
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
        (SELECT json_agg(oi.*) FROM order_items oi WHERE oi.order_id = o.id) as items
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      WHERE o.business_id = $1
    `;
    const params = [businessId];
    let paramIndex = 2;

    if (status && status !== 'all') {
      query += ` AND o.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    query += ` ORDER BY o.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Count orders with filters
   */
  static async count({ status, search, startDate, endDate }) {
    let query = `
      SELECT COUNT(*)
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
    `;
    const params = [];
    const conditions = [];
    let paramIndex = 1;

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

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const result = await pool.query(query, params);
    return parseInt(result.rows[0].count);
  }

  /**
   * Create new order - FIXED with business_id in order_items
   */
  static async create(data) {
    const {
      customerId,
      businessId,
      total,
      items,
      shipping_tier = 'standard',
      shipping_cost = 0,
      order_notes = null,
      promo_code = null,
      discount_applied = 0,
      delivery_address = null,
      recipient_name = null,
      recipient_phone = null,
      delivery_instructions = null,
      customer_lat = null,
      customer_lng = null,
      location_accuracy = null,
      urgent_delivery = false,
      delivery_method = 'pickup',
      delivery_fee = 0,
      delivery_area = null,
      delivery_time_slot = null,
      meeting_point_id = null,
      meeting_point_name = null,
      meeting_point_address = null,
      meeting_point_time = null,
      meeting_code = null
    } = data;

    let orderRef;
    let unique = false;
    while (!unique) {
      orderRef = generateOrderRef();
      const check = await pool.query('SELECT id FROM orders WHERE order_ref = $1', [orderRef]);
      if (check.rows.length === 0) unique = true;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(`
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
          pickup_recipient_name, pickup_phone
        )
        VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, NOW(), $18, 'pending',
                $19, $20, $21, $22, $23, $24, $25, $26, $27, NOW(),
                $28, $29, 'pending', $30, $31)
        RETURNING *
      `, [
        customerId, businessId, total, orderRef,
        JSON.stringify([{ status: 'pending_payment', timestamp: new Date().toISOString() }]),
        shipping_tier, shipping_cost,
        order_notes, promo_code, discount_applied,
        delivery_address, recipient_name, recipient_phone, delivery_instructions,
        customer_lat, customer_lng, location_accuracy,
        urgent_delivery,
        delivery_method, delivery_fee, delivery_area, delivery_time_slot,
        meeting_point_id, meeting_point_name, meeting_point_address,
        meeting_point_time, meeting_code,
        recipient_name, recipient_phone,
        recipient_name, recipient_phone
      ]);

      const order = orderResult.rows[0];

      // Insert order items with business_id
      for (const item of items) {
        const uniqueId = generateOrderRef();
        await client.query(`
          INSERT INTO order_items (
            order_id, product_id, product_name, price, quantity, image,
            unique_id, variant_name, variant_id, business_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          order.id,
          item.productId || 0,
          item.name,
          item.price,
          item.quantity,
          item.image || '',
          uniqueId,
          item.variant_name || 'Default',
          item.variant_id || null,
          businessId  // Add business_id to order_items
        ]);
      }

      await client.query(
        'UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2',
        ['[]', customerId]
      );

      await client.query('COMMIT');
      return order;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Update order status
   */
  static async updateStatus(id, status, note = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
        [status, id]
      );

      let history = result.rows[0]?.status_history || [];
      if (typeof history === 'string') history = JSON.parse(history);
      history.push({
        status,
        timestamp: new Date().toISOString(),
        note
      });

      await client.query(
        'UPDATE orders SET status_history = $1 WHERE id = $2',
        [JSON.stringify(history), id]
      );

      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Mark order as shipped
   */
  static async markShipped(id, trackingNumber) {
    const result = await pool.query(`
      UPDATE orders
      SET status = 'shipped',
          shipped_at = NOW(),
          tracking_number = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [trackingNumber, id]);
    return result.rows[0] || null;
  }

  /**
   * Mark order as delivered
   */
  static async markDelivered(id) {
    const result = await pool.query(`
      UPDATE orders
      SET status = 'delivered',
          delivered_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Mark order as received
   */
  static async markReceived(id) {
    const result = await pool.query(`
      UPDATE orders
      SET status = 'received',
          received_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);
    return result.rows[0] || null;
  }

  /**
   * Cancel order
   */
  static async cancel(id, reason, cancelledBy = 'customer') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        UPDATE orders
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancelled_by = $1,
            updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [cancelledBy, id]);

      // Restock items
      const items = await client.query(
        'SELECT product_id, quantity, variant_id FROM order_items WHERE order_id = $1',
        [id]
      );

      for (const item of items.rows) {
        if (item.variant_id) {
          await client.query(
            'UPDATE product_variants SET stock = stock + $1 WHERE id = $2',
            [item.quantity, item.variant_id]
          );
        } else {
          await client.query(
            'UPDATE products SET stock = stock + $1 WHERE id = $2',
            [item.quantity, item.product_id]
          );
        }
      }

      let history = result.rows[0]?.status_history || [];
      if (typeof history === 'string') history = JSON.parse(history);
      history.push({
        status: 'cancelled',
        timestamp: new Date().toISOString(),
        note: `Cancelled by ${cancelledBy}. Reason: ${reason}`
      });

      await client.query(
        'UPDATE orders SET status_history = $1 WHERE id = $2',
        [JSON.stringify(history), id]
      );

      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Request refund
   */
  static async requestRefund(id, reason) {
    const result = await pool.query(`
      UPDATE orders
      SET refund_request = $1,
          refund_status = 'pending',
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [reason, id]);
    return result.rows[0] || null;
  }

  /**
   * Process refund (admin)
   */
  static async processRefund(id, action) {
    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = await pool.query(`
      UPDATE orders
      SET refund_status = $1,
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [status, id]);
    return result.rows[0] || null;
  }

  /**
   * Get order status history
   */
  static async getStatusHistory(id) {
    const result = await pool.query(
      'SELECT status_history FROM orders WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return [];
    let history = result.rows[0].status_history;
    if (typeof history === 'string') history = JSON.parse(history);
    return history || [];
  }

  /**
   * Get order items
   */
  static async getItems(id) {
    const result = await pool.query(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
      [id]
    );
    return result.rows;
  }

  /**
   * Get order statistics (dashboard)
   */
  static async getStats() {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END) as pending_payment,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(total) as total_revenue
      FROM orders
    `);
    return result.rows[0];
  }

  /**
   * Get replacement orders
   */
  static async getReplacements(status = 'pending') {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.replacement_status = $1
      ORDER BY o.created_at DESC
    `, [status]);
    return result.rows;
  }

  /**
   * Get refund requests
   */
  static async getRefundRequests(status = 'pending') {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.refund_status = $1
      ORDER BY o.created_at DESC
    `, [status]);
    return result.rows;
  }

  // ============================================================
  //  DELIVERY RECORDING METHODS
  // ============================================================

  /**
   * Record delivery choice
   */
  static async recordDeliveryChoice(orderId, customerId, data) {
    const {
      delivery_method,
      delivery_recipient_name,
      delivery_phone,
      delivery_address,
      delivery_instructions,
      pickup_recipient_name,
      pickup_phone,
      chat_agreement,
      delivery_code,
      delivery_fee = 0
    } = data;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get business_id from order
      const orderCheck = await client.query(
        'SELECT business_id, order_ref FROM orders WHERE id = $1 AND customer_id = $2',
        [orderId, customerId]
      );

      if (orderCheck.rows.length === 0) {
        throw new Error('Order not found or does not belong to customer');
      }

      const businessId = orderCheck.rows[0].business_id;
      const orderRef = orderCheck.rows[0].order_ref;

      // Get seller's delivery message
      const sellerMsg = await client.query(
        'SELECT delivery_message FROM businesses WHERE id = $1',
        [businessId]
      );
      const deliverySellerMessage = sellerMsg.rows[0]?.delivery_message || null;

      // Build update query
      const updates = [];
      const params = [];
      let paramIndex = 1;

      // Common fields
      updates.push(`delivery_method = $${paramIndex}`);
      params.push(delivery_method);
      paramIndex++;

      updates.push(`delivery_code = $${paramIndex}`);
      params.push(delivery_code || generateDeliveryCode());
      paramIndex++;

      updates.push(`delivery_chosen_at = NOW()`);
      updates.push(`delivery_status = 'pending'`);
      updates.push(`delivery_fee = $${paramIndex}`);
      params.push(delivery_fee || 0);
      paramIndex++;

      updates.push(`delivery_seller_message = $${paramIndex}`);
      params.push(deliverySellerMessage);
      paramIndex++;

      if (delivery_method === 'delivery') {
        updates.push(`delivery_recipient_name = $${paramIndex}`);
        params.push(delivery_recipient_name || null);
        paramIndex++;

        updates.push(`delivery_phone = $${paramIndex}`);
        params.push(delivery_phone || null);
        paramIndex++;

        updates.push(`delivery_address = $${paramIndex}`);
        params.push(delivery_address || null);
        paramIndex++;

        updates.push(`delivery_instructions = $${paramIndex}`);
        params.push(delivery_instructions || null);
        paramIndex++;

        updates.push(`delivery_confirmed_by_customer = true`);
        updates.push(`delivery_confirmed_at = NOW()`);

      } else if (delivery_method === 'pickup') {
        updates.push(`pickup_recipient_name = $${paramIndex}`);
        params.push(pickup_recipient_name || null);
        paramIndex++;

        updates.push(`pickup_phone = $${paramIndex}`);
        params.push(pickup_phone || null);
        paramIndex++;

        updates.push(`pickup_code = $${paramIndex}`);
        params.push(delivery_code || generateDeliveryCode());
        paramIndex++;

        updates.push(`pickup_chosen_at = NOW()`);
        updates.push(`pickup_confirmed_by_customer = true`);
        updates.push(`pickup_confirmed_at = NOW()`);
        updates.push(`pickup_status = 'pending'`);

      } else if (delivery_method === 'chat') {
        updates.push(`chat_arranged_delivery = true`);
        updates.push(`chat_arranged_message = $${paramIndex}`);
        params.push(chat_agreement || 'Will be agreed in chat');
        paramIndex++;
        updates.push(`chat_arranged_at = NOW()`);
        updates.push(`chat_arranged_by = 'customer'`);
      }

      // Add order_id to params
      params.push(orderId);

      const query = `
        UPDATE orders
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $${paramIndex} AND customer_id = $${paramIndex + 1}
        RETURNING *
      `;
      params.push(customerId);
      paramIndex += 2;

      const result = await client.query(query, params);

      // Create delivery record in audit table
      await client.query(`
        INSERT INTO delivery_records (
          order_id,
          customer_id,
          business_id,
          delivery_method,
          delivery_code,
          delivery_address,
          delivery_phone,
          delivery_recipient_name,
          delivery_instructions,
          delivery_fee,
          delivery_seller_message,
          status,
          recorded_by,
          recorded_at,
          confirmed_by_customer,
          notes
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'customer', NOW(), true, $12
        )
      `, [
        orderId,
        customerId,
        businessId,
        delivery_method,
        delivery_code || generateDeliveryCode(),
        delivery_address || null,
        delivery_phone || null,
        delivery_recipient_name || null,
        delivery_instructions || null,
        delivery_fee || 0,
        deliverySellerMessage,
        `Customer chose ${delivery_method} on ${new Date().toISOString()}`
      ]);

      await client.query('COMMIT');

      return result.rows[0];

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get delivery record for an order
   */
  static async getDeliveryRecord(orderId) {
    const result = await pool.query(`
      SELECT dr.*,
             o.order_ref, o.customer_id, o.business_id,
             c.name as customer_name, c.email as customer_email,
             b.business_name
      FROM delivery_records dr
      LEFT JOIN orders o ON dr.order_id = o.id
      LEFT JOIN customers c ON dr.customer_id = c.id
      LEFT JOIN businesses b ON dr.business_id = b.id
      WHERE dr.order_id = $1
      ORDER BY dr.recorded_at DESC
      LIMIT 1
    `, [orderId]);

    return result.rows[0] || null;
  }

  /**
   * Get delivery records for a business
   */
  static async getDeliveryRecordsForBusiness(businessId, limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT dr.*,
             o.order_ref, o.customer_id,
             c.name as customer_name, c.email as customer_email,
             c.phone as customer_phone
      FROM delivery_records dr
      LEFT JOIN orders o ON dr.order_id = o.id
      LEFT JOIN customers c ON dr.customer_id = c.id
      WHERE dr.business_id = $1
      ORDER BY dr.recorded_at DESC
      LIMIT $2 OFFSET $3
    `, [businessId, limit, offset]);

    return result.rows;
  }

  /**
   * Get delivery records for a customer
   */
  static async getDeliveryRecordsForCustomer(customerId, limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT dr.*,
             o.order_ref, o.business_id,
             b.business_name
      FROM delivery_records dr
      LEFT JOIN orders o ON dr.order_id = o.id
      LEFT JOIN businesses b ON dr.business_id = b.id
      WHERE dr.customer_id = $1
      ORDER BY dr.recorded_at DESC
      LIMIT $2 OFFSET $3
    `, [customerId, limit, offset]);

    return result.rows;
  }

  /**
   * Confirm delivery by seller
   */
  static async confirmDeliveryBySeller(orderId, businessId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        UPDATE orders
        SET delivery_confirmed_by_seller = true,
            delivery_confirmed_at = NOW(),
            delivery_status = 'confirmed',
            updated_at = NOW()
        WHERE id = $1 AND business_id = $2
        RETURNING *
      `, [orderId, businessId]);

      if (result.rows.length > 0) {
        await client.query(`
          UPDATE delivery_records
          SET confirmed_by_seller = true,
              confirmed_at = NOW(),
              status = 'confirmed'
          WHERE order_id = $1
        `, [orderId]);
      }

      await client.query('COMMIT');
      return result.rows[0] || null;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Confirm pickup by seller
   */
  static async confirmPickupBySeller(orderId, businessId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        UPDATE orders
        SET pickup_confirmed_by_seller = true,
            pickup_confirmed_at = NOW(),
            pickup_status = 'confirmed',
            updated_at = NOW()
        WHERE id = $1 AND business_id = $2
        RETURNING *
      `, [orderId, businessId]);

      if (result.rows.length > 0) {
        await client.query(`
          UPDATE delivery_records
          SET confirmed_by_seller = true,
              confirmed_at = NOW(),
              status = 'confirmed'
          WHERE order_id = $1
        `, [orderId]);
      }

      await client.query('COMMIT');
      return result.rows[0] || null;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Report delivery dispute
   */
  static async reportDeliveryDispute(orderId, customerId, reason) {
    const result = await pool.query(`
      UPDATE orders
      SET delivery_dispute = true,
          delivery_dispute_reason = $1,
          delivery_status = 'dispute',
          updated_at = NOW()
      WHERE id = $2 AND customer_id = $3
      RETURNING *
    `, [reason, orderId, customerId]);

    if (result.rows.length > 0) {
      await pool.query(`
        UPDATE delivery_records
        SET dispute = true,
            dispute_reason = $1,
            status = 'dispute'
        WHERE order_id = $2
      `, [reason, orderId]);
    }

    return result.rows[0] || null;
  }

  /**
   * Get order with business name
   */
  static async getOrderWithBusiness(orderId) {
    const result = await pool.query(`
      SELECT o.*, c.name AS customer_name, c.email AS customer_email,
             b.business_name, b.location as business_location,
             b.phone as business_phone, b.email as business_email
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN businesses b ON o.business_id = b.id
      WHERE o.id = $1
    `, [orderId]);
    return result.rows[0] || null;
  }
}

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

module.exports = Order;