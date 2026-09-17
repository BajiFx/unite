// ============================================================
//  PRODUCTS ROUTES - COMPLETE MULTI-VENDOR VERSION
//  Location: src/routes/products.js
//
//  B.1 — product_category_id is required on create/update
//  B.5 — Save blocked without a valid product category
//  B.7 — Category returned on product detail (and related items)
//  B.8 — Joined category name/slug returned on every product list
//
//  Section H — Product detail now returns the two business fields
//  the frontend needs to honour the paused-orders state:
//    • b.online_orders_enabled
//    • b.order_disabled_message
//  These are added to the joined SELECT in GET /:id/detail only.
//  The marketplace list and related-products queries intentionally
//  stay as-is so the change is surgical and the list payloads
//  remain lean.
//
//  "You may also like" (this revision):
//   The related-products query in GET /:id/detail has been changed
//   so that:
//     • Every other active product of the same business is returned,
//       up to a safety cap of 400 (was LIMIT 6, then 60).
//     • Products that share the viewed product's product_category_id
//       are sorted FIRST.
//     • Every other sibling follows.
//     • Inside each group, newest first (created_at DESC).
//
//   The frontend (public/js/product-detail.js) also calls
//   orderRelatedForDisplay() as a defensive sort, so the customer
//   sees the same-category-first order even if the server ever
//   returns unsorted data.
//
//  PHASE 1 / PHASE 2 — Product variants and the two-axis detail
//   The `GET /:id/detail` handler now:
//     - resolves variants through variantService.listActiveVariants()
//       so the inheritance chain (variant → parent) is applied in
//       one place and every variant carries media_kind;
//     - returns an `axis` object from variantService.getAxis() so
//       the client can label the vertical counter and the vertical
//       hints without guessing from the variant names;
//     - keeps the existing `product`, `related`, and `reviews`
//       shapes unchanged, so the frontend needs no other change.
//
//   The `GET /` handler now attaches a resolved `thumbnail_url` and
//   `thumbnail_kind` to each product, using the same fallback chain
//   that businesses.js uses in GET /:slug/products, so both listing
//   surfaces stay consistent.
//
//   Every other route and helper is preserved byte-for-byte.
// ============================================================

const express = require('express');
const fs = require('fs');
const { body, validationResult } = require('express-validator');
const { pool } = require('../config/database');
const { authMiddleware, businessAdminOnly, getBusinessIdFromToken } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { uploadToCloudinary } = require('../config/cloudinary');
const { cacheMiddleware } = require('../../redis');
const { logAdminActivity } = require('../services/orderService');
// Phase 1 / Phase 2 — variant resolution for the product detail
// page and the general product listing. The service owns every
// read from product_variants, so no route in this file queries
// that table directly except the batch endpoint that already
// existed.
const variantService = require('../services/variantService');
const router = express.Router();

// ============================================================
//  Small helper — deterministic fallback image
//
//  Used when a product has no image of its own and no variant
//  provides one either. This keeps the response shape consistent
//  and never sends a null image to the client.
// ============================================================

