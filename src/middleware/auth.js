// ============================================================
//  AUTH MIDDLEWARE - COMPLETE FINAL VERSION
//  Location: src/middleware/auth.js
// ============================================================

const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

/**
 * Generate JWT token - FIXED: Always include userId
 */
function generateToken(email, role = 'customer', userId = null) {
    // If userId is not provided, use email as fallback
    const payload = {
        email,
        role,
        userId: userId || email
    };
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Verify JWT token
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
 * Main auth middleware - FIXED: Properly handles authentication
 */
async function authMiddleware(req, res, next) {
    // Allow OPTIONS requests to pass through (for CORS preflight)
    if (req.method === 'OPTIONS') {
        return next();
    }

    const token = req.cookies?.authToken;
    if (!token) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Extract userId from decoded token
        let userId = decoded.userId;
        const email = decoded.email;
        const role = decoded.role || 'customer';

        // If userId is not a number or is the email string, try to look it up
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
                    userId = email; // fallback
                }
            } catch (dbErr) {
                console.warn(`⚠️ Database error looking up user: ${dbErr.message}`);
                userId = email; // fallback
            }
        }

        req.userId = userId;
        req.email = email;
        req.role = role;
        req.decoded = decoded;

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
 * Admin only middleware (super_admin only)
 */
function adminOnly(req, res, next) {
    if (req.role !== 'super_admin' && req.role !== 'admin') {
        return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
}

/**
 * Business admin only middleware
 */
function businessAdminOnly(req, res, next) {
    if (req.role !== 'business_admin' && req.role !== 'super_admin') {
        return res.status(403).json({ error: 'Business admin access required' });
    }
    next();
}

/**
 * Customer only middleware
 */
function customerOnly(req, res, next) {
    if (req.role !== 'customer') {
        return res.status(403).json({ error: 'Customer access required' });
    }
    next();
}

/**
 * Get business ID from token (for business admin) - FIXED
 */
async function getBusinessIdFromToken(req, res, next) {
    try {
        console.log('🔍 getBusinessIdFromToken called - UserId:', req.userId, 'Email:', req.email, 'Role:', req.role);

        // If userId is null or is email string, try to find user by email
        if ((!req.userId || req.userId === req.email) && req.email) {
            try {
                const result = await pool.query(
                    'SELECT id, business_id, role FROM admin_users WHERE email = $1',
                    [req.email]
                );
                if (result.rows.length > 0) {
                    req.userId = result.rows[0].id;
                    req.role = result.rows[0].role || req.role;
                    req.businessId = result.rows[0].business_id;

                    console.log('🔍 Found user:', req.userId, 'BusinessId:', req.businessId);

                    // If business_id is null, return 404
                    if (!req.businessId) {
                        return res.status(404).json({ error: 'No business associated with this admin account' });
                    }

                    // Check if business is active
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
                } else {
                    return res.status(404).json({ error: 'Admin user not found' });
                }
            } catch (dbErr) {
                console.warn(`⚠️ Database error in getBusinessIdFromToken: ${dbErr.message}`);
                return res.status(500).json({ error: 'Database error' });
            }
        }

        // Super admin can access any business
        if (req.role === 'super_admin') {
            req.businessId = req.query.business_id || req.body.business_id || null;
            return next();
        }

        // Check if user is business admin
        if (req.role !== 'business_admin') {
            return res.status(403).json({ error: 'Business admin access required' });
        }

        // Get business_id from user record
        if (req.userId && req.userId !== req.email) {
            try {
                const result = await pool.query(
                    'SELECT business_id FROM admin_users WHERE id = $1',
                    [req.userId]
                );

                if (result.rows.length === 0 || !result.rows[0].business_id) {
                    return res.status(404).json({ error: 'Business not found for this admin' });
                }

                const businessId = result.rows[0].business_id;

                // Check if business is active
                try {
                    const businessCheck = await pool.query(
                        'SELECT is_active FROM businesses WHERE id = $1',
                        [businessId]
                    );
                    if (businessCheck.rows.length === 0 || !businessCheck.rows[0].is_active) {
                        return res.status(403).json({ error: 'Business is inactive' });
                    }
                } catch (dbErr) {
                    console.warn(`⚠️ Error checking business active: ${dbErr.message}`);
                }

                req.businessId = businessId;
                return next();
            } catch (dbErr) {
                console.warn(`⚠️ Database error in getBusinessIdFromToken: ${dbErr.message}`);
                return res.status(500).json({ error: 'Database error' });
            }
        }

        return res.status(404).json({ error: 'Business not found for this admin' });
    } catch (err) {
        console.error('❌ Get business ID error:', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * Check business ownership middleware
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

        // Get user's business_id
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
 * Check if business is active and accepting orders
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
