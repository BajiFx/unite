require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/database');

// ============================================================
//  MIGRATION RUNNER
//  Location: migrations/run.js
//
//  Behaviour:
//   1. Ensures the schema_migrations tracking table exists.
//   2. Always runs multi-vendor-schema.sql first (baseline).
//   3. Runs every other .sql file in the folder in lexical order
//      (date-prefixed names such as 20260911-*.sql sort correctly).
//   4. Wraps each migration in its own transaction so a failure
//      never leaves a half-applied state.
//   5. Records the filename in schema_migrations once it commits.
// ============================================================

async function ensureTrackingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function listSqlFiles() {
  const sqlDir = path.join(__dirname, 'sql');
  const files = fs
    .readdirSync(sqlDir)
    .filter(file => file.toLowerCase().endsWith('.sql'));

  if (files.length === 0) {
    throw new Error('No SQL migration files found in migrations/sql');
  }

  // Sort so the baseline always runs first, then everything else in
  // lexicographic order. Because every later migration is prefixed
  // with a YYYYMMDD date, this produces the correct chronological order.
  const BASELINE = 'multi-vendor-schema.sql';
  files.sort((left, right) => {
    if (left === BASELINE) return -1;
    if (right === BASELINE) return 1;
    return left.localeCompare(right);
  });

  return { sqlDir, files, baseline: BASELINE };
}

async function isApplied(filename) {
  const result = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE filename = $1',
    [filename]
  );
  return result.rows.length > 0;
}

async function markApplied(filename) {
  await pool.query(
    'INSERT INTO schema_migrations (filename) VALUES ($1)',
    [filename]
  );
}

async function applyFile(sqlDir, filename) {
  const filePath = path.join(sqlDir, filename);
  const sql = fs.readFileSync(filePath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    error.migrationFile = filename;
    throw error;
  } finally {
    client.release();
  }
}

async function handleBaselineIfNeeded(sqlDir, baseline, files) {
  // If the businesses table already exists but the baseline is not
  // recorded as applied, mark it so we do not try to re-create it.
  const baselineApplied = await isApplied(baseline);
  if (baselineApplied) return;

  const businessTable = await pool.query(
    "SELECT to_regclass('public.businesses') AS table_name"
  );

  if (businessTable.rows[0].table_name) {
    await markApplied(baseline);
    console.log(`Marked existing schema baseline as applied: ${baseline}`);
  }
}

async function runMigrations() {
  const { sqlDir, files, baseline } = listSqlFiles();

  await ensureTrackingTable();
  await handleBaselineIfNeeded(sqlDir, baseline, files);

  for (const file of files) {
    if (await isApplied(file)) {
      console.log(`Skipping applied migration: ${file}`);
      continue;
    }

    console.log(`Running migration: ${file}`);
    try {
      await applyFile(sqlDir, file);
      await markApplied(file);
      console.log(`Completed migration: ${file}`);
    } catch (error) {
      console.error(`❌ Migration failed in ${file}: ${error.message}`);
      if (error.detail) console.error(`   Detail: ${error.detail}`);
      if (error.hint) console.error(`   Hint: ${error.hint}`);
      throw error;
    }
  }

  console.log('✅ All migrations are up to date.');
}

runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async error => {
    console.error('Migration failed:', error.message);
    if (error.migrationFile) {
      console.error(`Failed file: ${error.migrationFile}`);
    }
    await pool.end();
    process.exit(1);
  });