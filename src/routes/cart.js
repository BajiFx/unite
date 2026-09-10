const express = require('express');
const { pool, logError } = require('../config/database');
const { authMiddleware, customerOnly } = require('../middleware/auth');
const router = express.Router();

// ============================================================
//  GET CART - FIXED: Proper auth handling
// ============================================================

router.get('/', authMiddleware, customerOnly, async (req, res) => {
  try {
    console.log('🛒 GET Cart - User:', req.userId);

    // Ensure userId is valid
    if (!req.userId || req.userId === req.email) {
      console.warn('⚠️ Invalid userId in cart request:', req.userId);
      return res.json({ items: [], business_id: null });
    }

    const result = await pool.query('SELECT items, reserved_until FROM carts WHERE customer_id = $1', [req.userId]);
    if (result.rows.length === 0) {
      await pool.query(
        'INSERT INTO carts (customer_id, items) VALUES ($1, $2)',
        [req.userId, '[]']
      );
      return res.json({ items: [], business_id: null });
    }
    const row = result.rows[0];
    let items = row.items || [];
    if (typeof items === 'string') items = JSON.parse(items);

    let businessId = null;
    if (items.length > 0) {
      const businessIds = [...new Set(items.map(item => item.business_id))];
      if (businessIds.length === 1) {
        businessId = businessIds[0];
      }
    }

    if (row.reserved_until && new Date() > new Date(row.reserved_until)) {
      await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', req.userId]);
      return res.json({ items: [], business_id: null });
    }

    res.json({ items, business_id: businessId });
  } catch (err) {
    console.error('❌ Cart GET error:', err);
    logError(err, 'Cart GET');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE CART
// ============================================================

router.put('/', authMiddleware, customerOnly, async (req, res) => {
  try {
    if (!req.userId || req.userId === req.email) {
      return res.status(401).json({ error: 'Invalid user session' });
    }

    const { items } = req.body;

    let businessId = null;
    let allValid = true;
    const errors = [];

    for (const item of items) {
      if (!item.business_id) {
        try {
          const productResult = await pool.query(
            'SELECT business_id FROM products WHERE id = $1',
            [item.id]
          );
          if (productResult.rows.length > 0 && productResult.rows[0].business_id) {
            item.business_id = productResult.rows[0].business_id;
          } else {
            errors.push(`Product "${item.name}" has no business`);
            allValid = false;
          }
        } catch (err) {
          errors.push(`Error checking product "${item.name}"`);
          allValid = false;
        }
      }

      if (item.business_id) {
        if (!businessId) {
          businessId = item.business_id;
        } else if (businessId !== item.business_id) {
          errors.push(`All items must be from the same business. "${item.name}" is from a different business.`);
          allValid = false;
        }
      }
    }

    if (!allValid) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const reservedUntil = new Date(Date.now() + 15 * 60 * 1000);

    const cleanItems = items.map(item => ({
      id: item.id,
      variant_id: item.variant_id || null,
      name: item.name,
      price: item.price,
      image: item.image || '',
      quantity: item.quantity,
      variant_name: item.variant_name || 'Default',
      business_id: item.business_id
    }));

    await pool.query(
      `INSERT INTO carts (customer_id, items, reserved_until)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id)
       DO UPDATE SET items = $2, reserved_until = $3, updated_at = NOW()`,
      [req.userId, JSON.stringify(cleanItems), reservedUntil]
    );

    res.json({
      success: true,
      reserved_until: reservedUntil,
      business_id: businessId
    });
  } catch (err) {
    console.error('❌ Cart PUT error:', err);
    logError(err, 'Cart PUT');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CLEAR CART
// ============================================================

router.delete('/', authMiddleware, customerOnly, async (req, res) => {
  try {
    if (!req.userId || req.userId === req.email) {
      return res.status(401).json({ error: 'Invalid user session' });
    }
    await pool.query('UPDATE carts SET items = $1, reserved_until = NULL WHERE customer_id = $2', ['[]', req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Cart DELETE error:', err);
    logError(err, 'Cart DELETE');
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  ADD ITEM TO CART
// ============================================================

router.post('/add', authMiddleware, customerOnly, async (req, res) => {
  try {
    if (!req.userId || req.userId === req.email) {
      return res.status(401).json({ error: 'Invalid user session' });
    }

    const { product_id, variant_id, quantity = 1 } = req.body;

    const productResult = await pool.query(
      'SELECT id, name, price, image, business_id FROM products WHERE id = $1 AND is_active = true',
      [product_id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];
    const businessId = product.business_id;

    if (!businessId) {
      return res.status(400).json({ error: 'Product has no associated business' });
    }

    const businessCheck = await pool.query(
      'SELECT is_active, online_orders_enabled FROM businesses WHERE id = $1',
      [businessId]
    );

    if (businessCheck.rows.length === 0 || !businessCheck.rows[0].is_active) {
      return res.status(400).json({ error: 'Business is not active' });
    }

    if (!businessCheck.rows[0].online_orders_enabled) {
      return res.status(400).json({ error: 'Business is not accepting orders' });
    }

    let variantName = 'Default';
    let variantPrice = product.price;
    let variantImage = product.image;

    if (variant_id) {
      const variantResult = await pool.query(
        'SELECT name, price, image FROM product_variants WHERE id = $1 AND product_id = $2',
        [variant_id, product_id]
      );
      if (variantResult.rows.length > 0) {
        variantName = variantResult.rows[0].name || 'Default';
        variantPrice = variantResult.rows[0].price || product.price;
        variantImage = variantResult.rows[0].image || product.image;
      }
    }

    const cartResult = await pool.query(
      'SELECT items FROM carts WHERE customer_id = $1',
      [req.userId]
    );

    let items = [];
    if (cartResult.rows.length > 0 && cartResult.rows[0].items) {
      items = typeof cartResult.rows[0].items === 'string'
        ? JSON.parse(cartResult.rows[0].items)
        : cartResult.rows[0].items;
    }

    if (items.length > 0) {
      const existingBusinessId = items[0].business_id;
      if (existingBusinessId && existingBusinessId !== businessId) {
        return res.status(400).json({
          error: 'You already have items from another business in your cart. Please clear your cart first.'
        });
      }
    }

    const existingIndex = items.findIndex(item =>
      item.id === product_id && item.variant_id === variant_id
    );

    if (existingIndex > -1) {
      items[existingIndex].quantity += quantity;
    } else {
      items.push({
        id: product_id,
        variant_id: variant_id,
        name: product.name,
        price: variantPrice,
        image: variantImage || product.image || '',
        quantity: quantity,
        variant_name: variantName,
        business_id: businessId
      });
    }

    const reservedUntil = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      `INSERT INTO carts (customer_id, items, reserved_until)
       VALUES ($1, $2, $3)
       ON CONFLICT (customer_id)
       DO UPDATE SET items = $2, reserved_until = $3, updated_at = NOW()`,
      [req.userId, JSON.stringify(items), reservedUntil]
    );

    res.json({
      success: true,
      item: items[existingIndex > -1 ? existingIndex : items.length - 1],
      business_id: businessId,
      cart_count: items.reduce((sum, i) => sum + i.quantity, 0)
    });
  } catch (err) {
    console.error('❌ Cart add error:', err);
    logError(err, 'Cart add');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;