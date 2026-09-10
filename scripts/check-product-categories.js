// scripts/check-product-categories.js
require('dotenv').config();
const { pool } = require('../src/config/database');

(async () => {
  try {
    const a = await pool.query('SELECT COUNT(*) FROM product_categories');
    const b = await pool.query(
      'SELECT COUNT(*) FROM product_categories WHERE business_category_id IS NULL'
    );
    const c = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name='products' AND column_name='product_category_id'"
    );
    console.log('product_categories rows           :', a.rows[0].count);
    console.log('product_categories w/ NULL buscat :', b.rows[0].count);
    console.log('products.product_category_id      :', c.rows[0]?.column_name || 'MISSING');
  } catch (err) {
    console.error('❌ Check failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();