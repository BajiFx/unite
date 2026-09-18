// ============================================================
//  CONTACT ADMIN ROUTES
//  Location: src/routes/contact-admin.js
//
//  Purpose:
//   Give customers and businesses a direct way to send a message
//   to the platform super admin. This is the public side of the
//   Complaints Inbox. The admin side lives in src/routes/admin.js.
//
//  Endpoints:
//    POST   /api/contact-admin/send          — send a message
//    GET    /api/contact-admin/mine          — list my own messages
//    GET    /api/contact-admin/mine/:id      — read one of my messages
//
//  Design notes:
//   - Authentication: authMiddleware, so both customers and
//     business admins can use these routes. The role decides
//     which side of the inbox the message lands on.
//   - sender_type is derived from the caller's role, never from
//     the body. A customer cannot impersonate a business, and
//     vice versa.
//   - sender_id is the customer id for a customer, or the
//     business id for a business admin.
//   - sender_label is captured at send time so the admin can
//     still read the message after an account is anonymised
//     (Section 11.A / 11.B).
//   - related_order_id is validated against the caller's own
//     records so a customer cannot attach a stranger's order.
//   - related_business_id is validated the same way.
//   - Every message starts in status 'unread'.
//   - Rate limiting is applied with the shared sensitiveLimiter
//     from src/middleware/rateLimiter.js.
//   - A Socket.IO event is emitted on send so the admin dashboard
//     badge updates live.
// ============================================================

const express = require('express');
const { body, validationResult } = require('express-validator');
const { pool, logError } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const { sensitiveLimiter } = require('../middleware/rateLimiter');
const { logAdminActivity } = require('../services/orderService');
const router = express.Router();

// ============================================================
//  CONSTANTS
// ============================================================

const MAX_SUBJECT_LENGTH = 255;
const MAX_BODY_LENGTH = 5000;
const MAX_CATEGORY_LENGTH = 80;
const MAX_ATTACHMENT_URL_LENGTH = 500;

const ALLOWED_CATEGORIES = new Set([
  'Order problem',
  'Payment issue',
  'Delivery issue',
  'Return or refund',
  'Report a business',
  'Report a customer',
  'Account issue',
  'Product quality',
  'Other'
]);

// ============================================================
//  HELPERS
// ============================================================

function trimOrNull(value, max) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (str === '') return null;
  return max ? str.slice(0, max) : str;
}

/**
 * Resolve the caller's sender_type and sender_id.
 *
 * Returns { ok: true, senderType, senderId, senderLabel } or
 * { ok: false, error, status }.
 *
 * - A customer resolves to sender_type = 'customer' and
 *   sender_id = customer.id.
 * - A business admin resolves to sender_type = 'business' and
 *   sender_id = admin.business_id.
 * - A super admin cannot send a complaint to themselves.
 */
async function resolveSender(req) {
  const role = req.role;

  if (role === 'customer') {
    const customerId = Number(req.userId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return { ok: false, error: 'Invalid customer session', status: 400 };
    }

    const result = await pool.query(
      'SELECT id, name, email, phone FROM customers WHERE id = $1',
      [customerId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: 'Customer not found', status: 404 };
    }
    const customer = result.rows[0];

    return {
      ok: true,
      senderType: 'customer',
      senderId: customer.id,
      senderLabel: customer.name || customer.email || customer.phone || `Customer #${customer.id}`
    };
  }

  if (role === 'business_admin') {
    const adminId = Number(req.userId);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return { ok: false, error: 'Invalid business admin session', status: 400 };
    }

    const adminResult = await pool.query(
      'SELECT id, email, business_id FROM admin_users WHERE id = $1',
      [adminId]
    );
    if (adminResult.rows.length === 0) {
      return { ok: false, error: 'Admin user not found', status: 404 };
    }
    const admin = adminResult.rows[0];

    if (!admin.business_id) {
      return { ok: false, error: 'This admin account is not linked to any business', status: 403 };
    }

    const bizResult = await pool.query(
      'SELECT id, business_name, email, phone FROM businesses WHERE id = $1',
      [admin.business_id]
    );
    if (bizResult.rows.length === 0) {
      return { ok: false, error: 'Business not found', status: 404 };
    }
    const business = bizResult.rows[0];

    return {
      ok: true,
      senderType: 'business',
      senderId: business.id,
      senderLabel: business.business_name || business.email || `Business #${business.id}`
    };
  }

  return {
    ok: false,
    error: 'Only customers and business admins can send messages to the platform admin.',
    status: 403
  };
}

