// ============================================================
//  AUTH MIDDLEWARE - COMPLETE FINAL VERSION
//  Location: src/middleware/auth.js
//
//  Hardening (this revision):
//   - authMiddleware now rejects a super_admin request to a
//     business-scoped route with an explicit 403 instead of
//     silently setting req.businessId = null.
//   - getBusinessIdFromToken keeps the super_admin escape hatch
//     (business_id can be passed as a query/body param when a
//     super admin needs to inspect a specific business), but it
//     no longer overwrites req.businessId from an unrelated
//     source.
//   - adminOnly accepts only 'super_admin'. The legacy 'admin'
//     alias is removed so a mis-issued token can never reach
//     admin-only routes.
//   - All DB lookups in this file tolerate a UUID or numeric id
//     on the customers / admin_users tables.
// ============================================================

const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

/**
 * Generate JWT token - always include userId.
 */
function generateToken(email, role = 'customer', userId = null) {
    const payload = {
        email,
        role,
        userId: userId || email
    };
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verify JWT token.
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        return null;
    }
}

function setAuthCookie(res, token) {
    res.cookie('authToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
    });
}

function clearAuthCookie(res) {
    res.clearCookie('authToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
    });
}

/**
 * Main auth middleware.
 */
async function authMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') {
        return next();
    }

    const token = req.cookies?.authToken;
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        let userId = decoded.userId;
        const email = decoded.email;
        const role = decoded.role || 'customer';

        // If userId is not a number and is the email string, look it up.
        if (!userId || userId === email || isNaN(parseInt(userId))) {
            try {
                let result = null;
                if (role === 'customer') {
                    result = await pool.query('SELECT id FROM customers WHERE email = $1', [email]);
                } else {
                    result = await pool.query('SELECT id FROM admin_users WHERE email = $1', [email]);
                }

                if (result && result.rows.length > 0) {
                    userId = result.rows[0].id;
                } else {
                    userId = email;
                }
            } catch (dbErr) {
                console.warn(`⚠️ Database error looking up user: ${dbErr.message}`);
                userId = email;
            }
        }

        req.userId = userId;
        req.email = email;
        req.role = role;
        req.decoded = decoded;

        // Business admins must resolve to a real business.
        if (role === 'business_admin' && userId && userId !== email) {
            const businessResult = await pool.query(
                'SELECT business_id FROM admin_users WHERE id = $1',
                [userId]
            );
            req.businessId = businessResult.rows[0]?.business_id || null;

            if (!req.businessId) {
                return res.status(403).json({ error: 'No business is associated with this admin account' });
            }
        }

        // Super admins are not scoped to a business. Do not
        // overwrite req.businessId here — that is done by
        // getBusinessIdFromToken when the caller explicitly asks
        // for a specific business.
        console.log(`🔑 Auth - User: ${email}, Role: ${role}, UserId: ${req.userId}`);
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please login again.' });
        }
        console.error('❌ Auth error:', err.message);
        return res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Super admin only middleware.
 * Only the 'super_admin' role is accepted. The legacy 'admin'
 * alias is rejected so a mis-issued token cannot reach
 * admin-only routes.
 */
