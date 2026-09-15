// ============================================================
//  PHASE 1 — VARIANT SERVICE
//  Location: src/services/variantService.js
//
//  Purpose:
//   Own every read and write to product_variants, and resolve
//   the inheritance chain that lets a variant fall back to its
//   parent for media, price, old price, discount, and stock.
//
//   The rest of the platform never touches product_variants
//   directly. Every route that needs variants calls this service.
//   This keeps the resolution rules in one place and makes it
//   impossible for two call sites to disagree about what a
//   variant's price or media actually is.
//
//  Design:
//   - Every function that reads variants returns them with the
//     inheritance already applied, unless the caller explicitly
//     asks for the raw rows (used by the business admin edit
//     form, which must show the admin exactly what they typed,
//     not what the customer will inherit).
//   - Every write runs inside a transaction. A parent and its
//     variants are saved together, and a failure rolls the whole
//     thing back.
//   - A parent is never allowed to end up with zero variants.
//     If the admin removes every variant, the service recreates
//     a single implicit "Default" variant.
//   - A variant is never hard-deleted. Removing a variant sets
//     is_active = FALSE so that orders, reactions, comments, and
//     shares that reference it remain valid.
// ============================================================

'use strict';

const { pool, logError } = require('../config/database');

// ------------------------------------------------------------
//  CONSTANTS
// ------------------------------------------------------------

// The name given to the implicit variant created for a product
// that has no explicit variants. The customer never sees this
// name in a multi-variant product; it only appears when a
// product has exactly one variant and that variant is implicit.
const IMPLICIT_VARIANT_NAME = 'Default';

// The four axis kinds the parent can carry. Any other value is
// rejected by the migration's CHECK constraint, but the service
// also validates it so the error is friendly.
const AXIS_KINDS = ['colour', 'size', 'material', 'variant'];

// A hard cap on variants per parent. This is a safety net, not a
// product rule. The business admin form shows a soft hint after
// ten; this cap exists so a runaway client cannot insert
// thousands of rows in one request.
const MAX_VARIANTS_PER_PRODUCT = 60;

// ------------------------------------------------------------
//  INTERNAL HELPERS
// ------------------------------------------------------------

/**
 * Normalise a string for storage. Trim it, collapse internal
 * runs of whitespace, and return null for empty input. Used for
 * every text column the service writes.
 */
function normaliseText(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim().replace(/\s+/g, ' ');
    return str === '' ? null : str;
}

/**
 * Normalise a number-like string. Return null for empty input,
 * otherwise return the numeric value as a string. Prices are
 * stored as VARCHAR in this schema, matching the existing
 * products table, so the service keeps them as strings.
 */
function normaliseNumber(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    if (str === '') return null;
    const num = Number(str);
    if (!Number.isFinite(num)) return null;
    return str;
}

/**
 * Normalise an integer-like string. Return null for empty input,
 * otherwise return the integer. Returns null for non-integers so
 * the caller can decide whether that is an error.
 */
function normaliseInteger(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    if (str === '') return null;
    const num = Number(str);
    if (!Number.isInteger(num)) return null;
    return num;
}

/**
 * Normalise a hex colour code. Return null for empty input,
 * otherwise return the code in the form #RRGGBB. Accepts #RGB and
 * expands it to #RRGGBB.
 */
function normaliseColorCode(value) {
    if (value === undefined || value === null) return null;
    let str = String(value).trim();
    if (str === '') return null;
    if (!str.startsWith('#')) str = '#' + str;
    if (/^#[0-9A-Fa-f]{3}$/.test(str)) {
        // Expand #RGB to #RRGGBB.
        str = '#' + str[1] + str[1] + str[2] + str[2] + str[3] + str[3];
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(str)) return null;
    return str.toLowerCase();
}

/**
 * Validate a variant payload. Returns { ok: true, value } or
 * { ok: false, error, field }. The error message is written for
 * the business admin, not for a developer.
 */
