/**
 * Integration tests — Campus Canteen wallet system.
 *
 * Self-contained: creates its own test user(s), normalizes the seed account
 * passwords it needs, and verifies core invariants:
 *
 *   AUTH      register / duplicate / login / bad password / bad JWT / RBAC
 *   WALLET    ₹500 registration credit, idempotent monthly credit, ledger
 *   CHECKOUT  success, exact balance → ₹0.00, insufficient → 402 (no side
 *             effects), single debit, ownership protection
 *   CONCUR    5 parallel checkouts on ₹500 → exactly 1 success (no double-spend)
 *   ORDERS    admin queue workflow Preparing→Ready→Collected, invalid transition
 *   SECURITY  rate limiting, SSE leak check, dashboard wallet analytics
 *
 * Prereqs: MySQL running with schema applied (npm run db:reset) and the API
 * listening on http://localhost:5099 (SERVER_PORT=5099 npm start).
 *
 * Usage: cd server && npm test
 */
process.env.NODE_ENV = 'test';
require('dotenv').config();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5099';
const SEED_PW = 'TestPass123!';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000) // fail fast instead of hanging the suite
  });
  let data = null;
  let raw = '';
  try {
    raw = await response.text();
    data = JSON.parse(raw);
  } catch {
    data = { success: false, error: `non-JSON response: ${raw.slice(0, 120)}` };
  }
  return { status: response.status, data, raw };
}

