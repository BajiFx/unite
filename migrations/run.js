require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/database');

async function runMigrations() {
  const sqlDir = path.join(__dirname, 'sql');
  const files = fs.readdirSync(sqlDir)
    .filter(file => file.endsWith('.sql'))
    .sort((left, right) => {
      if (left === 'multi-vendor-schema.sql') return -1;
      if (right === 'multi-vendor-schema.sql') return 1;
      return left.localeCompare(right);
    });

  if (files.length === 0) {
    throw new Error('No SQL migration files found');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const baseline = 'multi-vendor-schema.sql';
  const baselineApplied = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE filename = $1',
    [baseline]
  );
  const businessTable = await pool.query("SELECT to_regclass('public.businesses') AS table_name");

  if (baselineApplied.rows.length === 0 && businessTable.rows[0].table_name) {
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [baseline]);
    console.log(`Marked existing schema baseline as applied: ${baseline}`);
  }

  for (const file of files) {
    const applied = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (applied.rows.length > 0) {
      console.log(`Skipping applied migration: ${file}`);
      continue;
    }

    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(sqlDir, file), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Completed migration: ${file}`);
  }
}

runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Migration failed:', error.message);
    await pool.end();
    process.exit(1);
  });