function validateVariantPayload(raw, index) {
    const rowNumber = index + 1;

    const name = normaliseText(raw && raw.name);
    if (!name) {
        return {
            ok: false,
            field: 'name',
            error: `Variant ${rowNumber}: please give this variant a name.`
        };
    }
    if (name.length > 80) {
        return {
            ok: false,
            field: 'name',
            error: `Variant ${rowNumber}: the name must be 80 characters or fewer.`
        };
    }

    const price = normaliseNumber(raw && raw.price);
    if (price !== null && Number(price) < 0) {
        return {
            ok: false,
            field: 'price',
            error: `Variant ${rowNumber}: the price cannot be negative.`
        };
    }

    const oldPrice = normaliseNumber(raw && raw.old_price);
    if (oldPrice !== null && Number(oldPrice) < 0) {
        return {
            ok: false,
            field: 'old_price',
            error: `Variant ${rowNumber}: the old price cannot be negative.`
        };
    }

    const discount = normaliseNumber(raw && raw.discount_percent);
    if (discount !== null && (Number(discount) < 0 || Number(discount) > 100)) {
        return {
            ok: false,
            field: 'discount_percent',
            error: `Variant ${rowNumber}: the discount must be between 0 and 100.`
        };
    }

    const stock = normaliseInteger(raw && raw.stock);
    if (stock !== null && stock < 0) {
        return {
            ok: false,
            field: 'stock',
            error: `Variant ${rowNumber}: the stock cannot be negative.`
        };
    }

    const colorCode = normaliseColorCode(raw && raw.color_code);
    if (
        raw &&
        raw.color_code !== undefined &&
        raw.color_code !== null &&
        String(raw.color_code).trim() !== '' &&
        colorCode === null
    ) {
        return {
            ok: false,
            field: 'color_code',
            error: `Variant ${rowNumber}: the colour code must be a hex value like #A1B2C3.`
        };
    }

    return {
        ok: true,
        value: {
            name,
            image: normaliseText(raw && raw.image),
            video: normaliseText(raw && raw.video),
            video_poster_url: normaliseText(raw && raw.video_poster_url),
            price,
            old_price: oldPrice,
            discount_percent: discount,
            stock,
            color_code: colorCode
        }
    };
}

/**
 * Detect the axis kind for a parent from its active variants. If
 * every active variant has a colour code, the axis is colour. If
 * every active variant's name matches a size pattern (XS, S, M, L,
 * XL, XXL, or a number like 38, 40, 42), the axis is size. If
 * every active variant's name matches a material pattern (Cotton,
 * Silk, Wool, Leather, etc.), the axis is material. Otherwise the
 * axis is the generic variant.
 *
 * This runs only when the admin has not explicitly set an axis.
 */
function detectAxisKind(variants) {
    if (!Array.isArray(variants) || variants.length < 2) return null;

    const allHaveColour = variants.every(v => v && v.color_code);
    if (allHaveColour) return 'colour';

    const sizePattern = /^(xxs|xs|s|m|l|xl|xxl|xxxl|[0-9]{1,3})$/i;
    const allLookLikeSizes = variants.every(v =>
        v && v.name && sizePattern.test(String(v.name).trim())
    );
    if (allLookLikeSizes) return 'size';

    const materialWords = ['cotton', 'silk', 'wool', 'leather', 'linen', 'polyester', 'denim', 'suede', 'velvet', 'nylon'];
    const allLookLikeMaterials = variants.every(v =>
        v && v.name && materialWords.includes(String(v.name).trim().toLowerCase())
    );
    if (allLookLikeMaterials) return 'material';

    return 'variant';
}

/**
 * Resolve the inheritance chain for a single variant against a
 * parent. Returns a plain object with every media and pricing
 * field fully resolved.
 */
function resolveVariant(variant, parent) {
    if (!variant) return null;
    const p = parent || {};

    const resolved = {
        id: variant.id,
        product_id: variant.product_id,
        name: variant.name,
        display_order: variant.display_order,
        is_active: variant.is_active,
        color_code: variant.color_code,

        // Media — variant first, then parent.
        image: variant.image || p.image || null,
        video: variant.video || p.video || null,
        video_poster_url: variant.video_poster_url || p.video_poster_url || null,

        // Pricing — variant first, then parent.
        price: variant.price || p.price || null,
        old_price: variant.old_price || p.old_price || null,
        discount_percent: variant.discount_percent || p.discount_percent || null,

        // Stock — variant first, then parent.
        stock: variant.stock !== null && variant.stock !== undefined
            ? variant.stock
            : (p.stock !== null && p.stock !== undefined ? p.stock : null),

        // Truth flags for the client, so it does not have to
        // walk the chain itself.
        has_own_image: Boolean(variant.image),
        has_own_video: Boolean(variant.video),
        has_own_price: variant.price !== null && variant.price !== undefined,
        has_own_stock: variant.stock !== null && variant.stock !== undefined
    };

    // A variant is "mixed" if both image and video resolve to a
    // non-empty value.
    resolved.is_mixed = Boolean(resolved.image && resolved.video);

    // A variant is "video" if it has a video and no image, "image"
    // if it has an image and no video, and "mixed" otherwise.
    if (resolved.is_mixed) {
        resolved.media_kind = 'mixed';
    } else if (resolved.video) {
        resolved.media_kind = 'video';
    } else if (resolved.image) {
        resolved.media_kind = 'image';
    } else {
        resolved.media_kind = 'placeholder';
    }

    return resolved;
}

