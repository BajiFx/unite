// ============================================================
//  CUSTOMER MODEL
//  Location: src/models/Customer.js
//
//  Section D — Customer location support:
//   D.1  — location can be saved during profile editing
//   D.2  — coordinates are persisted on the customer's own row
//   D.10 — location can be turned off (clears coordinates)
//   D.11 — getLocationStatus() is scoped to a single customer;
//          no method exposes another customer's coordinates
//   D.12 — updateLocation() is idempotent so it also handles the
//          refresh case when the customer has moved
//
//  Section E.2 / G.3 — Customer preferred locations:
//   A customer who chooses not to share GPS can still tell the
//   marketplace which area they want to shop in. These names are
//   optional, customer-scoped, and used by the search handler
//   (E.4) as a soft anchor when the customer has no coordinates.
//
//   Like the coordinate columns, the preferred-name columns are
//   never returned on a business-facing endpoint. The only way to
//   read them is getPreferredLocations(customerId), which is
//   scoped to a single customer.
// ============================================================

const { pool } = require('../config/database');
const bcrypt = require('bcrypt');

const PREFERRED_FIELDS = [
  'preferred_continent',
  'preferred_country',
  'preferred_county',
  'preferred_sub_county',
  'preferred_ward',
  'preferred_town'
];

function normalisePreferred(value) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (str === '') return null;
  return str.slice(0, 100);
}

