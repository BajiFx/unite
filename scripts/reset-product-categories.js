// scripts/reset-product-categories.js
require('dotenv').config();
const { pool } = require('../src/config/database');

(async () => {
  try {
    console.log('▶ reset-product-categories: starting');

    // 1. Drop the table if it exists (CASCADE also removes dependent FKs).
    const dropRes = await pool.query('DROP TABLE IF EXISTS product_categories CASCADE');
    console.log('   DROP TABLE: done, rowCount =', dropRes.rowCount);

    // 2. Remove the migration record so run.js will re-apply it.
    const delRes = await pool.query(
      "DELETE FROM schema_migrations WHERE filename = '20260911-product-categories.sql'"
    );
    console.log('   DELETE FROM schema_migrations: removed', delRes.rowCount, 'row(s)');

    // 3. Confirm the current state.
    const tbl = await pool.query("SELECT to_regclass('public.product_categories') AS t");
    console.log('   product_categories now:', tbl.rows[0].t);

    const col = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'product_category_id'"
    );
    console.log('   products.product_category_id now:', col.rows[0] ? col.rows[0].column_name : 'missing');

    console.log('✅ reset-product-categories: finished');
  } catch (err) {
    console.error('❌ reset-product-categories: FAILED —', err.message);
    process.exitCode = 1;
  } finally {
    // Ensure the process exits even if pool.end() hangs on a bad connection.
    await pool.end().catch(() => {});
  }
})();