/**
 * Read the parent product row. Used internally by the resolvers.
 * This is deliberately a small projection — the service does not
 * need the whole product row.
 */
async function loadParentRow(client, productId) {
    const executor = client || pool;
    const { rows } = await executor.query(
        `SELECT id, image, video, video_poster_url,
                price, old_price, discount_percent, stock
           FROM products
          WHERE id = $1`,
        [productId]
    );
    return rows[0] || null;
}

// ------------------------------------------------------------
//  PUBLIC API — READS
// ------------------------------------------------------------

/**
 * List every active variant of a product, in display order, with
 * inheritance applied. This is what the customer-facing routes
 * call. The returned variants always carry a fully resolved media
 * URL, price, stock, and media_kind.
 *
 * If the product has no active variants at all — which should
 * never happen after the migration, but is possible if a future
 * write path bypasses the service — the function returns an
 * empty array and the caller falls back to the parent row.
 */
async function listActiveVariants(productId) {
    if (!productId) return [];

    const parent = await loadParentRow(null, productId);
    if (!parent) return [];

    const { rows } = await pool.query(
        `SELECT id, product_id, name, image, video, video_poster_url,
                price, old_price, discount_percent, stock,
                color_code, display_order, is_active
           FROM product_variants
          WHERE product_id = $1 AND is_active = TRUE
          ORDER BY display_order ASC, id ASC`,
        [productId]
    );

    if (rows.length === 0) return [];

    return rows.map(v => resolveVariant(v, parent));
}

/**
 * List every variant of a product, active or not, with the
 * inheritance applied. Used by the business admin views and by
 * the moderation surfaces that need to see soft-deleted variants.
 */
async function listAllVariants(productId) {
    if (!productId) return [];

    const parent = await loadParentRow(null, productId);
    if (!parent) return [];

    const { rows } = await pool.query(
        `SELECT id, product_id, name, image, video, video_poster_url,
                price, old_price, discount_percent, stock,
                color_code, display_order, is_active
           FROM product_variants
          WHERE product_id = $1
          ORDER BY display_order ASC, id ASC`,
        [productId]
    );

    return rows.map(v => resolveVariant(v, parent));
}

/**
 * List every variant of a product in raw form, without inheritance.
 * Used by the business admin edit form, which must show the admin
 * exactly what they typed, not what the customer will inherit.
 */
async function listRawVariants(productId) {
    if (!productId) return [];

    const { rows } = await pool.query(
        `SELECT id, product_id, name, image, video, video_poster_url,
                price, old_price, discount_percent, stock,
                color_code, display_order, is_active,
                created_at, updated_at
           FROM product_variants
          WHERE product_id = $1
          ORDER BY display_order ASC, id ASC`,
        [productId]
    );

    return rows;
}

/**
 * Fetch a single variant by its own id, with inheritance applied.
 * Returns null if the variant does not exist or belongs to a
 * different product than the one the caller expects.
 */
async function getVariantById(variantId, productId) {
    if (!variantId) return null;

    const params = [variantId];
    let where = 'id = $1';
    if (productId) {
        params.push(productId);
        where += ' AND product_id = $2';
    }

    const { rows } = await pool.query(
        `SELECT id, product_id, name, image, video, video_poster_url,
                price, old_price, discount_percent, stock,
                color_code, display_order, is_active
           FROM product_variants
          WHERE ${where}`,
        params
    );

    if (rows.length === 0) return null;

    const parent = await loadParentRow(null, rows[0].product_id);
    return resolveVariant(rows[0], parent);
}

