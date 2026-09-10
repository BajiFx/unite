/*
 * Read-only authenticated smoke test.
 * Run the app first, then: node scripts/smoke-authenticated.js http://127.0.0.1:3000
 */
require('dotenv').config();

const jwt = require('jsonwebtoken');
const { pool } = require('../src/config/database');

const baseUrl = process.argv[2] || 'http://127.0.0.1:3000';

async function request(path, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: `authToken=${token}` }
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return { path, status: response.status, contentType: response.headers.get('content-type') };
}

async function run() {
  const customerResult = await pool.query(`
    SELECT c.id, c.email,
      (SELECT o.id FROM orders o WHERE o.customer_id = c.id ORDER BY o.id DESC LIMIT 1) AS order_id
    FROM customers c
    ORDER BY c.id DESC LIMIT 1
  `);
  const businessResult = await pool.query(`
    SELECT a.id, a.email
    FROM admin_users a JOIN businesses b ON b.id = a.business_id
    WHERE a.role = 'business_admin' AND b.is_active = true
    LIMIT 1
  `);

  const customer = customerResult.rows[0];
  const businessAdmin = businessResult.rows[0];
  const sign = (email, role, userId) => jwt.sign(
    { email, role, userId }, process.env.JWT_SECRET, { expiresIn: '5m' }
  );
  const checks = [];
  const skipped = [];
  if (customer) {
    const customerToken = sign(customer.email, 'customer', customer.id);
    checks.push(await request('/api/auth/customer/verify', customerToken));
    checks.push(await request('/api/orders', customerToken));
    if (customer.order_id) checks.push(await request(`/api/orders/${customer.order_id}/receipt`, customerToken));
    else skipped.push('receipt (no existing customer order)');
  } else {
    skipped.push('customer routes (no customer account)');
  }
  if (businessAdmin) {
    const businessToken = sign(businessAdmin.email, 'business_admin', businessAdmin.id);
    for (const path of ['/api/auth/my-business', '/api/business-admin/profile', '/api/business-admin/analytics', '/api/business-admin/order-settings', '/api/business-admin/delivery-settings']) {
      checks.push(await request(path, businessToken));
    }
  } else {
    skipped.push('business-admin routes (no active business-admin account)');
  }
  console.log(JSON.stringify({ ok: true, checks, skipped }, null, 2));
}

run()
  .catch(error => {
    console.error(`Smoke test failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
