/**
 * wallet-audit.js — Wallet ledger integrity auditor & repairer.
 *
 * Invariant (the "single source of truth" rule):
 *   wallets.balance === Σ(signed wallet_transactions.amount)
 *     CREDIT → +amount, DEBIT → −amount, for every reference_type.
 *
 * `wallets.balance` is only a cache maintained inside the same transaction as
 * each ledger write. The setup.sql seed bug (a ₹500 ledger credit written with
 * balance 0) showed that drift CAN happen, so every server boot verifies the
 * invariant and repairs any drift by recomputing the cache from the ledger.
 *
 * CLI:   node wallet-audit.js           → report only (exit 1 if drift)
 *        node wallet-audit.js --repair  → report + repair
 */

const BALANCE_INVARIANT_SQL = `
  SELECT w.id, w.balance AS stored_balance,
         COALESCE(SUM(CASE wt.type WHEN 'CREDIT' THEN wt.amount ELSE -wt.amount END), 0) AS ledger_balance,
         COUNT(wt.id) AS ledger_rows
  FROM wallets w
  LEFT JOIN wallet_transactions wt ON wt.wallet_id = w.id
  GROUP BY w.id, w.balance
  HAVING stored_balance <> ledger_balance`;

/** Returns one row per wallet whose cached balance disagrees with its ledger. */
async function auditWalletIntegrity(db) {
  const [rows] = await db.query(BALANCE_INVARIANT_SQL);
  return rows.map(row => ({
    walletId: Number(row.id),
    storedBalance: Number(row.stored_balance),
    ledgerBalance: Number(row.ledger_balance),
    drift: Number(row.stored_balance) - Number(row.ledger_balance),
    ledgerRows: Number(row.ledger_rows)
  }));
}

/**
 * Recompute one wallet's balance from its ledger inside a locked transaction.
 * Repairs the CACHE only — the ledger is never rewritten, so the audit trail
 * of every rupee is preserved. Returns the applied correction, or null when
 * the wallet was already consistent (concurrent repair / race).
 */
async function repairWalletBalance(db, walletId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    try {
      const [walletRows] = await connection.query(
        'SELECT id, balance FROM wallets WHERE id=? FOR UPDATE',
        [walletId]
      );
      if (!walletRows.length) {
        await connection.rollback();
        return null;
      }
      const before = Number(walletRows[0].balance);
      const [[agg]] = await connection.query(
        `SELECT COALESCE(SUM(CASE type WHEN 'CREDIT' THEN amount ELSE -amount END), 0) AS total
         FROM wallet_transactions WHERE wallet_id=?`,
        [walletId]
      );
      // The ledger itself must never imply a negative wallet — that would mean
      // corruption beyond cache drift, and we refuse to "repair" it silently.
      const after = Number(agg.total);
      if (after < 0) {
        await connection.rollback();
        throw new Error(`Ledger for wallet ${walletId} sums to ₹${after.toFixed(2)} — refusing to auto-repair. Investigate manually.`);
      }
      await connection.query('UPDATE wallets SET balance=? WHERE id=?', [after.toFixed(2), walletId]);
      await connection.commit();
      return { walletId, before, after };
    } catch (error) {
      try { await connection.rollback(); } catch { /* ignore */ }
      throw error;
    }
  } finally {
    connection.release();
  }
}

/** Audit + repair every drifted wallet. Returns { discrepancies, repaired }. */
async function auditAndRepair(db, { repair = false, log = console } = {}) {
  const discrepancies = await auditWalletIntegrity(db);
  if (!discrepancies.length) return { discrepancies, repaired: [] };

  for (const d of discrepancies) {
    log.warn(
      `[wallet:audit] DRIFT wallet #${d.walletId}: cached ₹${d.storedBalance.toFixed(2)} vs ledger ₹${d.ledgerBalance.toFixed(2)} (Δ ₹${d.drift.toFixed(2)})`
    );
  }
  if (!repair) return { discrepancies, repaired: [] };

  const repaired = [];
  for (const d of discrepancies) {
    try {
      const result = await repairWalletBalance(db, d.walletId);
      if (result) {
        repaired.push(result);
        log.warn(
          `[wallet:audit] REPAIRED wallet #${result.walletId}: ₹${result.before.toFixed(2)} → ₹${result.after.toFixed(2)} (recomputed from ledger)`
        );
      }
    } catch (error) {
      log.error(`[wallet:audit] repair failed for wallet #${d.walletId}: ${error.message}`);
    }
  }
  return { discrepancies, repaired };
}

/* ─── CLI ─────────────────────────────────────────────────── */
if (require.main === module) {
  require('dotenv').config();
  const mysql = require('mysql2/promise');
  const repair = process.argv.includes('--repair');
  (async () => {
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'canteen_db',
      connectionLimit: 2
    });
    try {
      const { discrepancies, repaired } = await auditAndRepair(pool, { repair });
      if (!discrepancies.length) {
        console.log('[wallet:audit] OK — every wallet balance matches its ledger.');
        return;
      }
      console.table(discrepancies.map(d => ({
        wallet: d.walletId,
        cached_balance: d.storedBalance.toFixed(2),
        ledger_balance: d.ledgerBalance.toFixed(2),
        drift: d.drift.toFixed(2)
      })));
      if (repair) {
        console.log(`[wallet:audit] repaired ${repaired.length}/${discrepancies.length} wallet(s).`);
      } else {
        console.log('[wallet:audit] drift found. Re-run with --repair to restore from the ledger.');
        process.exitCode = 1;
      }
    } finally {
      await pool.end();
    }
  })().catch(error => {
    console.error('[wallet:audit] FAILED:', error.message);
    process.exit(1);
  });
}

module.exports = { auditWalletIntegrity, repairWalletBalance, auditAndRepair, BALANCE_INVARIANT_SQL };