class Customer {
  /**
   * Find customer by ID
   *
   * Section D.11 / E.2 — the default projection deliberately omits
   * both the coordinate columns and the preferred-location columns
   * so that callers who only need identity data cannot accidentally
   * leak location.
   */
  static async findById(id) {
    const result = await pool.query(
      'SELECT id, name, email, phone, created_at, last_login_at FROM customers WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  /**
   * Find customer by email
   */
  static async findByEmail(email) {
    const result = await pool.query(
      'SELECT * FROM customers WHERE email = $1',
      [email]
    );
    return result.rows[0] || null;
  }

  /**
   * Find customer by phone
   */
  static async findByPhone(phone) {
    const result = await pool.query(
      'SELECT * FROM customers WHERE phone = $1',
      [phone]
    );
    return result.rows[0] || null;
  }

  /**
   * Create new customer
   */
  static async create({ name, email, phone, password }) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO customers (username, name, email, phone, password)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, phone, created_at`,
      [email.split('@')[0], name, email, phone, hashedPassword]
    );

    // Create cart for new customer
    await pool.query(
      'INSERT INTO carts (customer_id, items) VALUES ($1, $2)',
      [result.rows[0].id, '[]']
    );

    return result.rows[0];
  }

  /**
   * Update customer profile
   */
  static async update(id, data) {
    const { name, email, phone } = data;
    const result = await pool.query(
      `UPDATE customers
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           phone = COALESCE($3, phone)
       WHERE id = $4
       RETURNING id, name, email, phone, created_at`,
      [name, email, phone, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Update password
   */
  static async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const result = await pool.query(
      'UPDATE customers SET password = $1 WHERE id = $2 RETURNING id',
      [hashedPassword, id]
    );
    return result.rows[0] || null;
  }

  /**
   * Verify password
   */
  static async verifyPassword(customer, password) {
    return bcrypt.compare(password, customer.password);
  }

  /**
   * Update last login
   */
  static async updateLastLogin(id) {
    await pool.query(
      'UPDATE customers SET last_login_at = NOW() WHERE id = $1',
      [id]
    );
  }

  // ============================================================
  //  Section D — Customer location methods
  // ============================================================

  /**
   * D.1 / D.2 / D.12 — Save or refresh the customer's coordinates.
   *
   * Idempotent: calling again updates the same row and refreshes
   * the activated_at timestamp. This is exactly how the profile
   * UI performs "refresh" after the customer has moved.
   *
   * @param {number} customerId
   * @param {{ latitude: number|string, longitude: number|string, accuracy?: number|string }} input
   * @returns {Promise<object|null>} The updated location columns, or null when invalid.
   */
  static async updateLocation(customerId, input = {}) {
    const latRaw = input.latitude;
    const lngRaw = input.longitude;

    if (latRaw === undefined || latRaw === null || latRaw === '') return null;
    if (lngRaw === undefined || lngRaw === null || lngRaw === '') return null;

    const lat = Number.parseFloat(latRaw);
    const lng = Number.parseFloat(lngRaw);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;

    let accuracy = null;
    if (input.accuracy !== undefined && input.accuracy !== null && input.accuracy !== '') {
      const acc = Number.parseFloat(input.accuracy);
      if (Number.isFinite(acc) && acc >= 0) accuracy = Math.round(acc);
    }

    const result = await pool.query(`
      UPDATE customers
      SET latitude = $1,
          longitude = $2,
          location_accuracy = COALESCE($3, location_accuracy),
          location_activated = TRUE,
          location_activated_at = NOW(),
          location_source = 'browser',
          updated_at = NOW()
      WHERE id = $4
      RETURNING
        id,
        latitude,
        longitude,
        location_accuracy,
        location_activated,
        location_activated_at,
        location_source
    `, [lat.toString(), lng.toString(), accuracy, customerId]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      activated: row.location_activated === true,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.location_accuracy,
      activated_at: row.location_activated_at,
      source: row.location_source
    };
  }

  /**
   * D.10 — Turn off location sharing.
   * Clears coordinates and flips the activation flag off.
   *
   * Deliberately leaves preferred_* names untouched: they are an
   * independent, optional feature. A customer can turn off GPS
   * (D.10) and still keep a preferred area (E.2).
   *
   * @param {number} customerId
   * @returns {Promise<boolean>} true when the customer row was updated.
   */
  static async clearLocation(customerId) {
    const result = await pool.query(`
      UPDATE customers
      SET latitude = NULL,
          longitude = NULL,
          location_accuracy = NULL,
          location_activated = FALSE,
          location_activated_at = NULL,
          location_source = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `, [customerId]);

    return result.rows.length > 0;
  }

  /**
   * D.11 — Read only this customer's own location state.
   * There is no way to fetch another customer's coordinates via
   * this model method.
   *
   * @param {number} customerId
   * @returns {Promise<object|null>}
   */
  static async getLocationStatus(customerId) {
    const result = await pool.query(`
      SELECT
        latitude,
        longitude,
        location_accuracy,
        location_activated,
        location_activated_at,
        location_source
      FROM customers
      WHERE id = $1
    `, [customerId]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      activated: row.location_activated === true,
      latitude: row.latitude || null,
      longitude: row.longitude || null,
      accuracy: row.location_accuracy || null,
      activated_at: row.location_activated_at || null,
      source: row.location_source || null
    };
  }

  /**
   * D.2 — Return only the coordinates of an activated customer.
   * Used by server-side search to rank businesses nearest-first
   * without ever exposing these values back to the customer.
   *
   * Returns null when the customer has not activated a location.
   *
   * @param {number} customerId
   * @returns {Promise<{latitude: number, longitude: number}|null>}
   */
  static async getCoordinates(customerId) {
    const result = await pool.query(`
      SELECT latitude, longitude, location_activated
      FROM customers
      WHERE id = $1
    `, [customerId]);

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.location_activated !== true) return null;

    const lat = Number.parseFloat(row.latitude);
    const lng = Number.parseFloat(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return { latitude: lat, longitude: lng };
  }

  // ============================================================
  //  End Section D
  // ============================================================

  // ============================================================
  //  Section E.2 / G.3 — Customer preferred locations
  //
  //  Optional. A customer who does not share GPS can still set a
  //  preferred area. Used by the search handler (E.4) as a soft
  //  anchor so results still lean towards where the customer
  //  wants to shop.
  //
  //  D.11 is preserved: these methods are scoped to a single
  //  customer, and nothing in this model exposes them to any
  //  business-facing code path.
  // ============================================================

  /**
   * E.2 — Save or refresh the customer's preferred area names.
   *
   * Any field passed as undefined is left as-is (COALESCE-style).
   * Any field passed as an empty string or null is cleared.
   * Idempotent: calling again just replaces the stored values.
   *
   * @param {number} customerId
   * @param {object} input  // keys: continent, country, county, sub_county, ward, town
   * @returns {Promise<object|null>} The updated preferred-location block, or null when invalid.
   */
  static async updatePreferredLocations(customerId, input = {}) {
    if (!Number.isInteger(customerId)) return null;

    const values = {
      preferred_continent:   normalisePreferred(input.continent),
      preferred_country:     normalisePreferred(input.country),
      preferred_county:      normalisePreferred(input.county),
      preferred_sub_county:  normalisePreferred(input.sub_county),
      preferred_ward:        normalisePreferred(input.ward),
      preferred_town:        normalisePreferred(input.town)
    };

    // If every field is empty we treat this as a "clear" request.
    // This keeps the endpoint unambiguous: an empty body means
    // "remove the preferred area", not "leave it unchanged".
    const allEmpty = Object.values(values).every(v => v === null);
    if (allEmpty) {
      return this.clearPreferredLocations(customerId);
    }

    const result = await pool.query(`
      UPDATE customers
      SET preferred_continent = $1,
          preferred_country = $2,
          preferred_county = $3,
          preferred_sub_county = $4,
          preferred_ward = $5,
          preferred_town = $6,
          preferred_locations_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $7
      RETURNING
        preferred_continent,
        preferred_country,
        preferred_county,
        preferred_sub_county,
        preferred_ward,
        preferred_town,
        preferred_locations_updated_at
    `, [
      values.preferred_continent,
      values.preferred_country,
      values.preferred_county,
      values.preferred_sub_county,
      values.preferred_ward,
      values.preferred_town,
      customerId
    ]);

    if (result.rows.length === 0) return null;

    return this._formatPreferred(result.rows[0]);
  }

  /**
   * E.2 — Clear the customer's preferred area entirely.
   *
   * @param {number} customerId
   * @returns {Promise<object|null>} The cleared preferred-location block, or null when not found.
   */
  static async clearPreferredLocations(customerId) {
    const result = await pool.query(`
      UPDATE customers
      SET preferred_continent = NULL,
          preferred_country = NULL,
          preferred_county = NULL,
          preferred_sub_county = NULL,
          preferred_ward = NULL,
          preferred_town = NULL,
          preferred_locations_updated_at = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING
        preferred_continent,
        preferred_country,
        preferred_county,
        preferred_sub_county,
        preferred_ward,
        preferred_town,
        preferred_locations_updated_at
    `, [customerId]);

    if (result.rows.length === 0) return null;

    return this._formatPreferred(result.rows[0]);
  }

  /**
   * E.2 / E.4 — Read this customer's preferred area.
   *
   * The search handler uses this as a soft anchor when the customer
   * has no GPS coordinates. Returns a compact object with only the
   * fields that are set, so callers can do a quick "any anchor?"
   * check without inspecting six properties.
   *
   * @param {number} customerId
   * @returns {Promise<object|null>}
   */
  static async getPreferredLocations(customerId) {
    const result = await pool.query(`
      SELECT
        preferred_continent,
        preferred_country,
        preferred_county,
        preferred_sub_county,
        preferred_ward,
        preferred_town,
        preferred_locations_updated_at
      FROM customers
      WHERE id = $1
    `, [customerId]);

    if (result.rows.length === 0) return null;
    return this._formatPreferred(result.rows[0]);
  }

  /**
   * Internal — shape the preferred-location block consistently
   * across the three public methods above.
   */
  static _formatPreferred(row) {
    if (!row) {
      return {
        continent: null,
        country: null,
        county: null,
        sub_county: null,
        ward: null,
        town: null,
        updated_at: null,
        has_any: false
      };
    }

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
      block.continent ||
      block.country ||
      block.county ||
      block.sub_county ||
      block.ward ||
      block.town
    );

    return block;
  }

  // ============================================================
  //  End Section E.2 / G.3
  // ============================================================

  /**
   * Delete customer account (cascades to all related data)
   */
  static async delete(id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete order items
      await client.query(
        `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [id]
      );

      // Delete order chat messages
      await client.query(
        `DELETE FROM order_chat_messages WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)`,
        [id]
      );

      // Delete orders
      await client.query('DELETE FROM orders WHERE customer_id = $1', [id]);

      // Delete cart
      await client.query('DELETE FROM carts WHERE customer_id = $1', [id]);

      // Delete addresses
      await client.query('DELETE FROM customer_addresses WHERE customer_id = $1', [id]);

      // Delete wishlist
      await client.query('DELETE FROM wishlist WHERE customer_id = $1', [id]);

      // Delete returns
      await client.query('DELETE FROM returns WHERE customer_id = $1', [id]);

      // Delete reviews
      await client.query('DELETE FROM product_reviews WHERE customer_id = $1', [id]);

      // Delete payments
      await client.query('DELETE FROM payments WHERE customer_id = $1', [id]);

      // Delete location requests
      await client.query('DELETE FROM location_requests WHERE customer_id = $1', [id]);

      // Delete chat messages
      await client.query('DELETE FROM chat_messages WHERE customer_id = $1', [id]);

      // Delete notifications
      await client.query('DELETE FROM notifications WHERE customer_id = $1', [id]);

      // Delete customer
      const result = await client.query(
        'DELETE FROM customers WHERE id = $1 RETURNING id',
        [id]
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
   * Get customer statistics
   */
  static async getStats(id) {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE customer_id = $1) as total_orders,
        (SELECT SUM(total) FROM orders WHERE customer_id = $1 AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent,
        (SELECT COUNT(*) FROM orders WHERE customer_id = $1 AND status = 'pending') as pending_orders,
        (SELECT COUNT(*) FROM wishlist WHERE customer_id = $1) as wishlist_count
    `, [id]);
    return result.rows[0];
  }

  /**
   * Get all customers (admin)
   */
  static async findAll(limit = 50, offset = 0) {
    const result = await pool.query(`
      SELECT
        id, name, email, phone, created_at,
        (SELECT COUNT(*) FROM orders WHERE customer_id = customers.id) as order_count,
        (SELECT SUM(total) FROM orders WHERE customer_id = customers.id AND status IN ('confirmed', 'shipped', 'delivered', 'received', 'completed')) as total_spent
      FROM customers
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return result.rows;
  }

  /**
   * Count total customers
   */
  static async count() {
    const result = await pool.query('SELECT COUNT(*) FROM customers');
    return parseInt(result.rows[0].count);
  }

  /**
   * Search customers
   */
  static async search(query, limit = 20) {
    const result = await pool.query(`
      SELECT id, name, email, phone, created_at
      FROM customers
      WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [`%${query}%`, limit]);
    return result.rows;
  }
}

// PREFERRED_FIELDS is exported for callers that want to build
// SQL fragments dynamically (not currently used, but harmless).
Customer.PREFERRED_FIELDS = PREFERRED_FIELDS;

module.exports = Customer;