const uniq = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function main() {
  const t0 = Date.now();
  const tick = label => console.log(`  ⏱ ${label} at ${(Date.now() - t0) / 1000 | 0}s`);

  /* ── Setup: normalize seed passwords, ensure funds on seed wallet ── */
  const mysql = require('mysql2/promise');
  const bcrypt = require('bcrypt');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'canteen_db'
  });
  const seedHash = await bcrypt.hash(SEED_PW, 10);
  await connection.query('UPDATE users SET password=? WHERE email IN (?, ?)', [
    seedHash, 'admin@canteen.com', 'student@canteen.com'
  ]);
  const [walletRows] = await connection.query(
    `SELECT w.id, w.balance FROM wallets w JOIN users u ON u.id = w.user_id
     WHERE u.email = 'student@canteen.com'`
  );
  if (walletRows.length && Number(walletRows[0].balance) !== 500) {
    await connection.query('UPDATE wallets SET balance=500 WHERE id=?', [walletRows[0].id]);
    await connection.query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, balance_after, reference_type, period, description)
       VALUES (?, 'CREDIT', 500, 500, 'ADJUSTMENT', NULL, 'Test setup')`,
      [walletRows[0].id]
    );
  }
  const [[stock]] = await connection.query(
    "SELECT available_quantity FROM menu_items WHERE id=3"
  );
  await connection.end();

  /* ── AUTH ─────────────────────────────────────────────────── */
  console.log('\nAUTH');
  const email = `student${uniq()}@campus.edu`;
  let r = await api('/api/health');
  check('health endpoint', r.data.success === true);

  r = await api('/api/auth/register', { method: 'POST', body: { name: 'Test Student', email, password: 'secret123' } });
  check('register success', r.status === 201 && r.data.success === true, r.raw.slice(0, 120));
  check('register mentions wallet credit', /wallet|₹500|500/i.test(r.raw));

  r = await api('/api/auth/register', { method: 'POST', body: { name: 'Test Student', email, password: 'secret123' } });
  check('duplicate email rejected (409)', r.status === 409);

  r = await api('/api/auth/register', { method: 'POST', body: { name: 'Shorty', email: `s${uniq()}@x.com`, password: 'abc' } });
  check('short password rejected', r.status === 400 && /6 and 72/.test(r.raw));

  r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrongpass' } });
  check('wrong password → 401', r.status === 401 && /Invalid email or password/.test(r.raw));

  r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'secret123' } });
  const token = r.data?.data?.token;
  check('login returns JWT', Boolean(token));

  r = await api('/api/auth/me', { token });
  check('auth/me returns profile', r.data?.data?.email === email);

  r = await api('/api/auth/me', { token: 'garbage.token.here' });
  check('garbage JWT → 401', r.status === 401);

  r = await api('/api/dashboard', { token });
  check('student blocked from admin dashboard (403)', r.status === 403);

  r = await api('/api/wallet');
  check('wallet requires auth (401)', r.status === 401);

  /* ── WALLET ───────────────────────────────────────────────── */
  console.log('\nWALLET');
  r = await api('/api/wallet', { token });
  const wallet = r.data?.data || {};
  check('new student balance = 500', wallet.balance === 500, `got ${wallet.balance}`);
  check('monthly_credit = 500', wallet.monthly_credit === 500);
  check('monthly_allowance = 500', wallet.monthly_allowance === 500);
  check('next_reset present', Boolean(wallet.next_reset));
  check('recent transactions present', Array.isArray(wallet.recent_transactions));

  r = await api('/api/wallet/transactions', { token });
  check('ledger contains MONTHLY_CREDIT', JSON.stringify(r.data?.data?.transactions || []).includes('MONTHLY_CREDIT'));
  check('ledger total = 1 (credit only)', r.data?.data?.total === 1, `got ${r.data?.data?.total}`);

  r = await api('/api/wallet/insights', { token });
  check('insights endpoint works', r.data?.success === true);
  check('insights has deterministic fields', ['by_category', 'top_items', 'monthly_trend', 'daily_burn_rate'].every(k => k in (r.data?.data || {})));

  // Idempotency under concurrency: 20 parallel wallet loads → still 1 credit.
  tick('before concurrent wallet loads');
  await Promise.all(Array.from({ length: 20 }, () => api('/api/wallet', { token })));
  tick('after concurrent wallet loads');
  r = await api('/api/wallet/transactions?type=CREDIT', { token });
  check('20 concurrent wallet loads → still exactly 1 credit', r.data?.data?.total === 1, `got ${r.data?.data?.total}`);
  r = await api('/api/wallet', { token });
  check('balance still 500 after concurrent loads', r.data?.data?.balance === 500);

  /* ── CHECKOUT ─────────────────────────────────────────────── */
  console.log('\nCHECKOUT');
  r = await api('/api/orders/preview', { method: 'POST', token, body: { cart: [{ id: 1, quantity: 2 }, { id: 3, quantity: 3 }] } });
  check('preview ok', r.data?.success === true && r.data?.data?.total_amount === 120, r.raw.slice(0, 120));

  r = await api('/api/orders/checkout', { method: 'POST', token, body: { cart: [{ id: 1, quantity: 2 }, { id: 3, quantity: 3 }] } });
  check('checkout succeeds (STUDENT_WALLET)', r.data?.data?.payment_method === 'STUDENT_WALLET', r.raw.slice(0, 160));
  check('checkout remaining balance 380.00', r.data?.data?.wallet_balance === '380.00');
  const orderToken = r.data?.data?.token;

  r = await api(`/api/orders/${orderToken}`, { token });
  check('token detail (owner)', r.data?.data?.status === 'Preparing');

  r = await api('/api/orders/C-DEADBEEF', { token });
  check("foreign/nonexistent token → 404", r.status === 404);

  r = await api('/api/orders/checkout', { method: 'POST', token, body: { cart: [{ id: 5, quantity: 7 }] } });
  check('insufficient balance → 402', r.status === 402, r.raw.slice(0, 160));
  check('insufficient message includes amounts', /Insufficient wallet balance\. Available: ₹0*/.test(r.raw) && /Required: ₹/.test(r.raw));
  check('failed checkout creates no order data', !r.data?.data?.orderId);

  r = await api('/api/wallet', { token });
  check('balance unchanged after failed checkout (380)', r.data?.data?.balance === 380, `got ${r.data?.data?.balance}`);

  r = await api('/api/wallet/transactions?type=DEBIT', { token });
  check('exactly one DEBIT row', r.data?.data?.total === 1, `got ${r.data?.data?.total}`);

  r = await api('/api/orders/checkout', { method: 'POST', token, body: { cart: [{ id: 3, quantity: 19 }] } });
  check('exact balance checkout → 0.00 remaining', r.data?.data?.wallet_balance === '0.00', r.raw.slice(0, 160));

  r = await api('/api/wallet', { token });
  check('balance is exactly 0', r.data?.data?.balance === 0);

  r = await api('/api/orders/checkout', { method: 'POST', token, body: { cart: [{ id: 3, quantity: 1 }] } });
  check('zero balance checkout → 402', r.status === 402);

  /* ── CONCURRENCY ──────────────────────────────────────────── */
  console.log('\nCONCURRENCY');
  r = await api('/api/auth/login', { method: 'POST', body: { email: 'student@canteen.com', password: SEED_PW } });
  const seedToken = r.data?.data?.token;
  check('seed student login', Boolean(seedToken));

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    api('/api/orders/checkout', { method: 'POST', token: seedToken, body: { cart: [{ id: 3, quantity: 19 }] } })
  ));
  const successes = results.filter(x => x.status === 201).length;
  // A losing concurrent checkout is rejected either with 402 (insufficient funds
  // after the winner debited) or 429 (per-user checkout mutex busy). Both are
  // controlled, side-effect-free failures — the invariant is "never two successes".
  const controlled = results.filter(x => x.status === 402 || x.status === 429).length;
  const unexpected = results.filter(x => ![201, 402, 429].includes(x.status)).length;
  check('5 parallel ₹380 checkouts on ₹500 → exactly 1 success', successes === 1, `successes=${successes}`);
  check('4 rejected with controlled 402/429', controlled === 4 && unexpected === 0, JSON.stringify(results.map(r => r.status)));

  r = await api('/api/wallet', { token: seedToken });
  check('seed balance 120 (single debit)', r.data?.data?.balance === 120, `got ${r.data?.data?.balance}`);

  r = await api('/api/wallet/transactions?type=DEBIT', { token: seedToken });
  check('seed ledger shows exactly 1 order debit', r.data?.data?.total === 1, `got ${r.data?.data?.total}`);

  /* ── ORDERS / ADMIN ───────────────────────────────────────── */
  console.log('\nORDERS + ADMIN');
  r = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@canteen.com', password: SEED_PW } });
  const adminToken = r.data?.data?.token;
  check('admin login', Boolean(adminToken));

  r = await api('/api/orders', { token: adminToken });
  check('admin queue returns orders', r.data?.success === true && Array.isArray(r.data?.data));
  const firstOrder = r.data?.data?.[0];
  check('queue has student_name', Boolean(firstOrder?.student_name));

  r = await api(`/api/orders/${firstOrder.id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Collected' } });
  check('invalid transition blocked', r.status === 409);

  r = await api(`/api/orders/${firstOrder.id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Ready' } });
  check('Preparing → Ready', r.data?.data?.status === 'Ready');

  r = await api(`/api/orders/${firstOrder.id}/status`, { method: 'PUT', token: adminToken, body: { status: 'Collected' } });
  check('Ready → Collected', r.data?.data?.status === 'Collected');

  r = await api('/api/dashboard', { token: adminToken });
  check('dashboard wallet analytics present', Boolean(r.data?.data?.wallet));
  check('monthly utilization field', 'monthly_utilization_pct' in (r.data?.data?.wallet || {}));

  r = await api('/api/orders/my-orders', { token });
  check('my-orders includes queue_position', 'queue_position' in (r.data?.data?.current?.[0] || {}));

  /* ── SECURITY ─────────────────────────────────────────────── */
  console.log('\nSECURITY');
  const codes = [];
  for (let i = 0; i < 14; i += 1) {
    const attempt = await api('/api/auth/login', { method: 'POST', body: { email: 'nobody@nowhere.com', password: 'nope12345' } });
    codes.push(attempt.status);
  }
  check('rate limiting engages (429 present)', codes.includes(429), codes.join(','));
  check('not all requests 429 (limiter window correct)', codes.slice(0, 5).some(c => c === 401));

  // SSE leak check: raw stream must not carry protected fields.
  const sseResponse = await fetch(`${BASE}/api/orders/stream`);
  const reader = sseResponse.body.getReader();
  let streamText = '';
  const timeout = setTimeout(() => { try { reader.cancel(); } catch { /* ignore */ } }, 1500);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += new TextDecoder().decode(value);
      if (streamText.length > 2000) break;
    }
  } catch { /* connection closed by cancel */ }
  clearTimeout(timeout);
  try { reader.cancel(); } catch { /* ignore */ }
  check('SSE stream opens', streamText.includes('CONNECTED'));
  check('SSE leaks no protected data', !/balance|total_amount|password|"amount"/.test(streamText));

  console.log('\n====================================');
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:', failures.join(' | '));
    process.exit(1);
  }
}

main().catch(error => {
  console.error('TEST RUN ERROR:', error);
  process.exit(1);
});