/**
 * Validate related_order_id against the caller's own records.
 * A customer can only attach one of their own orders.
 * A business can only attach one of their own business's orders.
 */
async function validateRelatedOrder(sender, rawOrderId) {
  const orderId = Number.parseInt(rawOrderId, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { ok: false, error: 'Invalid related order id' };
  }

  if (sender.senderType === 'customer') {
    const result = await pool.query(
      'SELECT id FROM orders WHERE id = $1 AND customer_id = $2',
      [orderId, sender.senderId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: 'That order does not belong to you' };
    }
  } else {
    const result = await pool.query(
      'SELECT id FROM orders WHERE id = $1 AND business_id = $2',
      [orderId, sender.senderId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: 'That order does not belong to your business' };
    }
  }

  return { ok: true, orderId };
}

/**
 * Validate related_business_id against the caller's own records.
 * Only a customer attaches a business id. A business admin never
 * does, because they are the business.
 */
async function validateRelatedBusiness(sender, rawBusinessId) {
  const businessId = Number.parseInt(rawBusinessId, 10);
  if (!Number.isInteger(businessId) || businessId <= 0) {
    return { ok: false, error: 'Invalid related business id' };
  }

  if (sender.senderType !== 'customer') {
    return { ok: false, error: 'Only customers can attach a related business' };
  }

  const result = await pool.query(
    'SELECT id FROM businesses WHERE id = $1',
    [businessId]
  );
  if (result.rows.length === 0) {
    return { ok: false, error: 'Business not found' };
  }

  return { ok: true, businessId };
}

function validateCategory(rawCategory) {
  const category = trimOrNull(rawCategory, MAX_CATEGORY_LENGTH);
  if (!category) return { ok: true, category: null };
  if (!ALLOWED_CATEGORIES.has(category)) {
    return { ok: false, error: 'Invalid category' };
  }
  return { ok: true, category };
}

function validateAttachmentUrl(raw) {
  const url = trimOrNull(raw, MAX_ATTACHMENT_URL_LENGTH);
  if (!url) return { ok: true, url: null };
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Attachment URL must start with http:// or https://' };
  }
  return { ok: true, url };
}

// ============================================================
//  POST /api/contact-admin/send
//  Send a message to the super admin.
//
//  Body:
//    subject           (required, 3..255)
//    body              (required, 10..5000)
//    category          (optional, one of the allowed list)
//    related_order_id  (optional, integer)
//    related_business_id (optional, integer, customers only)
//    attachment_url    (optional, http(s) URL)
// ============================================================