/**
 * Return the default variant to show a customer who has no memory
 * of this product. This is always the first active variant in
 * display order. Returns null if the product has no active
 * variants.
 */
async function getDefaultVariant(productId) {
    const variants = await listActiveVariants(productId);
    return variants[0] || null;
}

/**
 * Return the axis metadata for a product. Used by the client to
 * label the vertical counter and the vertical hints. If the admin
 * has set an explicit axis, that wins. Otherwise the axis is
 * detected from the active variants. If the product has fewer
 * than two variants, the axis is null and the vertical hints are
 * hidden by the client.
 */
async function getAxis(productId) {
    const parent = await loadParentRow(null, productId);
    if (!parent) return { kind: null, label: null, count: 0 };

    const { rows: parentRows } = await pool.query(
        `SELECT variant_axis_kind, variant_axis_label
           FROM products WHERE id = $1`,
        [productId]
    );
    const parentAxis = parentRows[0] || {};

    const variants = await listActiveVariants(productId);

    let kind = parentAxis.variant_axis_kind || null;
    let label = parentAxis.variant_axis_label || null;

    if (!kind && variants.length >= 2) {
        kind = detectAxisKind(variants);
    }

    if (!label && kind) {
        const defaults = {
            colour: 'Colour',
            size: 'Size',
            material: 'Material',
            variant: 'Option'
        };
        label = defaults[kind] || 'Option';
    }

    return {
        kind,
        label,
        count: variants.length
    };
}

// ------------------------------------------------------------
//  PUBLIC API — WRITES
// ------------------------------------------------------------

/**
 * Save a parent and its variants in one transaction.
 *
 * The caller passes the product id (already created or being
 * created) and the array of variant payloads. The service:
 *   1. Validates every payload.
 *   2. Marks every existing active variant as inactive.
 *   3. Inserts or updates the variants in the payload, in the
 *      order given, so display_order matches the admin's order.
 *   4. Ensures at least one active variant exists. If the payload
 *      is empty, a single implicit "Default" variant is created.
 *   5. Detects and stores the axis kind and label on the parent,
 *      unless the caller supplied them explicitly.
 *
 * The whole thing runs inside a single transaction. If anything
 * fails, nothing is written.
 */
