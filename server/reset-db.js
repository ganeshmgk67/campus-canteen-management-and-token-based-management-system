/**
 * Database reset for development/testing: drops and recreates canteen_db
 * from database/setup.sql. The wallet migration backfill runs at server boot.
 *
 * WARNING: destructive — local development and test runs only.
 *
 * Usage: cd server && npm run db:reset
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true
  });
  try {
    await connection.query('DROP DATABASE IF EXISTS canteen_db');
    const setupPath = path.join(__dirname, '..', 'database', 'setup.sql');
    await connection.query(fs.readFileSync(setupPath, 'utf8'));
    console.log('[reset] canteen_db recreated from database/setup.sql');
    console.log('[reset] Note: seed passwords are rotated on next server boot.');
  } finally {
    await connection.end();
  }
}

run().catch(error => {
  console.error('[reset] FAILED:', error.message);
  process.exit(1);
});
