// ============================================================
//  BUSINESS MODEL - Complete with Delivery System
//  Location: src/models/Business.js
// ============================================================

const { pool } = require('../config/database');
const { generateSlug } = require('../utils/helpers');
const { getDistance } = require('../utils/helpers');

class Business {
    /**
     * Create a new business
     */
    static async create(data) {
        const {
            business_name, owner_id, category_ids = [],
            location, address, latitude, longitude,
            description, mission, vision, logo, heroImage,
            whatsapp, tiktok, instagram, facebook, phone, email, website,
            mpesa_enabled, mpesa_number, airtel_enabled, airtel_number,
            bank_enabled, bank_name, bank_account, bank_account_name,
            paypal_enabled, paypal_email,
            shipping_policy, return_policy, terms_policy, privacy_policy,
            delivery_enabled, online_orders_enabled
        } = data;

        // Generate slug from business name
        let slug = generateSlug(business_name);

        // Check if slug exists
        const existing = await pool.query(
            'SELECT id FROM businesses WHERE slug = $1',
            [slug]
        );

        if (existing.rows.length > 0) {
            slug = `${slug}-${Date.now().toString().slice(-4)}`;
        }

        const result = await pool.query(`
            INSERT INTO businesses (
                business_name, slug, owner_id, location, address,
                latitude, longitude, description, mission, vision,
                logo, heroImage, whatsapp, tiktok, instagram, facebook,
                phone, email, website,
                mpesa_enabled, mpesa_number, airtel_enabled, airtel_number,
                bank_enabled, bank_name, bank_account, bank_account_name,
                paypal_enabled, paypal_email,
                shipping_policy, return_policy, terms_policy, privacy_policy,
                delivery_enabled, online_orders_enabled
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
            RETURNING *
        `, [
            business_name, slug, owner_id, location, address,
            latitude, longitude, description, mission, vision,
            logo, heroImage, whatsapp, tiktok, instagram, facebook,
            phone, email, website,
            mpesa_enabled || false, mpesa_number || null,
            airtel_enabled || false, airtel_number || null,
            bank_enabled || false, bank_name || null, bank_account || null, bank_account_name || null,
            paypal_enabled || false, paypal_email || null,
            shipping_policy || null, return_policy || null, terms_policy || null, privacy_policy || null,
            delivery_enabled !== false, online_orders_enabled !== false
        ]);

        const business = result.rows[0];

        // Add categories
        if (category_ids && category_ids.length > 0) {
            for (const categoryId of category_ids) {
                await pool.query(
                    `INSERT INTO business_category_assignments (business_id, category_id)
                     VALUES ($1, $2)`,
                    [business.id, categoryId]
                );
            }
        }

        // Create business stats
        await pool.query(
            `INSERT INTO business_stats (business_id) VALUES ($1)`,
            [business.id]
        );

        return business;
    }

    /**
     * Get business by slug
     */
    static async findBySlug(slug) {
        const result = await pool.query(`
            SELECT * FROM business_list_view WHERE slug = $1
        `, [slug]);
        return result.rows[0] || null;
    }

    /**
     * Get business by ID
     */
    static async findById(id) {
        const result = await pool.query(`
            SELECT * FROM business_list_view WHERE id = $1
        `, [id]);
        return result.rows[0] || null;
    }