async function saveVariantsForProduct(productId, payload, options) {
    if (!productId) {
        throw new Error('saveVariantsForProduct requires a product id');
    }

    const opts = options || {};
    const rows = Array.isArray(payload) ? payload : [];

    if (rows.length > MAX_VARIANTS_PER_PRODUCT) {
        const err = new Error(
            `A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants.`
        );
        err.field = 'variants';
        throw err;
    }

    // Validate every row before opening a transaction.
    const validated = [];
    for (let i = 0; i < rows.length; i += 1) {
        const result = validateVariantPayload(rows[i], i);
        if (!result.ok) {
            const err = new Error(result.error);
            err.field = result.field;
            err.row = i + 1;
            throw err;
        }
        validated.push(result.value);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Soft-delete every currently active variant. The
        //    service will re-activate the ones that are still in
        //    the payload, by matching on id.
        await client.query(
            `UPDATE product_variants
                SET is_active = FALSE,
                    updated_at = NOW()
              WHERE product_id = $1 AND is_active = TRUE`,
            [productId]
        );

        // 2. Walk the payload and upsert.
        const activeIds = [];
        for (let i = 0; i < validated.length; i += 1) {
            const row = validated[i];
            const incomingId = rows[i] && rows[i].id ? Number(rows[i].id) : null;

            if (incomingId) {
                // Update the existing row, reactivate it, and set
                // its display order. Verify the row belongs to
                // this product first.
                const update = await client.query(
                    `UPDATE product_variants
                        SET name = $1,
                            image = $2,
                            video = $3,
                            video_poster_url = $4,
                            price = $5,
                            old_price = $6,
                            discount_percent = $7,
                            stock = $8,
                            color_code = $9,
                            display_order = $10,
                            is_active = TRUE,
                            updated_at = NOW()
                      WHERE id = $11 AND product_id = $12
                      RETURNING id`,
                    [
                        row.name,
                        row.image,
                        row.video,
                        row.video_poster_url,
                        row.price,
                        row.old_price,
                        row.discount_percent,
                        row.stock,
                        row.color_code,
                        i,
                        incomingId,
                        productId
                    ]
                );
                if (update.rows.length > 0) {
                    activeIds.push(update.rows[0].id);
                }
                // If the update matched nothing, the id belongs to
                // a different product; treat the row as a new insert.
                if (update.rows.length === 0) {
                    const inserted = await client.query(
                        `INSERT INTO product_variants
                            (product_id, name, image, video, video_poster_url,
                             price, old_price, discount_percent, stock,
                             color_code, display_order, is_active)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
                         RETURNING id`,
                        [
                            productId,
                            row.name,
                            row.image,
                            row.video,
                            row.video_poster_url,
                            row.price,
                            row.old_price,
                            row.discount_percent,
                            row.stock,
                            row.color_code,
                            i
                        ]
                    );
                    activeIds.push(inserted.rows[0].id);
                }
            } else {
                // New variant.
                const inserted = await client.query(
                    `INSERT INTO product_variants
                        (product_id, name, image, video, video_poster_url,
                         price, old_price, discount_percent, stock,
                         color_code, display_order, is_active)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
                     RETURNING id`,
                    [
                        productId,
                        row.name,
                        row.image,
                        row.video,
                        row.video_poster_url,
                        row.price,
                        row.old_price,
                        row.discount_percent,
                        row.stock,
                        row.color_code,
                        i
                    ]
                );
                activeIds.push(inserted.rows[0].id);
            }
        }

        // 3. Ensure at least one active variant exists.
        if (activeIds.length === 0) {
            const inserted = await client.query(
                `INSERT INTO product_variants
                    (product_id, name, display_order, is_active)
                 VALUES ($1, $2, 0, TRUE)
                 RETURNING id`,
                [productId, IMPLICIT_VARIANT_NAME]
            );
            activeIds.push(inserted.rows[0].id);
        }

        // 4. Set the axis on the parent unless the caller said
        //    not to. The axis is read from the freshly written
        //    variants.
        if (opts.detectAxis !== false) {
            const { rows: activeRows } = await client.query(
                `SELECT id, name, color_code
                   FROM product_variants
                  WHERE product_id = $1 AND is_active = TRUE
                  ORDER BY display_order ASC, id ASC`,
                [productId]
            );

            const kind = detectAxisKind(activeRows);
            const label = kind
                ? ({
                    colour: 'Colour',
                    size: 'Size',
                    material: 'Material',
                    variant: 'Option'
                }[kind] || 'Option')
                : null;

            await client.query(
                `UPDATE products
                    SET variant_axis_kind = $1,
                        variant_axis_label = $2,
                        updated_at = NOW()
                  WHERE id = $3`,
                [kind, label, productId]
            );
        }

        await client.query('COMMIT');
        return { variantIds: activeIds };
    } catch (err) {
        await client.query('ROLLBACK');
        logError(err, 'saveVariantsForProduct');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Add a single variant to an existing product. Used by the admin
 * form when the admin clicks "add another colour" without
 * re-saving the whole list. Returns the created variant.
 */
async function addVariant(productId, raw) {
    if (!productId) throw new Error('addVariant requires a product id');

    const result = validateVariantPayload(raw, 0);
    if (!result.ok) {
        const err = new Error(result.error);
        err.field = result.field;
        throw err;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: orderRows } = await client.query(
            `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
               FROM product_variants WHERE product_id = $1`,
            [productId]
        );
        const nextOrder = orderRows[0] ? orderRows[0].next_order : 0;

        const { rows } = await client.query(
            `INSERT INTO product_variants
                (product_id, name, image, video, video_poster_url,
                 price, old_price, discount_percent, stock,
                 color_code, display_order, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
             RETURNING id, product_id, name, image, video, video_poster_url,
                       price, old_price, discount_percent, stock,
                       color_code, display_order, is_active`,
            [
                productId,
                result.value.name,
                result.value.image,
                result.value.video,
                result.value.video_poster_url,
                result.value.price,
                result.value.old_price,
                result.value.discount_percent,
                result.value.stock,
                result.value.color_code,
                nextOrder
            ]
        );

        await client.query('COMMIT');

        const parent = await loadParentRow(null, productId);
        return resolveVariant(rows[0], parent);
    } catch (err) {
        await client.query('ROLLBACK');
        logError(err, 'addVariant');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Update a single variant in place. Only the fields present in the
 * payload are touched. Passing null for a field clears it.
 */
async function updateVariant(variantId, productId, raw) {
    if (!variantId || !productId) {
        throw new Error('updateVariant requires a variant id and a product id');
    }

    const result = validateVariantPayload(
        {
            name: raw && raw.name !== undefined ? raw.name : 'placeholder',
            ...raw,
            name: raw && raw.name !== undefined ? raw.name : 'placeholder'
        },
        0
    );

    // We only need the validation for the fields the caller sent.
    // The name check is skipped when the caller is not changing
    // the name, so we fall through to a direct update.
    const fields = [];
    const values = [];
    let index = 1;

    const map = {
        name: v => normaliseText(v),
        image: v => normaliseText(v),
        video: v => normaliseText(v),
        video_poster_url: v => normaliseText(v),
        price: v => normaliseNumber(v),
        old_price: v => normaliseNumber(v),
        discount_percent: v => normaliseNumber(v),
        stock: v => normaliseInteger(v),
        color_code: v => normaliseColorCode(v)
    };

    for (const key of Object.keys(map)) {
        if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
            fields.push(`${key} = $${index}`);
            values.push(map[key](raw[key]));
            index += 1;
        }
    }

    if (fields.length === 0) {
        // Nothing to update. Return the current variant.
        return getVariantById(variantId, productId);
    }

    fields.push(`updated_at = NOW()`);
    values.push(variantId);
    const variantPlaceholder = `$${index}`;
    index += 1;
    values.push(productId);
    const productPlaceholder = `$${index}`;

    const { rows } = await pool.query(
        `UPDATE product_variants
            SET ${fields.join(', ')}
          WHERE id = ${variantPlaceholder} AND product_id = ${productPlaceholder}
          RETURNING id, product_id, name, image, video, video_poster_url,
                    price, old_price, discount_percent, stock,
                    color_code, display_order, is_active`,
        values
    );

    if (rows.length === 0) return null;

    const parent = await loadParentRow(null, productId);
    return resolveVariant(rows[0], parent);
}

/**
 * Reorder a product's variants. Accepts an array of variant ids in
 * the new order. Any variant not in the array keeps its current
 * position relative to the others.
 */
async function reorderVariants(productId, orderedIds) {
    if (!productId || !Array.isArray(orderedIds) || orderedIds.length === 0) {
        return { updated: 0 };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let updated = 0;
        for (let i = 0; i < orderedIds.length; i += 1) {
            const id = Number(orderedIds[i]);
            if (!Number.isFinite(id)) continue;
            const res = await client.query(
                `UPDATE product_variants
                    SET display_order = $1, updated_at = NOW()
                  WHERE id = $2 AND product_id = $3`,
                [i, id, productId]
            );
            updated += res.rowCount || 0;
        }
        await client.query('COMMIT');
        return { updated };
    } catch (err) {
        await client.query('ROLLBACK');
        logError(err, 'reorderVariants');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Soft-delete a variant. The row stays in the database with
 * is_active = FALSE. If this was the last active variant of the
 * product, a single implicit "Default" variant is created so the
 * product is never left without one.
 */
async function deactivateVariant(variantId, productId) {
    if (!variantId || !productId) {
        throw new Error('deactivateVariant requires a variant id and a product id');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE product_variants
                SET is_active = FALSE, updated_at = NOW()
              WHERE id = $1 AND product_id = $2`,
            [variantId, productId]
        );

        const { rows: activeRows } = await client.query(
            `SELECT COUNT(*)::int AS active_count
               FROM product_variants
              WHERE product_id = $1 AND is_active = TRUE`,
            [productId]
        );

        if ((activeRows[0] && activeRows[0].active_count) === 0) {
            await client.query(
                `INSERT INTO product_variants
                    (product_id, name, display_order, is_active)
                 VALUES ($1, $2, 0, TRUE)`,
                [productId, IMPLICIT_VARIANT_NAME]
            );
        }

        // Recompute the axis, since removing the only coloured
        // variant may change what the axis is.
        const { rows: remaining } = await client.query(
            `SELECT id, name, color_code
               FROM product_variants
              WHERE product_id = $1 AND is_active = TRUE
              ORDER BY display_order ASC, id ASC`,
            [productId]
        );
        const kind = detectAxisKind(remaining);
        const label = kind
            ? ({
                colour: 'Colour',
                size: 'Size',
                material: 'Material',
                variant: 'Option'
            }[kind] || 'Option')
            : null;
        await client.query(
            `UPDATE products
                SET variant_axis_kind = $1,
                    variant_axis_label = $2,
                    updated_at = NOW()
              WHERE id = $3`,
            [kind, label, productId]
        );

        await client.query('COMMIT');
        return { ok: true };
    } catch (err) {
        await client.query('ROLLBACK');
        logError(err, 'deactivateVariant');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Given a set of product ids, return a map from product id to the
 * number of active variants and the presence of image/video at any
 * variant level. Used by the shop page to decide the tab badges
 * and the variant count label without a query per product.
 *
 * The returned object is:
 *   {
 *     [productId]: {
 *       active_count: number,
 *       has_variant_image: boolean,
 *       has_variant_video: boolean,
 *       first_image: string | null,
 *       first_video_poster: string | null
 *     }
 *   }
 */
async function getVariantSummaryForProducts(productIds) {
    const ids = Array.isArray(productIds)
        ? productIds.map(Number).filter(Number.isFinite)
        : [];
    if (ids.length === 0) return {};

    const { rows } = await pool.query(
        `SELECT
            product_id,
            COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_count,
            BOOL_OR(is_active = TRUE AND image IS NOT NULL AND BTRIM(image) <> '') AS has_variant_image,
            BOOL_OR(is_active = TRUE AND video IS NOT NULL AND BTRIM(video) <> '') AS has_variant_video
         FROM product_variants
         WHERE product_id = ANY($1::int[])
         GROUP BY product_id`,
        [ids]
    );

    const map = {};
    for (const row of rows) {
        map[row.product_id] = {
            active_count: row.active_count || 0,
            has_variant_image: row.has_variant_image === true,
            has_variant_video: row.has_variant_video === true
        };
    }

    // For the first image and first video poster, we need an
    // ordered lookup. Do it in a second pass for only the products
    // that have a variant-level image or video.
    const productsWithMedia = rows
        .filter(r => r.has_variant_image || r.has_variant_video)
        .map(r => r.product_id);

    if (productsWithMedia.length > 0) {
        const { rows: mediaRows } = await pool.query(
            `SELECT DISTINCT ON (product_id, media_kind)
                product_id,
                CASE
                    WHEN image IS NOT NULL AND BTRIM(image) <> '' THEN 'image'
                    WHEN video_poster_url IS NOT NULL AND BTRIM(video_poster_url) <> '' THEN 'video'
                    ELSE NULL
                END AS media_kind,
                CASE
                    WHEN image IS NOT NULL AND BTRIM(image) <> '' THEN image
                    WHEN video_poster_url IS NOT NULL AND BTRIM(video_poster_url) <> '' THEN video_poster_url
                    ELSE NULL
                END AS media_url
             FROM product_variants
             WHERE product_id = ANY($1::int[])
               AND is_active = TRUE
               AND (
                    (image IS NOT NULL AND BTRIM(image) <> '')
                 OR (video_poster_url IS NOT NULL AND BTRIM(video_poster_url) <> '')
               )
             ORDER BY product_id, media_kind, display_order ASC, id ASC`,
            [productsWithMedia]
        );

        for (const row of mediaRows) {
            if (!row.media_kind) continue;
            const entry = map[row.product_id];
            if (!entry) continue;
            if (row.media_kind === 'image' && !entry.first_image) {
                entry.first_image = row.media_url;
            }
            if (row.media_kind === 'video' && !entry.first_video_poster) {
                entry.first_video_poster = row.media_url;
            }
        }
    }

    return map;
}

// ------------------------------------------------------------
//  EXPORTS
// ------------------------------------------------------------

module.exports = {
    // Constants
    IMPLICIT_VARIANT_NAME,
    AXIS_KINDS,
    MAX_VARIANTS_PER_PRODUCT,

    // Reads
    listActiveVariants,
    listAllVariants,
    listRawVariants,
    getVariantById,
    getDefaultVariant,
    getAxis,
    getVariantSummaryForProducts,

    // Writes
    saveVariantsForProduct,
    addVariant,
    updateVariant,
    reorderVariants,
    deactivateVariant
};