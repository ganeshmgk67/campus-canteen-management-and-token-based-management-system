/**
 * wallet.js — Student Campus Wallet service.
 *
 * Design:
 *  - The ledger (wallet_transactions) is the source of truth for history;
 *    wallets.balance is a cached aggregate maintained in the SAME transaction
 *    as every ledger write, and protected against negative values by a CHECK.
 *  - Monthly ₹500 credits are idempotent: unique key (wallet_id,
 *    reference_type='MONTHLY_CREDIT', period='YYYY-MM') + wallet row lock.
 *  - Debits only ever happen inside the checkout transaction with the wallet
 *    row locked FOR UPDATE — the caller (checkout) owns that transaction.
 */
const { ensureWalletAndMonthlyCredit, currentPeriod, MONTHLY_ALLOWANCE } = require('./migrate-wallet');

module.exports = { ensureWalletAndMonthlyCredit, currentPeriod, MONTHLY_ALLOWANCE };