    /**
     * Get all businesses with filters
     */
    static async findAll({ search, category, featured, verified, limit = 20, offset = 0 }) {
        let query = `
            SELECT * FROM business_list_view
        `;
        const params = [];
        const conditions = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(business_name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (featured === 'true') {
            conditions.push(`is_featured = true`);
        }

        if (verified === 'true') {
            conditions.push(`is_verified = true`);
        }

        if (category) {
            conditions.push(`$${paramIndex} = ANY(category_ids)`);
            params.push(parseInt(category));
            paramIndex++;
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY is_featured DESC, created_at DESC';
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);
        return result.rows;
    }

    /**
     * Count businesses with filters
     */
    static async count({ search, category, featured, verified }) {
        let query = `SELECT COUNT(*) FROM business_list_view`;
        const params = [];
        const conditions = [];
        let paramIndex = 1;

        if (search) {
            conditions.push(`(business_name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (featured === 'true') {
            conditions.push(`is_featured = true`);
        }

        if (verified === 'true') {
            conditions.push(`is_verified = true`);
        }

        if (category) {
            conditions.push(`$${paramIndex} = ANY(category_ids)`);
            params.push(parseInt(category));
            paramIndex++;
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        const result = await pool.query(query, params);
        return parseInt(result.rows[0].count);
    }

    /**
     * Update business
     */
    static async update(id, data) {
        const allowedFields = [
            'business_name', 'location', 'address', 'latitude', 'longitude',
            'description', 'mission', 'vision', 'logo', 'heroImage',
            'whatsapp', 'tiktok', 'instagram', 'facebook', 'phone', 'email', 'website',
            'mpesa_enabled', 'mpesa_number', 'airtel_enabled', 'airtel_number',
            'bank_enabled', 'bank_name', 'bank_account', 'bank_account_name',
            'paypal_enabled', 'paypal_email',
            'shipping_policy', 'return_policy', 'terms_policy', 'privacy_policy',
            'delivery_enabled', 'online_orders_enabled',
            'is_active', 'is_verified', 'is_featured',
            'location_sharing_enabled', 'admin_lat', 'admin_lng'
        ];

        const fields = [];
        const values = [];
        let paramIndex = 1;

        // Check if business_name changed - update slug
        if (data.business_name) {
            const current = await this.findById(id);
            if (current && current.business_name !== data.business_name) {
                let slug = generateSlug(data.business_name);
                const existing = await pool.query(
                    'SELECT id FROM businesses WHERE slug = $1 AND id != $2',
                    [slug, id]
                );
                if (existing.rows.length > 0) {
                    slug = `${slug}-${Date.now().toString().slice(-4)}`;
                }
                fields.push(`slug = $${paramIndex}`);
                values.push(slug);
                paramIndex++;
            }
        }

        for (const field of allowedFields) {
            if (data[field] !== undefined && field !== 'business_name') {
                fields.push(`${field} = $${paramIndex}`);
                values.push(data[field]);
                paramIndex++;
            }
        }

        if (fields.length === 0) return null;

        values.push(id);
        const query = `
            UPDATE businesses
            SET ${fields.join(', ')}, updated_at = NOW()
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0] || null;
    }

    /**
     * Delete business (soft delete)
     */
    static async delete(id) {
        const result = await pool.query(
            'UPDATE businesses SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
            [id]
        );
        return result.rows[0] || null;
    }

    /**
     * Get business statistics
     */
    static async getStats(id) {
        const result = await pool.query(`
            SELECT * FROM business_stats WHERE business_id = $1
        `, [id]);
        return result.rows[0] || null;
    }

    /**
     * Get business categories
     */
    static async getCategories(id) {
        const result = await pool.query(`
            SELECT c.*
            FROM business_categories c
            JOIN business_category_assignments bca ON bca.category_id = c.id
            WHERE bca.business_id = $1
            ORDER BY c.name
        `, [id]);
        return result.rows;
    }

    /**
     * Get business products
     */
    static async getProducts(id, { search, category, isFlashSale, isNewArrival, limit = 20, offset = 0 }) {
        let query = `
            SELECT p.*
            FROM products p
            WHERE p.business_id = $1 AND p.is_active = true
        `;
        const params = [id];
        let paramIndex = 2;

        if (search) {
            query += ` AND p.name ILIKE $${paramIndex}`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        if (category) {
            query += ` AND p.category = $${paramIndex}`;
            params.push(category);
            paramIndex++;
        }

        if (isFlashSale === 'true') {
            query += ` AND p.isFlashSale = true`;
        }

        if (isNewArrival === 'true') {
            query += ` AND p.isNewArrival = true`;
        }

        query += ` ORDER BY p.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);
        return result.rows;
    }

    /**
     * Get business orders (for business admin)
     */
    static async getOrders(id, { status, limit = 50, offset = 0 }) {
        let query = `
            SELECT o.*, c.name AS customer_name, c.email AS customer_email
            FROM orders o
            JOIN customers c ON o.customer_id = c.id
            WHERE o.business_id = $1
        `;
        const params = [id];
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
     * Add review to business
     */
    static async addReview(id, customerId, rating, reviewText) {
        const result = await pool.query(`
            INSERT INTO business_reviews (business_id, customer_id, rating, review_text)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (business_id, customer_id)
            DO UPDATE SET rating = $3, review_text = $4, created_at = NOW()
            RETURNING *
        `, [id, customerId, rating, reviewText]);
        return result.rows[0];
    }

    /**
     * Get business reviews
     */
    static async getReviews(id, limit = 20) {
        const result = await pool.query(`
            SELECT br.*, c.name AS customer_name
            FROM business_reviews br
            JOIN customers c ON br.customer_id = c.id
            WHERE br.business_id = $1
            ORDER BY br.created_at DESC
            LIMIT $2
        `, [id, limit]);
        return result.rows;
    }

    /**
     * Follow/unfollow business
     */
    static async toggleFollow(id, customerId) {
        const existing = await pool.query(
            'SELECT 1 FROM business_followers WHERE business_id = $1 AND customer_id = $2',
            [id, customerId]
        );

        if (existing.rows.length > 0) {
            await pool.query(
                'DELETE FROM business_followers WHERE business_id = $1 AND customer_id = $2',
                [id, customerId]
            );
            return { action: 'unfollowed' };
        } else {
            await pool.query(
                'INSERT INTO business_followers (business_id, customer_id) VALUES ($1, $2)',
                [id, customerId]
            );
            return { action: 'followed' };
        }
    }

    /**
     * Check if customer follows business
     */
    static async isFollowing(id, customerId) {
        const result = await pool.query(
            'SELECT 1 FROM business_followers WHERE business_id = $1 AND customer_id = $2',
            [id, customerId]
        );
        return result.rows.length > 0;
    }

    /**
     * Get featured businesses
     */
    static async getFeatured(limit = 6) {
        const result = await pool.query(`
            SELECT * FROM business_list_view
            WHERE is_featured = true AND is_active = true
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    /**
     * Get businesses by owner
     */
    static async findByOwner(ownerId) {
        const result = await pool.query(`
            SELECT * FROM business_list_view WHERE owner_id = $1
        `, [ownerId]);
        return result.rows;
    }

    /**
     * Get all categories
     */
    static async getAllCategories() {
        const result = await pool.query(`
            SELECT * FROM business_categories ORDER BY name
        `);
        return result.rows;
    }

    /**
     * Get businesses for super admin (including inactive)
     */
    static async findAllForAdmin({ search, status, limit = 50, offset = 0 }) {
        let query = `
            SELECT b.*,
                   a.email AS owner_email,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id) as product_count,
                   (SELECT COUNT(*) FROM orders WHERE business_id = b.id) as order_count
            FROM businesses b
            LEFT JOIN admin_users a ON b.owner_id = a.id
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
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY b.created_at DESC';
        query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);
        return result.rows;
    }

    // ============================================================
    //  DELIVERY SYSTEM METHODS
    // ============================================================

    /**
     * Get delivery settings for a business
     */
    static async getDeliverySettings(businessId) {
        const result = await pool.query(`
            SELECT
                delivery_enabled,
                delivery_offered,
                delivery_free,
                delivery_free_where,
                delivery_no_message,
                delivery_free_message,
                delivery_paid_message,
                delivery_areas,
                delivery_fee_type,
                delivery_fee_fixed,
                delivery_fee_per_km,
                delivery_min_order_free,
                delivery_max_distance_km,
                delivery_days,
                delivery_time_slots,
                delivery_cutoff_time,
                delivery_estimated_time,
                delivery_policy,
                meeting_points,
                latitude,
                longitude,
                business_name
            FROM businesses
            WHERE id = $1
        `, [businessId]);

        if (result.rows.length === 0) return null;

        const settings = result.rows[0];

        // Parse JSON fields
        if (settings.delivery_areas && typeof settings.delivery_areas === 'string') {
            try { settings.delivery_areas = JSON.parse(settings.delivery_areas); } catch(e) { settings.delivery_areas = []; }
        }
        if (settings.delivery_days && typeof settings.delivery_days === 'string') {
            try { settings.delivery_days = JSON.parse(settings.delivery_days); } catch(e) { settings.delivery_days = ['mon','tue','wed','thu','fri','sat']; }
        }
        if (settings.delivery_time_slots && typeof settings.delivery_time_slots === 'string') {
            try { settings.delivery_time_slots = JSON.parse(settings.delivery_time_slots); } catch(e) { settings.delivery_time_slots = ['morning', 'afternoon']; }
        }
        if (settings.meeting_points && typeof settings.meeting_points === 'string') {
            try { settings.meeting_points = JSON.parse(settings.meeting_points); } catch(e) { settings.meeting_points = []; }
        }

        return settings;
    }

    /**
     * Update delivery settings
     */
    static async updateDeliverySettings(businessId, settings) {
        const {
            delivery_offered,
            delivery_free,
            delivery_free_where,
            delivery_no_message,
            delivery_free_message,
            delivery_paid_message,
            delivery_areas,
            delivery_fee_type,
            delivery_fee_fixed,
            delivery_fee_per_km,
            delivery_min_order_free,
            delivery_max_distance_km,
            delivery_days,
            delivery_time_slots,
            delivery_cutoff_time,
            delivery_estimated_time,
            delivery_policy,
            meeting_points
        } = settings;

        const updates = [];
        const values = [];
        let paramIndex = 1;

        // Only add fields that are provided
        if (delivery_offered !== undefined) {
            updates.push(`delivery_offered = $${paramIndex}`);
            values.push(delivery_offered);
            paramIndex++;
        }
        if (delivery_free !== undefined) {
            updates.push(`delivery_free = $${paramIndex}`);
            values.push(delivery_free);
            paramIndex++;
        }
        if (delivery_free_where !== undefined) {
            updates.push(`delivery_free_where = $${paramIndex}`);
            values.push(delivery_free_where);
            paramIndex++;
        }
        if (delivery_no_message !== undefined) {
            updates.push(`delivery_no_message = $${paramIndex}`);
            values.push(delivery_no_message);
            paramIndex++;
        }
        if (delivery_free_message !== undefined) {
            updates.push(`delivery_free_message = $${paramIndex}`);
            values.push(delivery_free_message);
            paramIndex++;
        }
        if (delivery_paid_message !== undefined) {
            updates.push(`delivery_paid_message = $${paramIndex}`);
            values.push(delivery_paid_message);
            paramIndex++;
        }
        if (delivery_areas !== undefined) {
            updates.push(`delivery_areas = $${paramIndex}`);
            values.push(JSON.stringify(delivery_areas || []));
            paramIndex++;
        }
        if (delivery_fee_type !== undefined) {
            updates.push(`delivery_fee_type = $${paramIndex}`);
            values.push(delivery_fee_type);
            paramIndex++;
        }
        if (delivery_fee_fixed !== undefined) {
            updates.push(`delivery_fee_fixed = $${paramIndex}`);
            values.push(parseFloat(delivery_fee_fixed) || 0);
            paramIndex++;
        }
        if (delivery_fee_per_km !== undefined) {
            updates.push(`delivery_fee_per_km = $${paramIndex}`);
            values.push(parseFloat(delivery_fee_per_km) || 0);
            paramIndex++;
        }
        if (delivery_min_order_free !== undefined) {
            updates.push(`delivery_min_order_free = $${paramIndex}`);
            values.push(parseFloat(delivery_min_order_free) || 0);
            paramIndex++;
        }
        if (delivery_max_distance_km !== undefined) {
            updates.push(`delivery_max_distance_km = $${paramIndex}`);
            values.push(parseInt(delivery_max_distance_km) || 50);
            paramIndex++;
        }
        if (delivery_days !== undefined) {
            updates.push(`delivery_days = $${paramIndex}`);
            values.push(JSON.stringify(delivery_days || ['mon','tue','wed','thu','fri','sat']));
            paramIndex++;
        }
        if (delivery_time_slots !== undefined) {
            updates.push(`delivery_time_slots = $${paramIndex}`);
            values.push(JSON.stringify(delivery_time_slots || ['morning', 'afternoon']));
            paramIndex++;
        }
        if (delivery_cutoff_time !== undefined) {
            updates.push(`delivery_cutoff_time = $${paramIndex}`);
            values.push(delivery_cutoff_time || '14:00');
            paramIndex++;
        }
        if (delivery_estimated_time !== undefined) {
            updates.push(`delivery_estimated_time = $${paramIndex}`);
            values.push(delivery_estimated_time || 'Same day (orders before 2pm)');
            paramIndex++;
        }
        if (delivery_policy !== undefined) {
            updates.push(`delivery_policy = $${paramIndex}`);
            values.push(delivery_policy);
            paramIndex++;
        }
        if (meeting_points !== undefined) {
            updates.push(`meeting_points = $${paramIndex}`);
            values.push(JSON.stringify(meeting_points || []));
            paramIndex++;
        }

        if (updates.length === 0) return null;

        updates.push(`updated_at = NOW()`);
        values.push(businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0] || null;
    }

    /**
     * Calculate delivery fee for a customer
     */
    static async calculateDeliveryFee(businessId, customerLat, customerLng, subtotal) {
        const settings = await this.getDeliverySettings(businessId);

        if (!settings || !settings.delivery_enabled) {
            return {
                available: false,
                method: 'pickup',
                fee: 0,
                message: 'Delivery not available',
                options: ['pickup']
            };
        }

        // Get business location
        const business = await this.findById(businessId);
        if (!business) {
            return {
                available: false,
                method: 'pickup',
                fee: 0,
                message: 'Business not found',
                options: ['pickup']
            };
        }

        // Check if free delivery based on minimum order
        if (settings.delivery_min_order_free > 0 && subtotal >= settings.delivery_min_order_free) {
            return {
                available: true,
                method: 'delivery',
                fee: 0,
                message: '🎉 Free delivery (minimum order met)',
                estimated_time: settings.delivery_estimated_time || 'Same day',
                options: ['delivery', 'pickup']
            };
        }

        // Calculate based on fee type
        let fee = 0;
        let message = '';
        let estimated_time = settings.delivery_estimated_time || 'Same day';

        switch(settings.delivery_fee_type) {
            case 'fixed':
                fee = parseFloat(settings.delivery_fee_fixed) || 0;
                message = `Fixed delivery fee: Ksh ${fee.toFixed(2)}`;
                break;

            case 'per_km':
                if (customerLat && customerLng && business.latitude && business.longitude) {
                    const distance = getDistance(
                        parseFloat(business.latitude),
                        parseFloat(business.longitude),
                        parseFloat(customerLat),
                        parseFloat(customerLng)
                    );
                    const distanceKm = distance / 1000;
                    const perKm = parseFloat(settings.delivery_fee_per_km) || 50;
                    fee = distanceKm * perKm;
                    message = `Ksh ${fee.toFixed(2)} (${distanceKm.toFixed(1)} km × Ksh ${perKm}/km)`;

                    // Check if beyond max distance
                    const maxDist = settings.delivery_max_distance_km || 50;
                    if (distanceKm > maxDist) {
                        return {
                            available: false,
                            method: 'pickup',
                            fee: 0,
                            message: `Delivery not available (${distanceKm.toFixed(1)} km beyond ${maxDist} km limit)`,
                            options: ['pickup']
                        };
                    }
                } else {
                    fee = 0;
                    message = 'Unable to calculate distance. Please enable location.';
                }
                break;

            case 'distance_based':
                // Check if area has specific fee
                if (settings.delivery_areas && settings.delivery_areas.length > 0) {
                    // For now, use the first area's fee
                    const area = settings.delivery_areas[0];
                    fee = parseFloat(area.fee) || 0;
                    estimated_time = area.time || settings.delivery_estimated_time || 'Same day';
                    message = `Delivery fee: Ksh ${fee.toFixed(2)} (${area.name})`;
                } else {
                    fee = 0;
                    message = 'No delivery areas configured';
                }
                break;

            case 'free':
                fee = 0;
                message = '🎉 Free delivery';
                break;

            default:
                fee = 0;
                message = 'Delivery fee not configured';
        }

        return {
            available: true,
            method: 'delivery',
            fee: fee,
            message: message,
            estimated_time: estimated_time,
            options: ['delivery', 'pickup']
        };
    }

    /**
     * Get all meeting points for a business
     */
    static async getMeetingPoints(businessId) {
        const result = await pool.query(
            `SELECT * FROM meeting_points WHERE business_id = $1 AND is_active = true ORDER BY name`,
            [businessId]
        );
        return result.rows;
    }

    /**
     * Add meeting point
     */
    static async addMeetingPoint(businessId, data) {
        const { name, address, lat, lng, contact_phone, operating_hours } = data;
        const result = await pool.query(`
            INSERT INTO meeting_points (business_id, name, address, lat, lng, contact_phone, operating_hours)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [businessId, name, address, lat, lng, contact_phone, operating_hours]);
        return result.rows[0];
    }

    /**
     * Delete meeting point
     */
    static async deleteMeetingPoint(id, businessId) {
        const result = await pool.query(
            'DELETE FROM meeting_points WHERE id = $1 AND business_id = $2 RETURNING id',
            [id, businessId]
        );
        return result.rows[0] || null;
    }

    /**
     * Generate meeting code
     */
    static generateMeetingCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    /**
     * Get delivery areas for a business
     */
    static async getDeliveryAreas(businessId) {
        const result = await pool.query(
            `SELECT * FROM delivery_areas WHERE business_id = $1 AND is_active = true ORDER BY name`,
            [businessId]
        );
        return result.rows;
    }

    /**
     * Add delivery area
     */
    static async addDeliveryArea(businessId, data) {
        const { name, fee, estimated_days, estimated_time } = data;
        const result = await pool.query(`
            INSERT INTO delivery_areas (business_id, name, fee, estimated_days, estimated_time)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `, [businessId, name, fee, estimated_days || 1, estimated_time || 'Same day']);
        return result.rows[0];
    }

    /**
     * Delete delivery area
     */
    static async deleteDeliveryArea(id, businessId) {
        const result = await pool.query(
            'DELETE FROM delivery_areas WHERE id = $1 AND business_id = $2 RETURNING id',
            [id, businessId]
        );
        return result.rows[0] || null;
    }

    /**
     * Update delivery log
     */
    static async updateDeliveryLog(orderId, status, data = {}) {
        const { driver_name, driver_phone, tracking_number, notes } = data;

        // Check if log exists
        const existing = await pool.query(
            'SELECT id FROM delivery_logs WHERE order_id = $1',
            [orderId]
        );

        if (existing.rows.length > 0) {
            const result = await pool.query(`
                UPDATE delivery_logs
                SET status = $1,
                    driver_name = COALESCE($2, driver_name),
                    driver_phone = COALESCE($3, driver_phone),
                    tracking_number = COALESCE($4, tracking_number),
                    picked_up_at = CASE WHEN $1 = 'picked_up' THEN NOW() ELSE picked_up_at END,
                    delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
                    notes = COALESCE($5, notes),
                    updated_at = NOW()
                WHERE order_id = $6
                RETURNING *
            `, [status, driver_name, driver_phone, tracking_number, notes, orderId]);
            return result.rows[0];
        } else {
            // Get business_id from order
            const orderResult = await pool.query(
                'SELECT business_id FROM orders WHERE id = $1',
                [orderId]
            );
            const businessId = orderResult.rows[0]?.business_id;

            if (!businessId) return null;

            const result = await pool.query(`
                INSERT INTO delivery_logs (order_id, business_id, status, driver_name, driver_phone, tracking_number, notes)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [orderId, businessId, status, driver_name, driver_phone, tracking_number, notes]);
            return result.rows[0];
        }
    }

    /**
     * Get delivery log for an order
     */
    static async getDeliveryLog(orderId) {
        const result = await pool.query(
            'SELECT * FROM delivery_logs WHERE order_id = $1',
            [orderId]
        );
        return result.rows[0] || null;
    }

    /**
     * Get business order settings
     */
    static async getOrderSettings(businessId) {
        const result = await pool.query(`
            SELECT
                online_orders_enabled,
                order_regions,
                order_cutoff_time,
                order_processing_time,
                auto_cancel_hours,
                auto_complete_days,
                replacement_hours,
                status_pending,
                status_pending_payment,
                status_confirmed,
                status_shipped,
                status_delivered,
                status_received,
                status_cancelled,
                status_completed,
                return_policy,
                return_window_days
            FROM businesses
            WHERE id = $1
        `, [businessId]);

        if (result.rows.length === 0) return null;
        return result.rows[0];
    }

    /**
     * Update business order settings
     */
    static async updateOrderSettings(businessId, settings) {
        const {
            online_orders_enabled,
            order_regions,
            order_cutoff_time,
            order_processing_time,
            auto_cancel_hours,
            auto_complete_days,
            replacement_hours,
            status_pending,
            status_pending_payment,
            status_confirmed,
            status_shipped,
            status_delivered,
            status_received,
            status_cancelled,
            status_completed,
            return_policy,
            return_window_days
        } = settings;

        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (online_orders_enabled !== undefined) {
            updates.push(`online_orders_enabled = $${paramIndex}`);
            values.push(online_orders_enabled);
            paramIndex++;
        }
        if (order_regions !== undefined) {
            updates.push(`order_regions = $${paramIndex}`);
            values.push(order_regions);
            paramIndex++;
        }
        if (order_cutoff_time !== undefined) {
            updates.push(`order_cutoff_time = $${paramIndex}`);
            values.push(order_cutoff_time);
            paramIndex++;
        }
        if (order_processing_time !== undefined) {
            updates.push(`order_processing_time = $${paramIndex}`);
            values.push(order_processing_time);
            paramIndex++;
        }
        if (auto_cancel_hours !== undefined) {
            updates.push(`auto_cancel_hours = $${paramIndex}`);
            values.push(parseInt(auto_cancel_hours) || 24);
            paramIndex++;
        }
        if (auto_complete_days !== undefined) {
            updates.push(`auto_complete_days = $${paramIndex}`);
            values.push(parseInt(auto_complete_days) || 7);
            paramIndex++;
        }
        if (replacement_hours !== undefined) {
            updates.push(`replacement_hours = $${paramIndex}`);
            values.push(parseInt(replacement_hours) || 6);
            paramIndex++;
        }
        if (status_pending !== undefined) {
            updates.push(`status_pending = $${paramIndex}`);
            values.push(status_pending);
            paramIndex++;
        }
        if (status_pending_payment !== undefined) {
            updates.push(`status_pending_payment = $${paramIndex}`);
            values.push(status_pending_payment);
            paramIndex++;
        }
        if (status_confirmed !== undefined) {
            updates.push(`status_confirmed = $${paramIndex}`);
            values.push(status_confirmed);
            paramIndex++;
        }
        if (status_shipped !== undefined) {
            updates.push(`status_shipped = $${paramIndex}`);
            values.push(status_shipped);
            paramIndex++;
        }
        if (status_delivered !== undefined) {
            updates.push(`status_delivered = $${paramIndex}`);
            values.push(status_delivered);
            paramIndex++;
        }
        if (status_received !== undefined) {
            updates.push(`status_received = $${paramIndex}`);
            values.push(status_received);
            paramIndex++;
        }
        if (status_cancelled !== undefined) {
            updates.push(`status_cancelled = $${paramIndex}`);
            values.push(status_cancelled);
            paramIndex++;
        }
        if (status_completed !== undefined) {
            updates.push(`status_completed = $${paramIndex}`);
            values.push(status_completed);
            paramIndex++;
        }
        if (return_policy !== undefined) {
            updates.push(`return_policy = $${paramIndex}`);
            values.push(return_policy);
            paramIndex++;
        }
        if (return_window_days !== undefined) {
            updates.push(`return_window_days = $${paramIndex}`);
            values.push(parseInt(return_window_days) || 14);
            paramIndex++;
        }

        if (updates.length === 0) return null;

        updates.push(`updated_at = NOW()`);
        values.push(businessId);

        const query = `
            UPDATE businesses
            SET ${updates.join(', ')}
            WHERE id = $${paramIndex}
            RETURNING *
        `;

        const result = await pool.query(query, values);
        return result.rows[0] || null;
    }

    /**
     * Get business by slug with all settings
     */
    static async getBusinessWithSettings(slug) {
        const result = await pool.query(`
            SELECT b.*,
                   (SELECT COUNT(*) FROM products WHERE business_id = b.id AND is_active = true) as product_count,
                   (SELECT COALESCE(AVG(rating), 0) FROM business_reviews WHERE business_id = b.id) as avg_rating,
                   (SELECT COUNT(*) FROM business_reviews WHERE business_id = b.id) as review_count,
                   (SELECT COUNT(*) FROM business_followers WHERE business_id = b.id) as follower_count
            FROM businesses b
            WHERE b.slug = $1 AND b.is_active = true
        `, [slug]);
        return result.rows[0] || null;
    }
}

module.exports = Business;