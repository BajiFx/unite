// ============================================================
//  TEST SUPABASE CONNECTION
//  Run: node scripts/test-supabase.js
// ============================================================

const { Pool } = require('pg');

// Load .env
require('dotenv').config();

async function testConnection() {
    console.log('🔍 Testing Supabase connection...');
    console.log('📡 Using DATABASE_URL:', process.env.DATABASE_URL ? '✅ Set' : '❌ Not set');

    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL not set in .env');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const result = await pool.query('SELECT NOW()');
        console.log('✅ Connected to Supabase successfully!');
        console.log('📅 Server time:', result.rows[0].now);

        // Check tables
        const tables = await pool.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        console.log(`\n📋 Tables found: ${tables.rows.length}`);
        tables.rows.forEach(row => {
            console.log(`   - ${row.table_name}`);
        });

        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('❌ Connection failed:', err.message);
        console.error('💡 Check your DATABASE_URL in .env');
        process.exit(1);
    }
}

testConnection();