function productFallbackImage(name) {
  const label = String(name || 'Product').slice(0, 32).replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e2e8f0"/><text x="50%" y="46%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="34" fill="#475569">Product image</text><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="24" fill="#64748b">${label}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// ============================================================
//  GET ALL PRODUCTS (Public - with business filter)
//  B.8 — joined product category name/slug/icon
//
//  PHASE 1 / PHASE 2 — each product now carries a resolved
//  thumbnail_url and thumbnail_kind. Variants are resolved through
//  variantService so the inheritance chain is applied consistently
//  with every other listing surface.
// ============================================================

router.get('/', cacheMiddleware(60), async (req, res) => {
  try {
    const { search, limit, category, product_category_id, business_slug } = req.query;

    let query = `
      SELECT p.*,
             pc.name AS product_category_name,
             pc.slug AS product_category_slug,
             pc.icon AS product_category_icon
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
    `;
    let params = [];
    let conditions = ['p.is_active = true'];
    let paramIndex = 1;

    if (business_slug) {
      query += ` JOIN businesses b ON p.business_id = b.id`;
      conditions.push(`b.slug = $${paramIndex}`);
      params.push(business_slug);
      paramIndex++;
    }

    if (search) {
      conditions.push(`p.name ILIKE $${paramIndex}`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category && category !== 'all') {
      conditions.push(`p.category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (product_category_id) {
      conditions.push(`p.product_category_id = $${paramIndex}`);
      params.push(parseInt(product_category_id, 10));
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY p.created_at DESC';

    if (limit) {
      query += ' LIMIT $' + paramIndex;
      params.push(parseInt(limit));
      paramIndex++;
    }

    const result = await pool.query(query, params);

    const products = [];
    for (const product of result.rows) {
      try {
        // Phase 1 — resolve variants through the service so the
        // inheritance chain and media_kind are consistent with
        // the shop page and the detail page.
        let variants = [];
        try {
          variants = await variantService.listActiveVariants(product.id);
        } catch (variantErr) {
          console.warn(
            `Unable to load variants for product ${product.id}:`,
            variantErr.message
          );
        }

        // Resolve the grid thumbnail. Chain: variant media →
        // parent image → parent video poster → fallback SVG.
        const firstVariantWithImage = variants.find(v => v.image);
        const firstVariantWithVideo = variants.find(v => v.video_poster_url || v.video);

        let thumbnailUrl = null;
        let thumbnailKind = 'placeholder';

        if (product.image) {
          thumbnailUrl = product.image;
          thumbnailKind = 'image';
        } else if (product.video_poster_url) {
          thumbnailUrl = product.video_poster_url;
          thumbnailKind = 'video';
        } else if (firstVariantWithImage && firstVariantWithImage.image) {
          thumbnailUrl = firstVariantWithImage.image;
          thumbnailKind = 'image';
        } else if (firstVariantWithVideo && firstVariantWithVideo.video_poster_url) {
          thumbnailUrl = firstVariantWithVideo.video_poster_url;
          thumbnailKind = 'video';
        }

        if (!thumbnailUrl) {
          thumbnailUrl = productFallbackImage(product.name);
          thumbnailKind = 'placeholder';
        }

        // media_kind describes the product as a whole.
        let mediaKind = 'placeholder';
        const anyImage = variants.some(v => v.image) || Boolean(product.image);
        const anyVideo = variants.some(v => v.video) || Boolean(product.video);
        if (anyImage && anyVideo) mediaKind = 'mixed';
        else if (anyVideo) mediaKind = 'video';
        else if (anyImage) mediaKind = 'image';

        // Preserve the older total-stock calculation so nothing
        // downstream changes behaviour. The service already
        // resolved stock per variant through the inheritance
        // chain, so the sum is the same as it always was when
        // variants had their own stock.
        let totalStock = 0;
        variants.forEach(v => { totalStock += parseInt(v.stock) || 0; });

        const businessResult = await pool.query(
          'SELECT business_name, slug FROM businesses WHERE id = $1',
          [product.business_id]
        );
        const business = businessResult.rows[0] || null;

        products.push({
          ...product,
          variants: variants,
          image: thumbnailUrl,
          thumbnail_url: thumbnailUrl,
          thumbnail_kind: thumbnailKind,
          media_kind: mediaKind,
          stock: totalStock || parseInt(product.stock) || 0,
          business: business
        });
      } catch (variantErr) {
        console.error('Error fetching variants for product:', product.id, variantErr);
        const fallbackUrl = product.image || productFallbackImage(product.name);
        products.push({
          ...product,
          variants: [],
          image: fallbackUrl,
          thumbnail_url: fallbackUrl,
          thumbnail_kind: product.image ? 'image' : 'placeholder',
          media_kind: product.image ? 'image' : 'placeholder',
          stock: parseInt(product.stock) || 0
        });
      }
    }

    res.json(products);
  } catch (err) {
    console.error('❌ Products error:', err);
    res.status(500).json({
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
//  GET ALL VARIANTS (Batch)
//
//  Kept as-is. This endpoint predates Phase 1 and is preserved
//  byte-for-byte. New callers use the per-product resolution
//  in GET /:id/detail instead.
// ============================================================

router.get('/variants/batch', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_variants ORDER BY product_id, id');
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Variants batch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GET PRODUCT DETAIL (Public)
//
//  B.7 — returned product carries its category
//  H  — returned product also carries the business's order-
//       visibility fields (online_orders_enabled and
//       order_disabled_message) so the product detail page can
//       render the paused-orders banner and disable the cart
//       controls when the business has paused orders.
//
//  "You may also like" (this revision):
//   The related query now returns every other active product of
//   the same business, up to a safety cap of 400. Same-category
//   siblings are sorted FIRST, then every other sibling follows.
//   Inside each group, newest first (created_at DESC).
//
//  PHASE 1 / PHASE 2:
//   - variants are resolved through variantService so the
//     inheritance chain and media_kind are applied in one place;
//   - an `axis` object is returned so the client can label the
//     vertical counter and the vertical hints.
// ============================================================

router.get('/:id/detail', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const productResult = await pool.query(`
      SELECT p.*,
             pc.name AS product_category_name,
             pc.slug AS product_category_slug,
             pc.icon AS product_category_icon,
             b.business_name, b.slug as business_slug,
             b.whatsapp AS business_whatsapp, b.tiktok AS business_tiktok,
             b.instagram AS business_instagram, b.facebook AS business_facebook,
             b.phone AS business_phone, b.email AS business_email,
             b.website AS business_website,
             b.online_orders_enabled,
             b.order_disabled_message
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      LEFT JOIN businesses b ON p.business_id = b.id
      WHERE p.id = $1 AND p.is_active = true
    `, [id]);

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];

    // Phase 1 — resolve variants through the service. The service
    // applies the inheritance chain (variant → parent) and sets
    // media_kind on every variant, so the client never walks the
    // chain itself. On failure, fall back to a direct read so the
    // page still renders.
    let variants = [];
    try {
      variants = await variantService.listActiveVariants(id);
    } catch (variantErr) {
      console.warn('Variant resolution failed, falling back to raw rows:', variantErr.message);
      try {
        const fallback = await pool.query(
          'SELECT * FROM product_variants WHERE product_id = $1 AND is_active = TRUE ORDER BY display_order ASC, id ASC',
          [id]
        );
        variants = fallback.rows || [];
      } catch (fallbackErr) {
        variants = [];
      }
    }

    // Phase 2 — axis metadata for the vertical counter and hints.
    // When the product has one variant, count is 1 and the client
    // hides the vertical hints. When the variant table is missing
    // entirely, the service returns a safe default.
    let axis = { kind: null, label: null, count: variants.length };
    try {
      axis = await variantService.getAxis(id);
    } catch (axisErr) {
      console.warn('Axis resolution failed, using default:', axisErr.message);
    }

    const reviewsResult = await pool.query(`
      SELECT pr.*, c.name AS customer_name
      FROM product_reviews pr
      LEFT JOIN customers c ON pr.customer_id = c.id
      WHERE pr.product_id = $1
      ORDER BY pr.created_at DESC
      LIMIT 20
    `, [id]);
    const reviews = reviewsResult.rows || [];

    // ------------------------------------------------------------
    //  Related products — "You may also like"
    //
    //  Every other active product of the same business, up to 400.
    //  Same-category siblings first, then the rest, newest first
    //  inside each group.
    //
    //  The `CASE` expression uses $3 = the viewed product's
    //  product_category_id. When the viewed product has no
    //  defined category, $3 is NULL and the CASE evaluates to 1
    //  for every row, so the ordering falls back to created_at
    //  DESC alone — exactly the pre-existing behaviour.
    // ------------------------------------------------------------
    const relatedResult = await pool.query(`
      SELECT p.*,
             pc.name AS product_category_name,
             pc.slug AS product_category_slug,
             pc.icon AS product_category_icon
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id != $1
        AND p.business_id = $2
        AND p.is_active = true
      ORDER BY
        CASE
          WHEN p.product_category_id IS NOT NULL
           AND p.product_category_id = $3
          THEN 0
          ELSE 1
        END,
        p.created_at DESC
      LIMIT 400
    `, [id, product.business_id, product.product_category_id || null]);

    const related = [];
    for (const rel of relatedResult.rows) {
      // Phase 1 — use the service so the image resolution follows
      // the inheritance chain. A variant that carries no image of
      // its own now correctly falls back to the product image,
      // instead of overriding it with null.
      let relatedImage = rel.image || null;
      try {
        const relVariants = await variantService.listActiveVariants(rel.id);
        const firstWithImage = relVariants.find(v => v.image);
        if (firstWithImage && firstWithImage.image) {
          relatedImage = firstWithImage.image;
        }
      } catch (relVariantErr) {
        // Fall back to the raw read used previously.
        try {
          const vRes = await pool.query(
            'SELECT image FROM product_variants WHERE product_id = $1 LIMIT 1',
            [rel.id]
          );
          const variant = vRes.rows[0] || null;
          if (variant?.image) relatedImage = variant.image;
        } catch (rawErr) {
          // Keep the product image.
        }
      }

      related.push({
        ...rel,
        image: relatedImage
      });
    }

    res.json({
      product,
      variants,
      axis,
      reviews,
      related
    });
  } catch (err) {
    console.error('❌ Product detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  CREATE PRODUCT (Business Admin only)
//  B.1 / B.5 — product_category_id is required and validated
//
//  NOTE: The business-admin product creation flow in
//  src/routes/business-admin.js is the one the admin panel uses.
//  This endpoint is kept for backward compatibility and is
//  preserved byte-for-byte. The variant save still uses the
//  legacy inline INSERT, because this endpoint is not on the
//  Phase 1 code path.
// ============================================================

router.post('/', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
  upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
  body('name').trim().escape().isLength({ min: 2 }).withMessage('Product name must be at least 2 characters'),
  body('price').trim().escape().isNumeric().withMessage('Price must be a number'),
  body('product_category_id').notEmpty().withMessage('Please select a product category'),
  body('description').optional().trim().escape(),
  body('category').optional().trim().escape()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const businessId = req.businessId;

    const {
      name, price, category, product_category_id, contact, rating, badge1, badge2, shipping,
      isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible,
      return_enabled, return_window_days, restocking_fee_percent,
      return_shipping_paid_by, return_condition, variants, old_price,
      discount_percent, stock, is_featured
    } = req.body;

    const productCategoryId = parseInt(product_category_id, 10);
    if (!Number.isInteger(productCategoryId)) {
      return res.status(400).json({ error: 'Please select a product category' });
    }

    const categoryCheck = await pool.query(
      'SELECT id FROM product_categories WHERE id = $1 AND is_active = true',
      [productCategoryId]
    );
    if (categoryCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Selected product category does not exist or is not active' });
    }

    let mainImage = null;
    if (req.files && req.files['image'] && req.files['image'][0]) {
      const file = req.files['image'][0];
      mainImage = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      INSERT INTO products (
        name, price, old_price, discount_percent, category, product_category_id,
        contact, rating,
        badge1, badge2, shipping, isFlashSale, isNewArrival, image, description,
        shipping_fee, free_shipping_eligible, return_enabled, return_window_days,
        restocking_fee_percent, return_shipping_paid_by, return_condition,
        stock, is_featured, business_id, is_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
      RETURNING *
    `, [
      name, price, old_price || null, discount_percent || null, category, productCategoryId,
      contact, rating,
      badge1 || null, badge2 || null, shipping || null,
      isFlashSale === 'true' || isFlashSale === true,
      isNewArrival === 'true' || isNewArrival === true,
      mainImage, description || null,
      shipping_fee || null, free_shipping_eligible === 'true' || free_shipping_eligible === true,
      return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0,
      return_shipping_paid_by || 'buyer', return_condition || 'unopened',
      stock || 0, is_featured === 'true' || is_featured === true,
      businessId, true
    ]);

    const product = result.rows[0];

    if (variants && typeof variants === 'string') {
      try {
        const variantData = JSON.parse(variants);
        const variantImages = (req.files && req.files['variantImages']) || [];
        for (let i = 0; i < variantData.length; i++) {
          const v = variantData[i];
          let variantImage = null;
          if (variantImages[i]) {
            variantImage = await uploadToCloudinary(variantImages[i].path);
            fs.unlink(variantImages[i].path, (err) => { if (err) console.error('Failed to delete local file:', err); });
          }
          await pool.query(
            `INSERT INTO product_variants (product_id, name, price, stock, image, color_code)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [product.id, v.name, v.price || price, v.stock || 0, variantImage, v.color_code || null]
          );
        }
      } catch (variantErr) {
        console.error('Error adding variants:', variantErr);
      }
    }

    await logAdminActivity(req.userId, 'CREATE_PRODUCT', { productId: product.id, businessId });

    const enriched = await pool.query(`
      SELECT p.*, pc.name AS product_category_name, pc.slug AS product_category_slug
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id = $1
    `, [product.id]);

    res.json({ success: true, product: enriched.rows[0] || product });
  } catch (err) {
    console.error('❌ Create product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  UPDATE PRODUCT (Business Admin only)
//  B.1 / B.5 — product_category_id is required and validated
//
//  NOTE: Same as the create handler above — the business-admin
//  flow in src/routes/business-admin.js is the one the admin panel
//  uses. This endpoint is kept for backward compatibility and is
//  preserved byte-for-byte.
// ============================================================

router.put('/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken,
  upload.fields([{ name: 'image' }, { name: 'variantImages' }]), [
  body('name').trim().escape().isLength({ min: 2 }).withMessage('Product name must be at least 2 characters'),
  body('price').trim().escape().isNumeric().withMessage('Price must be a number')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const existing = await pool.query(
      'SELECT * FROM products WHERE id = $1 AND business_id = $2',
      [id, req.businessId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found in your business' });
    }
    const oldProduct = existing.rows[0];

    const {
      name, price, category, product_category_id, contact, rating, badge1, badge2, shipping,
      isFlashSale, isNewArrival, description, shipping_fee, free_shipping_eligible,
      return_enabled, return_window_days, restocking_fee_percent,
      return_shipping_paid_by, return_condition, variants, old_price,
      discount_percent, stock, is_featured
    } = req.body;

    let productCategoryId = null;
    if (product_category_id !== undefined && product_category_id !== '') {
      productCategoryId = parseInt(product_category_id, 10);
      if (!Number.isInteger(productCategoryId)) {
        return res.status(400).json({ error: 'Please select a product category' });
      }
      const categoryCheck = await pool.query(
        'SELECT id FROM product_categories WHERE id = $1 AND is_active = true',
        [productCategoryId]
      );
      if (categoryCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Selected product category does not exist or is not active' });
      }
    } else if (!oldProduct.product_category_id) {
      return res.status(400).json({ error: 'Please select a product category' });
    }

    let image = oldProduct.image;
    if (req.files && req.files['image'] && req.files['image'][0]) {
      const file = req.files['image'][0];
      image = await uploadToCloudinary(file.path);
      fs.unlink(file.path, (err) => { if (err) console.error('Failed to delete local file:', err); });
    }

    const result = await pool.query(`
      UPDATE products
      SET name = $1, price = $2, old_price = $3, discount_percent = $4, category = $5,
          product_category_id = COALESCE($6, product_category_id),
          contact = $7, rating = $8, badge1 = $9, badge2 = $10, shipping = $11,
          isFlashSale = $12, isNewArrival = $13, image = $14, description = $15,
          shipping_fee = $16, free_shipping_eligible = $17,
          return_enabled = $18, return_window_days = $19, restocking_fee_percent = $20,
          return_shipping_paid_by = $21, return_condition = $22, stock = $23,
          is_featured = COALESCE($24, is_featured)
      WHERE id = $25 AND business_id = $26
      RETURNING *
    `, [
      name, price, old_price || null, discount_percent || null, category,
      productCategoryId,
      contact, rating, badge1, badge2, shipping,
      isFlashSale === 'true' || isFlashSale === true,
      isNewArrival === 'true' || isNewArrival === true,
      image, description || null,
      shipping_fee || null, free_shipping_eligible === 'true' || free_shipping_eligible === true,
      return_enabled !== 'false', return_window_days || 14, restocking_fee_percent || 0,
      return_shipping_paid_by || 'buyer', return_condition || 'unopened',
      stock || 0, is_featured === 'true' || is_featured === true, id, req.businessId
    ]);

    const product = result.rows[0];

    if (variants && typeof variants === 'string') {
      try {
        await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
        const variantData = JSON.parse(variants);
        const variantImages = (req.files && req.files['variantImages']) || [];
        for (let i = 0; i < variantData.length; i++) {
          const v = variantData[i];
          let variantImage = null;
          if (variantImages[i]) {
            variantImage = await uploadToCloudinary(variantImages[i].path);
            fs.unlink(variantImages[i].path, (err) => { if (err) console.error('Failed to delete local file:', err); });
          }
          await pool.query(
            `INSERT INTO product_variants (product_id, name, price, stock, image, color_code)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [product.id, v.name, v.price || price, v.stock || 0, variantImage, v.color_code || null]
          );
        }
      } catch (variantErr) {
        console.error('Error updating variants:', variantErr);
      }
    }

    await logAdminActivity(req.userId, 'UPDATE_PRODUCT', { productId: id, businessId: req.businessId });

    const enriched = await pool.query(`
      SELECT p.*, pc.name AS product_category_name, pc.slug AS product_category_slug
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.product_category_id
      WHERE p.id = $1
    `, [id]);

    res.json({ success: true, product: enriched.rows[0] || product });
  } catch (err) {
    console.error('❌ Update product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  DELETE PRODUCT (Business Admin only)
// ============================================================

router.delete('/:id', authMiddleware, businessAdminOnly, getBusinessIdFromToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ error: 'Invalid product ID' });
    }

    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND business_id = $2 RETURNING id',
      [id, req.businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found in your business' });
    }

    // product_variants has ON DELETE CASCADE, so the variants are
    // already gone. The explicit DELETE is kept for safety on
    // databases where the cascade has not been applied.
    await pool.query('DELETE FROM product_variants WHERE product_id = $1', [id]);

    await logAdminActivity(req.userId, 'DELETE_PRODUCT', { productId: id, businessId: req.businessId });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  PRODUCT REVIEWS - ADD REVIEW (Customer)
// ============================================================

router.post('/:id/review', authMiddleware, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be 1-5'),
  body('review_text').trim().escape().isLength({ min: 3 }).withMessage('Review must be at least 3 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can write reviews.' });
  }

  const productId = parseInt(req.params.id);
  if (isNaN(productId)) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  const { rating, review_text } = req.body;

  try {
    const productCheck = await pool.query(
      'SELECT id FROM products WHERE id = $1 AND is_active = true',
      [productId]
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const existing = await pool.query(
      'SELECT id FROM product_reviews WHERE product_id = $1 AND customer_id = $2',
      [productId, req.userId]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You have already reviewed this product.' });
    }

    await pool.query(
      'INSERT INTO product_reviews (product_id, customer_id, rating, review_text) VALUES ($1, $2, $3, $4)',
      [productId, req.userId, rating, review_text]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Review error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WISHLIST
// ============================================================

router.post('/wishlist', authMiddleware, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) {
    return res.status(400).json({ error: 'Product ID required' });
  }

  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can use wishlist.' });
  }

  try {
    const productCheck = await pool.query(
      'SELECT id FROM products WHERE id = $1 AND is_active = true',
      [product_id]
    );

    if (productCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const existing = await pool.query(
      'SELECT id FROM wishlist WHERE customer_id = $1 AND product_id = $2',
      [req.userId, product_id]
    );
    if (existing.rows.length > 0) {
      await pool.query('DELETE FROM wishlist WHERE id = $1', [existing.rows[0].id]);
      return res.json({ success: true, action: 'removed' });
    }
    await pool.query(
      'INSERT INTO wishlist (customer_id, product_id) VALUES ($1, $2)',
      [req.userId, product_id]
    );
    res.json({ success: true, action: 'added' });
  } catch (err) {
    console.error('❌ Wishlist error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/wishlist', authMiddleware, async (req, res) => {
  if (req.role !== 'customer') {
    return res.status(403).json({ error: 'Only customers can view wishlist.' });
  }

  try {
    const result = await pool.query(`
      SELECT w.*, p.name, p.price, p.image, p.business_id, b.business_name
      FROM wishlist w
      JOIN products p ON w.product_id = p.id
      LEFT JOIN businesses b ON p.business_id = b.id
      WHERE w.customer_id = $1
      ORDER BY w.created_at DESC
    `, [req.userId]);
    res.json(result.rows);
  } catch (err) {
    console.error('❌ Wishlist get error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;