router.post(
  '/send',
  authMiddleware,
  sensitiveLimiter,
  [
    body('subject').trim().isLength({ min: 3, max: MAX_SUBJECT_LENGTH })
      .withMessage(`Subject must be ${MAX_SUBJECT_LENGTH} characters or fewer and at least 3`),
    body('body').trim().isLength({ min: 10, max: MAX_BODY_LENGTH })
      .withMessage(`Message must be ${MAX_BODY_LENGTH} characters or fewer and at least 10`)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const senderResult = await resolveSender(req);
      if (!senderResult.ok) {
        return res.status(senderResult.status).json({ error: senderResult.error });
      }
      const sender = senderResult;

      const subject = trimOrNull(req.body.subject, MAX_SUBJECT_LENGTH);
      const bodyText = trimOrNull(req.body.body, MAX_BODY_LENGTH);

      if (!subject || !bodyText) {
        return res.status(400).json({ error: 'Subject and message are required' });
      }

      const categoryResult = validateCategory(req.body.category);
      if (!categoryResult.ok) {
        return res.status(400).json({ error: categoryResult.error });
      }

      const attachmentResult = validateAttachmentUrl(req.body.attachment_url);
      if (!attachmentResult.ok) {
        return res.status(400).json({ error: attachmentResult.error });
      }

      let relatedOrderId = null;
      if (req.body.related_order_id !== undefined && req.body.related_order_id !== null && req.body.related_order_id !== '') {
        const orderResult = await validateRelatedOrder(sender, req.body.related_order_id);
        if (!orderResult.ok) {
          return res.status(400).json({ error: orderResult.error });
        }
        relatedOrderId = orderResult.orderId;
      }

      let relatedBusinessId = null;
      if (req.body.related_business_id !== undefined && req.body.related_business_id !== null && req.body.related_business_id !== '') {
        const bizResult = await validateRelatedBusiness(sender, req.body.related_business_id);
        if (!bizResult.ok) {
          return res.status(400).json({ error: bizResult.error });
        }
        relatedBusinessId = bizResult.businessId;
      }

      const result = await pool.query(`
        INSERT INTO admin_messages (
          sender_type, sender_id, sender_label,
          subject, body, category,
          related_order_id, related_business_id,
          attachment_url, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'unread')
        RETURNING id, created_at
      `, [
        sender.senderType,
        sender.senderId,
        sender.senderLabel,
        subject,
        bodyText,
        categoryResult.category,
        relatedOrderId,
        relatedBusinessId,
        attachmentResult.url
      ]);

      const inserted = result.rows[0];

      // Notify the admin dashboard so the Complaints badge updates
      // without a reload.
      const io = req.app.get('io');
      if (io) {
        io.emit('admin-message-received', {
          id: inserted.id,
          sender_type: sender.senderType,
          sender_label: sender.senderLabel,
          subject,
          created_at: inserted.created_at
        });
      }

      await logAdminActivity(req.userId, 'CONTACT_ADMIN_SEND', {
        messageId: inserted.id,
        sender_type: sender.senderType,
        sender_id: sender.senderId
      });

      res.status(201).json({
        success: true,
        message_id: inserted.id,
        created_at: inserted.created_at,
        message: 'Your message has been sent to the platform admin. You will see a reply here when they respond.'
      });
    } catch (err) {
      console.error('❌ Contact admin send error:', err);
      logError(err, 'Contact admin send');
      res.status(500).json({ error: 'Unable to send your message right now' });
    }
  }
);

// ============================================================
//  GET /api/contact-admin/mine
//  List the caller's own messages to the admin.
//  A customer sees their own; a business admin sees the
//  business's own messages.
// ============================================================

router.get('/mine', authMiddleware, async (req, res) => {
  try {
    const senderResult = await resolveSender(req);
    if (!senderResult.ok) {
      return res.status(senderResult.status).json({ error: senderResult.error });
    }
    const sender = senderResult;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const result = await pool.query(`
      SELECT
        id,
        subject,
        body,
        category,
        related_order_id,
        related_business_id,
        attachment_url,
        status,
        admin_reply,
        replied_at,
        escalated_to_violation_id,
        created_at,
        updated_at
      FROM admin_messages
      WHERE sender_type = $1 AND sender_id = $2
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4
    `, [sender.senderType, sender.senderId, limit, offset]);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM admin_messages
        WHERE sender_type = $1 AND sender_id = $2`,
      [sender.senderType, sender.senderId]
    );

    res.json({
      messages: result.rows,
      total: countResult.rows[0].total,
      limit,
      offset
    });
  } catch (err) {
    console.error('❌ Contact admin mine error:', err);
    logError(err, 'Contact admin mine');
    res.status(500).json({ error: 'Unable to load your messages' });
  }
});

// ============================================================
//  GET /api/contact-admin/mine/:id
//  Read one of the caller's own messages.
//  A customer can only read their own; a business admin can only
//  read the business's own.
// ============================================================

router.get('/mine/:id', authMiddleware, async (req, res) => {
  try {
    const senderResult = await resolveSender(req);
    if (!senderResult.ok) {
      return res.status(senderResult.status).json({ error: senderResult.error });
    }
    const sender = senderResult;

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid message id' });
    }

    const result = await pool.query(`
      SELECT
        id,
        subject,
        body,
        category,
        related_order_id,
        related_business_id,
        attachment_url,
        status,
        admin_reply,
        replied_at,
        escalated_to_violation_id,
        created_at,
        updated_at
      FROM admin_messages
      WHERE id = $1 AND sender_type = $2 AND sender_id = $3
    `, [id, sender.senderType, sender.senderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: result.rows[0] });
  } catch (err) {
    console.error('❌ Contact admin mine/:id error:', err);
    logError(err, 'Contact admin mine/:id');
    res.status(500).json({ error: 'Unable to load that message' });
  }
});

module.exports = router;