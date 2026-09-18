/**
 * One-time, idempotent migration: Campus Wallet + schema hardening.
 *
 * Adds:
 *   - wallets table (one row per student, ledger-backed balance cache)
 *   - wallet_transactions table (append-only ledger; the monthly credit period is
 *     enforced unique per wallet via a generated column — ORDER debits may repeat)
 *   - payments.payment_method column (STUDENT_WALLET)
 *   - normalized payments.status enum (SUCCESS) — 'Failed' was never written by real code
 *   - performance indexes (orders queue/user, wallet history)
 *
 * Backfills:
 *   - one wallet per existing student (balance ₹0), then an idempotent
 *     MONTHLY_CREDIT ledger row for the current period, balance = ₹500.
 *     The credit is guarded by the (wallet_id, reference_type, period) unique key
 *     AND the wallet row lock, so it can never double-apply.
 *
 * Safe to run multiple times; every step checks before altering.
 *
 * Usage:  cd server && npm run migrate
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const MONTHLY_ALLOWANCE = 500;

function currentPeriod(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(rows[0].count) > 0;
}

async function indexExists(connection, table, indexName) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  return Number(rows[0].count) > 0;
}

async function tableExists(connection, table) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS count FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return Number(rows[0].count) > 0;
}

/**
 * Idempotently ensure a wallet exists for a user and grant the monthly
 * allowance for `period` if it has not been granted yet.
 * Runs inside one transaction; wallet row is locked FOR UPDATE.
 * Returns { walletId, credited } where credited is true only when the
 * allowance was inserted by THIS call.
 */
async function ensureWalletAndMonthlyCredit(connection, userId, period, description) {
  await connection.query('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0)', [userId]);
  const [walletRows] = await connection.query(
    'SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE',
    [userId]
  );
  const wallet = walletRows[0];

  const [existing] = await connection.query(
    `SELECT id FROM wallet_transactions
     WHERE wallet_id = ? AND reference_type = 'MONTHLY_CREDIT' AND period = ?
     LIMIT 1`,
    [wallet.id, period]
  );
  if (existing.length) {
    return { walletId: wallet.id, credited: false };
  }

  // Fresh period: insert the ledger row first (unique key is the final guard),
  // then bump the balance — both inside the same transaction/lock.
  const [result] = await connection.query(
    `INSERT INTO wallet_transactions
       (wallet_id, type, amount, balance_after, reference_type, period, description)
     VALUES (?, 'CREDIT', ?, ?, 'MONTHLY_CREDIT', ?, ?)`,
    [
      wallet.id,
      MONTHLY_ALLOWANCE.toFixed(2),
      (Number(wallet.balance) + MONTHLY_ALLOWANCE).toFixed(2),
      period,
      description || `Monthly campus allowance — ${period}`
    ]
  );
  await connection.query(
    'UPDATE wallets SET balance = balance + ? WHERE id = ?',
    [MONTHLY_ALLOWANCE.toFixed(2), wallet.id]
  );
  return { walletId: wallet.id, credited: result.affectedRows === 1 };
}

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'canteen_db',
    multipleStatements: false
  });

  const period = currentPeriod();

  try {
    /* ── 1. wallets ─────────────────────────────────────────────── */
    if (!(await tableExists(connection, 'wallets'))) {
      await connection.query(`
        CREATE TABLE wallets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL UNIQUE,
          balance DECIMAL(10,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
          monthly_allowance DECIMAL(10,2) NOT NULL DEFAULT ${MONTHLY_ALLOWANCE}.00 CHECK (monthly_allowance > 0),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
      console.log('[migrate] created table wallets');
    } else {
      console.log('[migrate] wallets already exists');
    }

    /* ── 2. wallet_transactions (ledger) ────────────────────────── */
    if (!(await tableExists(connection, 'wallet_transactions'))) {
      await connection.query(`
        CREATE TABLE wallet_transactions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          wallet_id INT NOT NULL,
          type ENUM('CREDIT','DEBIT') NOT NULL,
          amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
          balance_after DECIMAL(10,2) NOT NULL,
          reference_type ENUM('MONTHLY_CREDIT','ORDER','ADJUSTMENT') NOT NULL,
          reference_id INT NULL,
          period CHAR(7) NULL,
          description VARCHAR(255) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
          -- Uniqueness ONLY applies to monthly credits (ORDER debits repeat freely
          -- within a period — that is normal spending). The generated column is
          -- NULL for non-credit rows, and MySQL allows multiple NULLs in a
          -- unique index, so idempotency is enforced exactly where it matters.
          credit_period CHAR(7) GENERATED ALWAYS AS (IF(reference_type = 'MONTHLY_CREDIT', period, NULL)) STORED,
          UNIQUE KEY uq_wallet_credit_period (wallet_id, credit_period),
          INDEX idx_wt_wallet_created (wallet_id, created_at DESC),
          INDEX idx_wt_wallet_period (wallet_id, period),
          INDEX idx_wt_reference (reference_type, reference_id)
        )`);
      console.log('[migrate] created table wallet_transactions');
    } else {
      console.log('[migrate] wallet_transactions already exists');
    }

    /* ── 3. payments: payment_method + normalized status ─────────── */
    if (!(await columnExists(connection, 'payments', 'payment_method'))) {
      await connection.query(
        `ALTER TABLE payments
         ADD COLUMN payment_method ENUM('STUDENT_WALLET') NOT NULL AFTER order_id,
         MODIFY status ENUM('SUCCESS') NOT NULL`
      );
      console.log('[migrate] payments: added payment_method, normalized status enum to SUCCESS');
    } else {
      console.log('[migrate] payments.payment_method already exists');
    }

    /* ── 4. orders performance indexes ──────────────────────────── */
    if (!(await indexExists(connection, 'orders', 'idx_orders_queue'))) {
      await connection.query(
        'ALTER TABLE orders ADD INDEX idx_orders_queue (status, created_at, id)'
      );
      console.log('[migrate] orders: added idx_orders_queue (status, created_at, id)');
    }
    if (!(await indexExists(connection, 'orders', 'idx_orders_user_status'))) {
      await connection.query(
        'ALTER TABLE orders ADD INDEX idx_orders_user_status (user_id, status)'
      );
      console.log('[migrate] orders: added idx_orders_user_status (user_id, status)');
    }

    /* ── 5. Backfill wallets for existing students ───────────────── */
    const [students] = await connection.query("SELECT id FROM users WHERE role = 'student'");
    let credited = 0;
    for (const student of students) {
      await connection.beginTransaction();
      try {
        const outcome = await ensureWalletAndMonthlyCredit(connection, student.id, period);
        if (outcome.credited) credited += 1;
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
    console.log(
      `[migrate] wallet backfill complete: ${students.length} student wallet(s) ensured, ${credited} credited for ${period}`
    );
    console.log('[migrate] DONE — wallet schema is up to date.');
  } finally {
    await connection.end();
  }
}

module.exports = { ensureWalletAndMonthlyCredit, currentPeriod, MONTHLY_ALLOWANCE };

// When run directly, execute the migration.
if (require.main === module) {
  run().catch(error => {
    console.error('[migrate] FAILED:', error.message);
    process.exit(1);
  });
}
