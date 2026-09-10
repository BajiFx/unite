// ============================================================
//  DATABASE CONFIGURATION - COMPLETE WITH RETRY LOGIC
//  Location: src/config/database.js
//  Compatible with: Aiven PostgreSQL (and Neon)
// ============================================================

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Logging function
function logError(error, context = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    message: error.message || error,
    stack: error.stack,
    ...error
  };

  const logDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  try {
    fs.appendFileSync(
      path.join(logDir, 'error.log'),
      JSON.stringify(logEntry) + '\n'
    );
  } catch (err) {
    // Silently fail if we can't write to log
  }
  console.error('❌ Error:', error.message || error);
}

// ============================================================
//  POOL CONFIGURATION
//  - SSL: rejectUnauthorized false to accept Aiven's self-signed cert
//  - uselibpqcompat=true in URL enables libpq SSL semantics
//  - max: 15 leaves room for admin tools (Aiven allows 20 total)
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true
});

// ============================================================
//  POOL ERROR HANDLING WITH AUTO-RECONNECT
// ============================================================

let isReconnecting = false;

pool.on('error', (err) => {
  console.error('⚠️ PostgreSQL pool error:', err);
  logError(err, 'Database pool error');

  if (!isReconnecting) {
    isReconnecting = true;
    console.log('🔄 Attempting to reconnect to database...');

    setTimeout(() => {
      pool.connect((err2, client, release) => {
        isReconnecting = false;
        if (err2) {
          console.error('❌ Database reconnection failed:', err2);
          logError(err2, 'Database reconnection failed');
          setTimeout(() => {
            if (!isReconnecting) {
              isReconnecting = true;
              console.log('🔄 Retrying database reconnection...');
              pool.connect((err3, client2, release2) => {
                isReconnecting = false;
                if (err3) {
                  console.error('❌ Database still unreachable:', err3);
                  logError(err3, 'Database reconnection retry failed');
                } else {
                  console.log('✅ PostgreSQL reconnected successfully');
                  if (release2) release2();
                }
              });
            }
          }, 10000);
        } else {
          console.log('✅ PostgreSQL reconnected successfully');
          if (release) release();
        }
      });
    }, 5000);
  }
});

// ============================================================
//  CONNECTION VERIFICATION WITH RETRY
// ============================================================

let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

function attemptConnection() {
  connectionAttempts++;
  console.log(`🔄 Database connection attempt ${connectionAttempts}/${MAX_CONNECTION_ATTEMPTS}...`);

  pool.connect((err, client, release) => {
    if (err) {
      console.error('❌ Database connection failed:', err);
      logError(err, 'Database connection failed');

      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        const delay = Math.min(5000 * connectionAttempts, 30000);
        console.log(`⏳ Retrying in ${delay/1000} seconds...`);
        setTimeout(attemptConnection, delay);
      } else {
        console.error('❌ All database connection attempts failed. Please check your DATABASE_URL.');
      }
    } else {
      console.log('✅ PostgreSQL connected successfully');
      connectionAttempts = 0;
      if (release) release();
    }
  });
}

// Start initial connection
attemptConnection();

// ============================================================
//  GRACEFUL SHUTDOWN
// ============================================================

const shutdownHandler = () => {
  console.log('🔄 Closing database pool...');
  pool.end(() => {
    console.log('✅ Database pool closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdownHandler);
process.on('SIGINT', shutdownHandler);

// ============================================================
//  UNHANDLED ERROR HANDLERS
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  logError(err, 'Uncaught Exception');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  logError(reason, 'Unhandled Rejection');
});

// ============================================================
//  HELPER: Test Database Connection
// ============================================================

async function testConnection() {
  try {
    const result = await pool.query('SELECT NOW()');
    return { success: true, timestamp: result.rows[0].now };
  } catch (err) {
    logError(err, 'Test connection');
    return { success: false, error: err.message };
  }
}

// ============================================================
//  HELPER: Execute with Retry
// ============================================================

async function executeWithRetry(query, params, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.query(query, params);
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Query attempt ${attempt}/${maxRetries} failed:`, err.message);

      if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message.includes('terminated')) {
        const delay = Math.min(1000 * attempt, 5000);
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

// ============================================================
//  EXPORTS
// ============================================================

module.exports = {
  pool,
  logError,
  testConnection,
  executeWithRetry
};