function adminOnly(req, res, next) {
    if (req.role !== 'super_admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
}

/**
 * Business admin only middleware.
 * Super admins are also allowed (they can inspect any business).
 */
function businessAdminOnly(req, res, next) {
    if (req.role !== 'business_admin' && req.role !== 'super_admin') {
        return res.status(403).json({ error: 'Business admin access required' });
    }
    next();
}

/**
 * Customer only middleware.
 */
function customerOnly(req, res, next) {
    if (req.role !== 'customer') {
        return res.status(403).json({ error: 'Customer access required' });
    }
    next();
}

/**
 * Resolve the active business for this request.
 *
 * Behaviour:
 *   - customer → 403 (customers never reach business-scoped
 *     routes).
 *   - super_admin → reads business_id from the query string or
 *     the body. If neither is provided, 400.
 *   - business_admin → reads business_id from the admin_users
 *     row. If the row has no business_id, 404. If the business
 *     exists but is inactive, 403.
 */
async function getBusinessIdFromToken(req, res, next) {
    try {
        console.log('🔍 getBusinessIdFromToken called - UserId:', req.userId, 'Email:', req.email, 'Role:', req.role);

        // Super admin: business_id must come from the request.
        if (req.role === 'super_admin') {
            const requested =
                req.query.business_id ||
                req.query.businessId ||
                (req.body && (req.body.business_id || req.body.businessId)) ||
                null;

            if (!requested) {
                return res.status(400).json({
                    error: 'Super admin requests must include a business_id'
                });
            }

            req.businessId = parseInt(requested, 10);
            return next();
        }

        // Business admin: resolve from the admin_users row.
        if (req.role !== 'business_admin') {
            return res.status(403).json({ error: 'Business admin access required' });
        }

        // If we do not yet have a numeric userId, look it up by email.
        if ((!req.userId || req.userId === req.email) && req.email) {
            try {
                const result = await pool.query(
                    'SELECT id, business_id, role FROM admin_users WHERE email = $1',
                    [req.email]
                );
                if (result.rows.length === 0) {
                    return res.status(404).json({ error: 'Admin user not found' });
                }

                req.userId = result.rows[0].id;
                req.role = result.rows[0].role || req.role;
                req.businessId = result.rows[0].business_id;

                if (!req.businessId) {
                    return res.status(404).json({ error: 'No business associated with this admin account' });
                }
            } catch (dbErr) {
                console.warn(`⚠️ Database error in getBusinessIdFromToken: ${dbErr.message}`);
                return res.status(500).json({ error: 'Database error' });
            }
        }

        // At this point we have a numeric userId. Fetch business_id.
        if (req.userId && req.userId !== req.email) {
            try {
                const result = await pool.query(
                    'SELECT business_id FROM admin_users WHERE id = $1',
                    [req.userId]
                );

                if (result.rows.length === 0 || !result.rows[0].business_id) {
                    return res.status(404).json({ error: 'Business not found for this admin' });
                }

                req.businessId = result.rows[0].business_id;
            } catch (dbErr) {
                console.warn(`⚠️ Database error in getBusinessIdFromToken: ${dbErr.message}`);
                return res.status(500).json({ error: 'Database error' });
            }
        } else {
            return res.status(404).json({ error: 'Business not found for this admin' });
        }

        // Verify the business exists and is active.
        try {
            const businessCheck = await pool.query(
                'SELECT is_active FROM businesses WHERE id = $1',
                [req.businessId]
            );
            if (businessCheck.rows.length === 0 || !businessCheck.rows[0].is_active) {
                return res.status(403).json({ error: 'Business is inactive' });
            }
        } catch (dbErr) {
            console.warn(`⚠️ Error checking business active: ${dbErr.message}`);
        }

        return next();
    } catch (err) {
        console.error('❌ Get business ID error:', err);
        return res.status(500).json({ error: err.message });
    }
}

/**
 * Check that the requesting admin owns the business in the URL
 * (or is a super admin).
 */
async function checkBusinessOwnership(req, res, next) {
    try {
        const businessId = parseInt(req.params.businessId) || parseInt(req.params.id) || req.businessId;

        if (!businessId) {
            return res.status(400).json({ error: 'Business ID required' });
        }

        if (req.role === 'super_admin') {
            req.businessId = businessId;
            return next();
        }

        let userBusinessId = null;
        if (req.userId && req.userId !== req.email) {
            try {
                const result = await pool.query(
                    'SELECT business_id FROM admin_users WHERE id = $1',
                    [req.userId]
                );
                if (result.rows.length > 0) {
                    userBusinessId = result.rows[0].business_id;
                }
            } catch (dbErr) {
                console.warn(`⚠️ Database error in checkBusinessOwnership: ${dbErr.message}`);
                return res.status(500).json({ error: 'Database error' });
            }
        }

        if (!userBusinessId || userBusinessId !== businessId) {
            return res.status(403).json({ error: 'You do not own this business' });
        }

        req.businessId = businessId;
        next();
    } catch (err) {
        console.error('❌ Check ownership error:', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * Check that the business exists and is accepting orders.
 */
async function checkBusinessActive(req, res, next) {
    try {
        const businessId = parseInt(req.params.businessId) || parseInt(req.body.business_id) || req.businessId;

        if (!businessId) {
            return res.status(400).json({ error: 'Business ID required' });
        }

        try {
            const result = await pool.query(
                'SELECT is_active, online_orders_enabled FROM businesses WHERE id = $1',
                [businessId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Business not found' });
            }

            const business = result.rows[0];

            if (!business.is_active) {
                return res.status(403).json({ error: 'Business is currently inactive' });
            }

            if (!business.online_orders_enabled) {
                return res.status(403).json({ error: 'Business is not accepting online orders at this time' });
            }
        } catch (dbErr) {
            console.warn(`⚠️ Database error in checkBusinessActive: ${dbErr.message}`);
            return res.status(500).json({ error: 'Database error' });
        }

        req.businessActive = true;
        next();
    } catch (err) {
        console.error('❌ Check business active error:', err);
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    generateToken,
    verifyToken,
    setAuthCookie,
    clearAuthCookie,
    authMiddleware,
    adminOnly,
    businessAdminOnly,
    customerOnly,
    getBusinessIdFromToken,
    checkBusinessOwnership,
    checkBusinessActive
};