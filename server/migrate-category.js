require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'canteen_db'
  });
  try {
    const [columns] = await pool.query("SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='menu_items' AND column_name='category'");
    if (!Number(columns[0].count)) {
      await pool.query("ALTER TABLE menu_items ADD COLUMN category ENUM('Breakfast','Snacks','Beverages') NOT NULL DEFAULT 'Snacks' AFTER availability_status");
      await pool.query("UPDATE menu_items SET category=CASE WHEN LOWER(name) IN ('idli','dosa') THEN 'Breakfast' WHEN LOWER(name) LIKE '%coffee%' OR LOWER(name) LIKE '%tea%' THEN 'Beverages' ELSE 'Snacks' END");
      console.log('Category column added and existing menu items classified.');
    } else console.log('Category column already exists.');
  } finally {
    await pool.end();
  }
}

run().catch(error => { console.error(error.message); process.exit(1); });
