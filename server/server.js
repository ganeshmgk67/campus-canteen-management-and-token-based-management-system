require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { ensureWalletAndMonthlyCredit, currentPeriod, MONTHLY_ALLOWANCE } = require('./wallet');
const { auditWalletIntegrity } = require('./wallet-audit');

/* ─── Startup Validation ───────────────────────────────────── */
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const PLACEHOLDER_SECRETS = new Set(['change_this_secret', 'change_this_secret_in_env', 'use_a_private_secret', 'your_jwt_secret', 'secret']);
const secretIsPlaceholder = !JWT_SECRET || PLACEHOLDER_SECRETS.has(JWT_SECRET.trim().toLowerCase());

if (IS_PROD && (secretIsPlaceholder || JWT_SECRET.length < 32)) {
  console.error('[FATAL] NODE_ENV=production requires a strong JWT_SECRET (32+ characters, not a placeholder). Refusing to start.');
  process.exit(1);
}
let RESOLVED_JWT_SECRET = JWT_SECRET;
if (secretIsPlaceholder) {
  // Development only: ephemeral per-boot secret instead of a constant known fallback.
  RESOLVED_JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[WARN] JWT_SECRET is not set or is a placeholder. Using an EPHEMERAL secret for this boot only — all sessions will be invalidated on restart. Set a strong secret in server/.env (openssl rand -hex 32).');
}

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const SEED_PASSWORD_HASH_PREFIX = '$2b$10$2xKKGvViyB0cCBNSy.WUPu.'; // legacy public demo hash

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ─── Security Headers ─────────────────────────────────────── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
});

/* ─── CORS ─────────────────────────────────────────────────── */
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // Non-browser tools (curl, health checks) send no Origin; allow those.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false); // no CORS headers → browser blocks the response
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

app.use(express.json({ limit: '100kb' }));

/* ─── Database Pool ────────────────────────────────────────── */
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'canteen_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 50, // bounded queue: pathological overload fails fast instead of hanging
  dateStrings: false,
  namedPlaceholders: false
});

/* ─── Rate Limiting (dependency-free fixed window) ─────────── */
const rateBuckets = new Map();
function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    try {
      const key = `${keyFn(req)}|${Math.floor(Date.now() / windowMs)}`;
      const now = Date.now();
      let bucket = rateBuckets.get(key);
      if (!bucket) { bucket = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, bucket); }
      bucket.count += 1;
      // Opportunistic cleanup to keep memory bounded.
      if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
      }
      if (bucket.count > max) {
        res.set('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
        return res.status(429).json({ success: false, error: 'Too many requests. Please slow down and try again shortly.' });
      }
      return next();
    } catch (error) {
      // Fail CLOSED for auth safety: a broken limiter must not disable protection.
      console.error('[rate-limit]', error);
      return res.status(429).json({ success: false, error: 'Too many requests. Please try again shortly.' });
    }
  };
}
const authIpKey = req => `auth:${req.ip}`;
const loginLimiter  = rateLimit({ windowMs: 15 * 60_000, max: 10,  keyFn: authIpKey });
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 5,  keyFn: authIpKey });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 300, keyFn: authIpKey });
app.use('/api', apiLimiter);

/* ─── SSE Clients ─────────────────────────────────────────── */
const sseClients = new Set();

/* ─── Response Helpers ────────────────────────────────────── */
const ok   = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, error, status = 400) => res.status(status).json({ success: false, error });

/* ─── Money Helpers (all arithmetic in paise to avoid float drift) ─── */
const toPaise = v => Math.round(Number(v) * 100);
const fromPaise = p => Number(p) / 100;
const money = p => fromPaise(p).toFixed(2);

/* ─── Value Helpers ───────────────────────────────────────── */
const asId       = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
const asQuantity = v => Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const activeItem = item => Boolean(item.availability_status) && Number(item.available_quantity) > 0;
const makeToken  = () => `C-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/* ─── SSE Broadcast ───────────────────────────────────────── */
const SSE_ALLOWED_FIELDS = new Set(['type', 'orderId', 'menuItemId', 'userId', 'status']);
function broadcastSSE(data) {
  if (!data || typeof data.type !== 'string' || !SSE_ALLOWED_FIELDS.has(data.type)) {
    // A malformed broadcast is a programming error — fail loudly in dev, quietly in prod.
    if (NODE_ENV !== 'production') console.error('[sse] rejected broadcast:', data);
    return;
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (!client.writableEnded) client.write(payload);
  }
}

/* ─── Auth Middleware ─────────────────────────────────────── */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 'Authentication is required', 401);
  try {
    const identity = jwt.verify(token, RESOLVED_JWT_SECRET);
    if (!identity || !Number.isSafeInteger(Number(identity.id))) return fail(res, 'Your session has expired. Please sign in again.', 401);
    const [rows] = await pool.query('SELECT id, name, email, role FROM users WHERE id=?', [Number(identity.id)]);
    if (!rows.length) return fail(res, 'Your account no longer exists', 401);
    req.user = rows[0];
    return next();
  } catch {
    return fail(res, 'Your session has expired. Please sign in again.', 401);
  }
}

function isAdmin(req, res, next) {
  if (req.user.role !== 'admin') return fail(res, 'Administrator access is required', 403);
  return next();
}

/* ─── Monthly Credit (lazy + scheduler) ───────────────────── */
async function runMonthlyCreditSweep(source) {
  const period = currentPeriod();
  let credited = 0;
  try {
    const [students] = await pool.query("SELECT id FROM users WHERE role='student'");
    for (const student of students) {
      const connection = await pool.getConnection();
      try {
        // Lock-first ordering: acquire the per-user advisory lock BEFORE the
        // transaction so concurrent sweeps queue on GET_LOCK instead of each
        // holding a pool connection (prevents deadlocks/pool starvation).
        const [locks] = await connection.query('SELECT GET_LOCK(?, 3) AS acquired', [`wallet:user:${student.id}`]);
        if (Number(locks[0].acquired) === 1) {
          try {
            await connection.beginTransaction();
            const { credited: didCredit } = await ensureWalletAndMonthlyCredit(
              connection, student.id, period,
              `Monthly campus allowance — ${period}`
            );
            await connection.commit();
            if (didCredit) {
              credited += 1;
              broadcastSSE({ type: 'WALLET_UPDATE', userId: student.id });
            }
          } catch (error) {
            try { await connection.rollback(); } catch { /* ignore */ }
            throw error;
          } finally {
            try { await connection.query('SELECT RELEASE_LOCK(?)', [`wallet:user:${student.id}`]); } catch { /* ignore */ }
          }
        }
      } catch (error) {
        console.error(`[wallet:${source}] credit failed for user ${student.id}:`, error.code || error.message);
      } finally {
        connection.release();
      }
    }
    if (credited) console.log(`[wallet:${source}] credited ${credited} student(s) for ${period}`);
  } catch (error) {
    console.error(`[wallet:${source}] sweep failed:`, error.message);
  }
}

// Hourly sweep: catches students who never logged in + server-was-offline months.
setInterval(() => runMonthlyCreditSweep('scheduler'), 60 * 60 * 1000).unref();
// Boot-time catch-up: guarantees nobody missed a credit while offline.
pool.query('SELECT 1').then(() => runMonthlyCreditSweep('boot')).catch(error => console.error('[boot] DB check failed:', error.message));

/* ─── Wallet Balance Integrity (boot verification) ────────── */
// wallets.balance is a cache of the ledger. Verify the invariant on every
// boot and log any drift (repair is manual: npm run wallet:audit -- --repair).
async function runWalletIntegrityCheck() {
  try {
    const drift = await auditWalletIntegrity(pool);
    if (drift.length) {
      console.warn(`[wallet:integrity] ${drift.length} wallet(s) diverge from their ledger:`);
      for (const d of drift) {
        console.warn(`[wallet:integrity]   wallet #${d.walletId}: cached ₹${d.storedBalance.toFixed(2)} ≠ ledger ₹${d.ledgerBalance.toFixed(2)}`);
      }
      console.warn('[wallet:integrity] Run `npm run wallet:audit -- --repair` to restore balances from the ledger.');
    } else {
      console.log('[wallet:integrity] all wallet balances match their ledger.');
    }
  } catch (error) {
    console.error('[wallet:integrity] check failed:', error.code || error.message);
  }
}

/* ─── Seed credential rotation ────────────────────────────── */
async function rotateLegacySeedPasswords() {
  // Disabled automatic password rotation to maintain default fixed passwords:
  // Admin: admin@canteen.com -> admin123
  // Student: student@canteen.com -> student123
  return;
}

/* ─── Admin — Wallet Management ───────────────────────────── */
// Campus-office flows: inspect student wallet balances (read-only) and issue
// audited top-ups (e.g. a student ran out before month-end). Every credit is
// written to the ledger as an ADJUSTMENT — no balance-only edits, ever.
const TOPUP_REASONS = new Set([
  'Allowance top-up',
  'Compensation for service issue',
  'Staff meal allowance',
  'Manual adjustment'
]);

app.get('/api/admin/wallet/students', authenticate, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, w.balance, w.monthly_allowance,
              COALESCE(SUM(CASE WHEN wt.type='DEBIT' AND wt.period=? THEN wt.amount END), 0) AS spent_this_month
       FROM users u
       JOIN wallets w ON w.user_id = u.id
       LEFT JOIN wallet_transactions wt ON wt.wallet_id = w.id
       WHERE u.role = 'student'
       GROUP BY u.id, u.name, u.email, w.balance, w.monthly_allowance
       ORDER BY u.name`,
      [currentPeriod()]
    );
    return ok(res, rows.map(r => ({
      id: r.id, name: r.name, email: r.email,
      balance: Number(r.balance), monthly_allowance: Number(r.monthly_allowance),
      spent_this_month: Number(r.spent_this_month)
    })));
  } catch (error) {
    console.error('[admin:wallet]', error.code || error.message);
    return fail(res, 'Unable to load student wallets.', 500);
  }
});

app.post('/api/admin/wallet/topup', authenticate, isAdmin, async (req, res) => {
  const userId = asId(req.body?.userId);
  const amountPaise = toPaise(req.body?.amount);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  if (!userId) return fail(res, 'A valid student must be selected.');
  if (!Number.isFinite(Number(req.body?.amount)) || amountPaise < 1000 || amountPaise > 500_00) {
    return fail(res, 'Top-up amount must be between ₹10 and ₹500.');
  }
  if (!TOPUP_REASONS.has(reason)) return fail(res, 'Choose a valid reason for the top-up.');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [students] = await connection.query(
      "SELECT id, name FROM users WHERE id=? AND role='student'", [userId]
    );
    if (!students.length) {
      await connection.rollback();
      return fail(res, 'Student not found.', 404);
    }
    // Lock the wallet row: serializes against checkout and monthly credits.
    await connection.query('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0)', [userId]);
    const [walletRows] = await connection.query('SELECT id, balance FROM wallets WHERE user_id=? FOR UPDATE', [userId]);
    const wallet = walletRows[0];
    const newBalance = Number(wallet.balance) + amountPaise / 100;
    await connection.query(
      `INSERT INTO wallet_transactions
         (wallet_id, type, amount, balance_after, reference_type, reference_id, description)
       VALUES (?, 'CREDIT', ?, ?, 'ADJUSTMENT', ?, ?)`,
      [
        wallet.id, money(amountPaise), newBalance.toFixed(2), req.user.id,
        `${reason}${note ? ` — ${note}` : ''} (by ${req.user.name})`
      ]
    );
    await connection.query('UPDATE wallets SET balance = balance + ? WHERE id = ?', [money(amountPaise), wallet.id]);
    await connection.commit();
    broadcastSSE({ type: 'WALLET_UPDATE', userId });
    console.log(`[admin:wallet] +₹${money(amountPaise)} to user ${userId} (${reason}) by admin ${req.user.id}`);
    return ok(res, { userId, amount: money(amountPaise), balance: newBalance.toFixed(2), reference_type: 'ADJUSTMENT' }, 201);
  } catch (error) {
    try { await connection.rollback(); } catch { /* ignore */ }
    console.error('[admin:wallet:topup]', error.code || error.message);
    return fail(res, 'Top-up could not be completed.', 500);
  } finally {
    connection.release();
  }
});

/* ─── Cart Normalisation ──────────────────────────────────── */
function normaliseCart(cart) {
  if (!Array.isArray(cart) || !cart.length || cart.length > 20) return null;
  const combined = new Map();
  for (const line of cart) {
    const id = asId(line.id);
    const quantity = asQuantity(line.quantity);
    if (!id || !quantity) return null;
    combined.set(id, (combined.get(id) || 0) + quantity);
  }
  const lines = [...combined.entries()].map(([id, quantity]) => ({ id, quantity }));
  return lines.every(l => l.quantity <= 100) ? lines.sort((a, b) => a.id - b.id) : null;
}

/* ─── Pickup Estimate (shared by preview + checkout) ──────── */
function estimatePickup(ordersAhead, lockedItems) {
  const maxPreparation = Math.max(...lockedItems.map(item => Number(item.preparation_time) || 3), 3);
  return new Date(Date.now() + ordersAhead * maxPreparation * 60000);
}

/* ─── Menu Validation ─────────────────────────────────────── */
function validateMenuInput(body, partial = false) {
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  if (has('availability_status') && body.availability_status !== undefined) {
    body.availability_status = Boolean(body.availability_status);
  }
  if (has('description') && body.description == null) {
    body.description = '';
  }
  if (has('image') && body.image == null) {
    body.image = '';
  }
  if (!partial || has('name'))
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100)
      errors.push('Name is required (maximum 100 characters)');
  if (!partial || has('price'))
    if (!Number.isFinite(Number(body.price)) || Number(body.price) <= 0 || toPaise(body.price) < 1)
      errors.push('Price must be greater than 0');
  if (!partial || has('available_quantity'))
    if (asQuantity(body.available_quantity) === null)
      errors.push('Quantity must be a whole number of 0 or more');
  if (has('preparation_time') && (!Number.isInteger(Number(body.preparation_time)) || Number(body.preparation_time) < 1 || Number(body.preparation_time) > 60))
    errors.push('Preparation time must be between 1 and 60 minutes');
  if (has('availability_status') && typeof body.availability_status !== 'boolean')
    errors.push('Availability must be true or false');
  if (has('description') && (typeof body.description !== 'string' || body.description.length > 1000))
    errors.push('Description is invalid');
  if (has('category') && !['Breakfast', 'Snacks', 'Beverages'].includes(body.category))
    errors.push('Category must be Breakfast, Snacks or Beverages');
  if (has('image') && (typeof body.image !== 'string' || body.image.length > 255))
    errors.push('Image filename is invalid');
  return errors;
}

/* ─── Health ──────────────────────────────────────────────── */
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return ok(res, { service: 'canteen-server', uptime: process.uptime() });
  } catch {
    return fail(res, 'Database is unavailable', 503);
  }
});

/* ─── Auth — Register ─────────────────────────────────────── */
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    const cleanName  = typeof name  === 'string' ? name.trim()  : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (
      !cleanName || cleanName.length > 100 ||
      !/^\S+@\S+\.\S+$/.test(cleanEmail) || cleanEmail.length > 100 ||
      typeof password !== 'string' || password.length < 6 || password.length > 72
    ) {
      return fail(res, 'Enter a name, a valid email address, and a password between 6 and 72 characters.');
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const connection = await pool.getConnection();
    let userId;
    try {
      await connection.beginTransaction();
      const [result] = await connection.query(
        "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'student')",
        [cleanName, cleanEmail, hash]
      );
      userId = result.insertId;
      // New eligible students receive the current month's allowance immediately.
      await ensureWalletAndMonthlyCredit(
        connection, userId, currentPeriod(),
        `Monthly campus allowance — ${currentPeriod()}`
      );
      await connection.commit();
    } catch (error) {
      try { await connection.rollback(); } catch { /* ignore */ }
      throw error;
    } finally {
      connection.release();
    }
    return ok(res, { message: 'Registration successful. Your ₹' + MONTHLY_ALLOWANCE + ' monthly campus wallet credit is ready. Please sign in.' }, 201);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return fail(res, 'An account already exists for this email address.', 409);
    }
    console.error('[register]', error.code || error.message);
    return fail(res, 'Registration could not be completed. Please try again.', 500);
  }
});

/* ─── Auth — Login ────────────────────────────────────────── */
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const email    = typeof req.body?.email    === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || !password) {
      return fail(res, 'Enter a valid email address and password.');
    }
    const [rows] = await pool.query('SELECT id, name, password, role FROM users WHERE email = ?', [email]);
    // Constant-work comparison: hash against a dummy hash when user is unknown
    // so response timing does not reveal whether an email exists.
    const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.qGkxNGyzE6nUt6dQ5S8OyGqXo3Yl2Zy';
    const storedHash = rows.length ? rows[0].password : DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, storedHash);
    if (!rows.length || !passwordMatches) {
      return fail(res, 'Invalid email or password.', 401);
    }
    const user = { id: rows[0].id, name: rows[0].name, role: rows[0].role };
    return ok(res, { token: jwt.sign({ id: user.id }, RESOLVED_JWT_SECRET, { expiresIn: '1d' }) });
  } catch (error) {
    console.error('[login]', error.code || error.message);
    return fail(res, 'Login could not be completed. Please try again.', 500);
  }
});

/* ─── Auth — Profile ──────────────────────────────────────── */
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return fail(res, 'Your account no longer exists.', 401);
    return ok(res, rows[0]);
  } catch {
    return fail(res, 'Unable to load your profile.', 500);
  }
});

/* ─── Menu — Public List ──────────────────────────────────── */
app.get('/api/menu', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, description, price, available_quantity, availability_status, category, image, preparation_time FROM menu_items ORDER BY id'
    );
    return ok(res, rows.map(item => ({ ...item, is_orderable: activeItem(item) })));
  } catch {
    return fail(res, 'Unable to load the menu.', 500);
  }
});

/* ─── Menu — Add ──────────────────────────────────────────── */
app.post('/api/menu', authenticate, isAdmin, async (req, res) => {
  const errors = validateMenuInput(req.body || {});
  if (errors.length) return fail(res, errors[0]);
  const {
    name, description = '', price, available_quantity,
    availability_status = true, category = 'Snacks', image = '', preparation_time = 3
  } = req.body;
  try {
    const [result] = await pool.query(
      'INSERT INTO menu_items (name, description, price, available_quantity, availability_status, category, image, preparation_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name.trim(), description.trim(), Number(price), Number(available_quantity),
       Boolean(availability_status) && Number(available_quantity) > 0, category, image.trim(), Number(preparation_time)]
    );
    await pool.query('INSERT INTO inventory (menu_item_id) VALUES (?)', [result.insertId]);
    broadcastSSE({ type: 'MENU_UPDATE', menuItemId: result.insertId });
    return ok(res, { id: result.insertId }, 201);
  } catch {
    return fail(res, 'Unable to create the menu item.', 500);
  }
});

/* ─── Menu — Update ───────────────────────────────────────── */
app.put('/api/menu/:id', authenticate, isAdmin, async (req, res) => {
  const id = asId(req.params.id);
  if (!id) return fail(res, 'Invalid menu item ID.');
  const body = req.body || {};
  const errors = validateMenuInput(body, true);
  if (errors.length) return fail(res, errors[0]);
  const fields = []; const values = [];
  ['name', 'description', 'price', 'available_quantity', 'availability_status', 'category', 'image', 'preparation_time']
    .forEach(key => {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        fields.push(`${key}=?`);
        values.push(['name', 'description', 'image'].includes(key) ? body[key].trim() : body[key]);
      }
    });
  // Preserve the zero-stock auto-disable invariant on ANY quantity edit
  // (previously only enforced on the checkout path).
  if (Object.prototype.hasOwnProperty.call(body, 'available_quantity') &&
      !Object.prototype.hasOwnProperty.call(body, 'availability_status')) {
    fields.push('availability_status=IF(? = 0, FALSE, availability_status)');
    values.push(Number(body.available_quantity));
  }
  if (!fields.length) return fail(res, 'Provide at least one field to update.');
  try {
    const [result] = await pool.query(
      `UPDATE menu_items SET ${fields.join(', ')} WHERE id=?`,
      [...values, id]
    );
    if (!result.affectedRows) return fail(res, 'Menu item not found.', 404);
    broadcastSSE({ type: 'MENU_UPDATE', menuItemId: id });
    return ok(res, { id });
  } catch {
    return fail(res, 'Unable to update the menu item.', 500);
  }
});

/* ─── Menu — Delete ───────────────────────────────────────── */
app.delete('/api/menu/:id', authenticate, isAdmin, async (req, res) => {
  const id = asId(req.params.id);
  if (!id) return fail(res, 'Invalid menu item ID.');
  try {
    const [used] = await pool.query('SELECT COUNT(*) AS count FROM order_items WHERE menu_item_id=?', [id]);
    if (Number(used[0].count)) {
      return fail(res, 'This item has order history and cannot be deleted. Disable it instead.', 409);
    }
    const [result] = await pool.query('DELETE FROM menu_items WHERE id=?', [id]);
    if (!result.affectedRows) return fail(res, 'Menu item not found.', 404);
    await pool.query('DELETE FROM inventory WHERE menu_item_id=?', [id]);
    broadcastSSE({ type: 'MENU_UPDATE', menuItemId: id });
    return ok(res, { id });
  } catch {
    return fail(res, 'Unable to delete the menu item.', 500);
  }
});

/* ─── SSE Stream (metadata only — no protected payloads) ──── */
app.get('/api/orders/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 3000\n');
  res.write('data: {"type":"CONNECTED"}\n\n');
  sseClients.add(res);
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

/* ─── Wallet — Summary (student) ──────────────────────────── */
async function loadWalletSummary(userId) {
  const period = currentPeriod();
  const [[wallet]] = await pool.query('SELECT id, balance, monthly_allowance FROM wallets WHERE user_id=?', [userId]);
  if (!wallet) return null;
  const [[month]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='CREDIT' AND reference_type='MONTHLY_CREDIT' AND period=? THEN amount END), 0) AS monthly_credit,
       COALESCE(SUM(CASE WHEN type='DEBIT' AND period=? THEN amount END), 0) AS spent_this_month
     FROM wallet_transactions WHERE wallet_id=?`,
    [period, period, wallet.id]
  );
  const [recent] = await pool.query(
    'SELECT id, type, amount, reference_type, description, period, created_at FROM wallet_transactions WHERE wallet_id=? ORDER BY id DESC LIMIT 8',
    [wallet.id]
  );
  const now = new Date();
  const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    balance: Number(wallet.balance),
    monthly_allowance: Number(wallet.monthly_allowance),
    monthly_credit: Number(month.monthly_credit),
    spent_this_month: Number(month.spent_this_month),
    period,
    next_reset: nextReset,
    recent_transactions: recent.map(t => ({
      id: t.id, type: t.type, amount: Number(t.amount),
      reference_type: t.reference_type, description: t.description,
      period: t.period, created_at: t.created_at
    }))
  };
}

app.get('/api/wallet', authenticate, async (req, res) => {
  try {
    // Ensure this month's credit exists even if the scheduler has not run yet.
    // Lock-first ordering: advisory lock BEFORE the transaction (same pattern
    // as the monthly sweep) so concurrent wallet loads serialize safely.
    const connection = await pool.getConnection();
    let lockAcquired = false;
    try {
      const [locks] = await connection.query('SELECT GET_LOCK(?, 3) AS acquired', [`wallet:user:${req.user.id}`]);
      lockAcquired = Number(locks[0].acquired) === 1;
      if (lockAcquired) {
        await connection.beginTransaction();
        try {
          await ensureWalletAndMonthlyCredit(connection, req.user.id, currentPeriod());
          await connection.commit();
        } catch (error) {
          try { await connection.rollback(); } catch { /* ignore */ }
          throw error;
        }
      }
    } finally {
      // RELEASE_LOCK must run on the same connection while it is still held.
      if (lockAcquired) {
        try { await connection.query('SELECT RELEASE_LOCK(?)', [`wallet:user:${req.user.id}`]); } catch { /* ignore */ }
      }
      connection.release();
    }
    // Summary read happens AFTER releasing the connection. It must NEVER run
    // while holding a pool connection: loadWalletSummary uses pool.query,
    // and holding one connection while waiting for another deadlocks the
    // pool once concurrency reaches connectionLimit.
    const summary = await loadWalletSummary(req.user.id);
    if (!summary) return fail(res, 'Wallet is unavailable.', 404);
    return ok(res, summary);
  } catch (error) {
    console.error('[wallet]', error.code || error.message);
    return fail(res, 'Unable to load your wallet.', 500);
  }
});

/* ─── Wallet — Transaction History (paginated) ────────────── */
app.get('/api/wallet/transactions', authenticate, async (req, res) => {
  try {
    const limit = Math.min(Math.max(asQuantity(req.query.limit) || 20, 1), 100);
    const offset = Math.max(asQuantity(req.query.offset) || 0, 0);
    const typeFilter = ['CREDIT', 'DEBIT'].includes(req.query.type) ? req.query.type : null;
    const [[wallet]] = await pool.query('SELECT id FROM wallets WHERE user_id=?', [req.user.id]);
    if (!wallet) return ok(res, { transactions: [], total: 0 });
    const where = 'WHERE wallet_id=?' + (typeFilter ? ' AND type=?' : '');
    const params = typeFilter ? [wallet.id, typeFilter] : [wallet.id];
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM wallet_transactions ${where}`, params);
    const [rows] = await pool.query(
      `SELECT id, type, amount, balance_after, reference_type, description, period, created_at
       FROM wallet_transactions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return ok(res, {
      total: Number(total),
      transactions: rows.map(t => ({
        id: t.id, type: t.type, amount: Number(t.amount), balance_after: Number(t.balance_after),
        reference_type: t.reference_type, description: t.description, period: t.period, created_at: t.created_at
      }))
    });
  } catch (error) {
    console.error('[wallet:history]', error.code || error.message);
    return fail(res, 'Unable to load your transaction history.', 500);
  }
});

/* ─── Wallet — Spending Insights (deterministic analytics) ── */
app.get('/api/wallet/insights', authenticate, async (req, res) => {
  try {
    const period = currentPeriod();
    const [[wallet]] = await pool.query('SELECT id, balance, monthly_allowance FROM wallets WHERE user_id=?', [req.user.id]);
    if (!wallet) return fail(res, 'Wallet is unavailable.', 404);

    const [spendByCategory] = await pool.query(
      `SELECT m.category, COALESCE(SUM(oi.quantity * oi.price), 0) AS spent, COALESCE(SUM(oi.quantity), 0) AS items
       FROM wallet_transactions wt
       JOIN orders o ON o.id = wt.reference_id AND wt.reference_type='ORDER'
       JOIN order_items oi ON oi.order_id = o.id
       JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE wt.wallet_id = ? AND wt.type='DEBIT' AND wt.period = ?
       GROUP BY m.category`,
      [wallet.id, period]
    );
    const [topItems] = await pool.query(
      `SELECT m.name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.price) AS spent
       FROM wallet_transactions wt
       JOIN orders o ON o.id = wt.reference_id AND wt.reference_type='ORDER'
       JOIN order_items oi ON oi.order_id = o.id
       JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE wt.wallet_id = ? AND wt.type='DEBIT' AND wt.period = ?
       GROUP BY m.id, m.name ORDER BY quantity DESC LIMIT 5`,
      [wallet.id, period]
    );
    const [monthlyTrend] = await pool.query(
      `SELECT period, SUM(amount) AS spent, COUNT(*) AS order_count
       FROM wallet_transactions
       WHERE wallet_id=? AND type='DEBIT' AND reference_type='ORDER'
       GROUP BY period ORDER BY period DESC LIMIT 6`,
      [wallet.id]
    );

    const spentThisMonth = spendByCategory.reduce((sum, row) => sum + Number(row.spent), 0);
    const balance = Number(wallet.balance);
    const allowance = Number(wallet.monthly_allowance);
    // Burn rate: average daily spend over the days elapsed this month (deterministic, explainable).
    const dayOfMonth = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const dailyBurn = spentThisMonth / dayOfMonth;
    const projectedMonthEnd = dailyBurn * daysInMonth;
    const daysUntilRunout = dailyBurn > 0 ? Math.floor(balance / dailyBurn) : null;

    let budgetWarning = null;
    if (spentThisMonth > 0 && balance > 0) {
      if (projectedMonthEnd > allowance) {
        budgetWarning = `At your current spending rate (₹${money(toPaise(dailyBurn))}/day), your wallet may run out around day ${Math.min(daysUntilRunout ?? daysInMonth, daysInMonth)} of ${daysInMonth}. Consider pacing your orders.`;
      } else if (balance < allowance * 0.15) {
        budgetWarning = `Only ₹${money(toPaise(balance))} left this month — less than 15% of your allowance.`;
      }
    }

    return ok(res, {
      period,
      monthly_allowance: allowance,
      balance,
      spent_this_month: spentThisMonth,
      remaining: balance,
      by_category: spendByCategory.map(r => ({ category: r.category, spent: Number(r.spent), items: Number(r.items) })),
      top_items: topItems.map(r => ({ name: r.name, quantity: Number(r.quantity), spent: Number(r.spent) })),
      monthly_trend: monthlyTrend.map(r => ({ period: r.period, spent: Number(r.spent), orders: Number(r.order_count) })).reverse(),
      daily_burn_rate: Number(dailyBurn.toFixed(2)),
      projected_month_end_spend: Number(Math.min(projectedMonthEnd, allowance * 3).toFixed(2)),
      days_until_runout: daysUntilRunout,
      budget_warning: budgetWarning
    });
  } catch (error) {
    console.error('[wallet:insights]', error.code || error.message);
    return fail(res, 'Unable to load your spending insights.', 500);
  }
});

/* ─── Orders — Preview Cart ───────────────────────────────── */
app.post('/api/orders/preview', authenticate, async (req, res) => {
  const cart = normaliseCart(req.body?.cart);
  if (!cart) return fail(res, 'Your cart is invalid or empty.');
  try {
    const ids = cart.map(l => l.id);
    const [rows] = await pool.query(
      `SELECT id, name, price, available_quantity, availability_status, preparation_time FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const byId = new Map(rows.map(item => [item.id, item]));
    let total = 0;
    const items = [];
    for (const line of cart) {
      const item = byId.get(line.id);
      if (!item) return fail(res, 'A menu item is no longer available.', 409);
      if (!activeItem(item)) return fail(res, `${item.name} is currently unavailable.`, 409);
      if (Number(item.available_quantity) < line.quantity) {
        return fail(res, `Sorry, only ${item.available_quantity} ${item.name} ${Number(item.available_quantity) === 1 ? 'is' : 'are'} available.`, 409);
      }
      const lineTotal = Number(item.price) * line.quantity;
      total += lineTotal;
      items.push({ id: item.id, name: item.name, quantity: line.quantity, price: Number(item.price), line_total: lineTotal, available_quantity: item.available_quantity });
    }
    const [queueRows] = await pool.query("SELECT COUNT(*) AS ahead FROM orders WHERE status='Preparing'");
    const ordersAhead = Number(queueRows[0].ahead);
    return ok(res, { items, total_amount: total, estimated_pickup: estimatePickup(ordersAhead, items) });
  } catch {
    return fail(res, 'Unable to validate the current stock.', 500);
  }
});

/* ─── Orders — Checkout (wallet-debit, atomic) ────────────── */
app.post('/api/orders/checkout', authenticate, async (req, res) => {
  const cart = normaliseCart(req.body?.cart);
  if (!cart) return fail(res, 'Your cart is invalid or empty.');
  const connection = await pool.getConnection();
  let advisoryLockHeld = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Per-user checkout mutex: rejects a concurrent duplicate checkout from
        // the same account immediately instead of double-charging on stale state.
        const [locks] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [`checkout:user:${req.user.id}`]);
        if (Number(locks[0].acquired) !== 1) {
          return fail(res, 'A checkout is already being processed for your account. Please wait a moment.', 429);
        }
        advisoryLockHeld = true;

        await connection.beginTransaction();
        const lockedItems = [];
        let totalPaise = 0;
        // Lock items in deterministic order to prevent deadlocks
        for (const line of cart) {
          const [rows] = await connection.query(
            'SELECT id, name, price, available_quantity, availability_status, preparation_time FROM menu_items WHERE id=? FOR UPDATE',
            [line.id]
          );
          if (!rows.length) throw Object.assign(new Error('A menu item is no longer available.'), { clientError: true });
          const item = rows[0];
          if (!activeItem(item)) throw Object.assign(new Error(`${item.name} is currently unavailable.`), { clientError: true });
          if (Number(item.available_quantity) < line.quantity) {
            throw Object.assign(
              new Error(`Sorry, only ${item.available_quantity} ${item.name} ${Number(item.available_quantity) === 1 ? 'is' : 'are'} available.`),
              { clientError: true }
            );
          }
          totalPaise += toPaise(item.price) * line.quantity;
          lockedItems.push({ ...item, quantity: line.quantity });
        }
        const totalAmount = fromPaise(totalPaise);

        // Lock the wallet row FOR UPDATE: serializes concurrent checkouts and
        // guarantees the balance check + debit are atomic.
        await connection.query('INSERT IGNORE INTO wallets (user_id, balance) VALUES (?, 0)', [req.user.id]);
        const [walletRows] = await connection.query(
          'SELECT id, balance FROM wallets WHERE user_id=? FOR UPDATE',
          [req.user.id]
        );
        const wallet = walletRows[0];
        const balancePaise = toPaise(wallet.balance);
        if (balancePaise < totalPaise) {
          throw Object.assign(
            new Error(`Insufficient wallet balance. Available: ₹${money(balancePaise)}. Required: ₹${money(totalPaise)}.`),
            { clientError: true, insufficientFunds: true }
          );
        }

        // Estimate is computed with locks already held (fresh queue depth).
        const [queueRows] = await connection.query("SELECT COUNT(*) AS ahead FROM orders WHERE status='Preparing'");
        const ordersAhead = Number(queueRows[0].ahead);
        const pickup = estimatePickup(ordersAhead, lockedItems);
        const token = makeToken();
        // Create order
        const [orderResult] = await connection.query(
          "INSERT INTO orders (user_id, token, total_amount, estimated_pickup, status) VALUES (?, ?, ?, ?, 'Preparing')",
          [req.user.id, token, totalAmount, pickup]
        );
        const orderId = orderResult.insertId;
        // Deduct inventory and record items
        for (const item of lockedItems) {
          await connection.query(
            'UPDATE menu_items SET available_quantity=available_quantity-?, availability_status=IF(available_quantity-? <= 0, FALSE, availability_status) WHERE id=?',
            [item.quantity, item.quantity, item.id]
          );
          await connection.query(
            'INSERT INTO inventory (menu_item_id, quantity_sold) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity_sold=quantity_sold+VALUES(quantity_sold)',
            [item.id, item.quantity]
          );
          await connection.query(
            'INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES (?, ?, ?, ?)',
            [orderId, item.id, item.quantity, item.price]
          );
        }
        // Payment record — wallet payment, success only.
        await connection.query(
          "INSERT INTO payments (order_id, payment_method, amount, status) VALUES (?, 'STUDENT_WALLET', ?, 'SUCCESS')",
          [orderId, totalAmount]
        );
        // Wallet ledger + balance inside the SAME transaction.
        const newBalancePaise = balancePaise - totalPaise;
        await connection.query(
          `INSERT INTO wallet_transactions
             (wallet_id, type, amount, balance_after, reference_type, reference_id, period, description)
           VALUES (?, 'DEBIT', ?, ?, 'ORDER', ?, ?, ?)`,
          [
            wallet.id, money(totalPaise), money(newBalancePaise),
            orderId, currentPeriod(), `Order ${token} — canteen purchase`
          ]
        );
        await connection.query(
          'UPDATE wallets SET balance = balance - ? WHERE id = ?',
          [money(totalPaise), wallet.id]
        );
        await connection.commit();
        broadcastSSE({ type: 'ORDER_UPDATE', orderId });
        broadcastSSE({ type: 'WALLET_UPDATE', userId: req.user.id });
        return ok(res, {
          token, orderId, estimated_pickup: pickup, orders_ahead: ordersAhead,
          total_amount: totalAmount, wallet_balance: money(newBalancePaise), payment_method: 'STUDENT_WALLET'
        }, 201);
      } catch (error) {
        try { await connection.rollback(); } catch { /* ignore rollback errors */ }
        // Retry on duplicate token collision only
        if (error.code === 'ER_DUP_ENTRY' && attempt < 2) continue;
        return fail(
          res,
          error.clientError ? error.message : 'Checkout could not be completed. Please try again.',
          error.clientError ? (error.insufficientFunds ? 402 : 409) : 500
        );
      } finally {
        // Release the advisory lock + clear any lingering transaction state per attempt.
        if (advisoryLockHeld) {
          try { await connection.query('SELECT RELEASE_LOCK(?)', [`checkout:user:${req.user.id}`]); } catch { /* ignore */ }
          advisoryLockHeld = false;
        }
      }
    }
    return fail(res, 'A unique order token could not be generated. Please try again.', 409);
  } finally {
    connection.release();
  }
});

/* ─── Orders — My Orders (single-query queue positions) ───── */
app.get('/api/orders/my-orders', authenticate, async (req, res) => {
  try {
    // One query total: queue position via correlated subquery on the
    // idx_orders_queue index (replaces the previous N+1 loop).
    const [rows] = await pool.query(
      `SELECT
         o.id, o.token, o.total_amount, o.status, o.estimated_pickup, o.created_at,
         COALESCE(SUM(oi.quantity), 0) AS total_quantity,
         GROUP_CONCAT(CONCAT(m.name, ' x ', oi.quantity) ORDER BY oi.id SEPARATOR ', ') AS item_summary,
         CASE WHEN o.status = 'Preparing' THEN
           (SELECT COUNT(*) FROM orders p
            WHERE p.status='Preparing'
              AND (p.created_at < o.created_at OR (p.created_at = o.created_at AND p.id < o.id)))
         END AS orders_ahead,
         CASE WHEN o.status = 'Preparing' THEN
           (SELECT COUNT(*) FROM orders p
            WHERE p.status='Preparing'
              AND (p.created_at < o.created_at OR (p.created_at = o.created_at AND p.id < o.id))) + 1
         END AS queue_position
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE o.user_id = ?
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    return ok(res, {
      current: rows.filter(o => o.status !== 'Collected'),
      history: rows.filter(o => o.status === 'Collected')
    });
  } catch {
    return fail(res, 'Unable to load your orders.', 500);
  }
});

/* ─── Orders — Token Detail ───────────────────────────────── */
app.get('/api/orders/:token', authenticate, async (req, res) => {
  if (!/^C-[A-F0-9]{8}$/.test(req.params.token)) return fail(res, 'Invalid order token format.');
  try {
    const [rows] = await pool.query(
      'SELECT id, token, total_amount, status, estimated_pickup, created_at FROM orders WHERE token=? AND user_id=?',
      [req.params.token, req.user.id]
    );
    if (!rows.length) return fail(res, 'Order not found.', 404);
    const order = rows[0];
    // Queue position: count orders with 'Preparing' status created before this one
    const [queue] = await pool.query(
      "SELECT COUNT(*) AS ahead FROM orders WHERE status='Preparing' AND (created_at < ? OR (created_at = ? AND id < ?))",
      [order.created_at, order.created_at, order.id]
    );
    const [items] = await pool.query(
      'SELECT m.name, oi.quantity, oi.price FROM order_items oi JOIN menu_items m ON m.id=oi.menu_item_id WHERE oi.order_id=? ORDER BY oi.id',
      [order.id]
    );
    const queueAhead = order.status === 'Preparing' ? Number(queue[0].ahead) : 0;
    return ok(res, {
      ...order,
      items,
      orders_ahead: queueAhead,
      queue_position: order.status === 'Preparing' ? queueAhead + 1 : 0
    });
  } catch {
    return fail(res, 'Unable to load the order.', 500);
  }
});

/* ─── Orders — Admin Queue ────────────────────────────────── */
app.get('/api/orders', authenticate, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         o.id, o.token, o.total_amount, o.status, o.estimated_pickup, o.created_at,
         u.name AS student_name,
         COALESCE(SUM(oi.quantity), 0) AS total_items,
         GROUP_CONCAT(CONCAT(m.name, ' × ', oi.quantity) ORDER BY oi.id SEPARATOR ', ') AS item_summary
       FROM orders o
       JOIN users u ON u.id = o.user_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN menu_items m ON m.id = oi.menu_item_id
       WHERE o.status <> 'Collected'
       GROUP BY o.id
       ORDER BY CASE o.status WHEN 'Preparing' THEN 0 ELSE 1 END, o.created_at ASC`
    );
    return ok(res, rows);
  } catch {
    return fail(res, 'Unable to load the order queue.', 500);
  }
});

/* ─── Orders — Update Status ──────────────────────────────── */
app.put('/api/orders/:id/status', authenticate, isAdmin, async (req, res) => {
  const id = asId(req.params.id);
  const status = req.body?.status;
  if (!id || !['Ready', 'Collected'].includes(status)) return fail(res, 'Invalid order ID or status value.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query('SELECT status FROM orders WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) {
      await connection.rollback();
      return fail(res, 'Order not found.', 404);
    }
    const current = rows[0].status;
    const allowed = (current === 'Preparing' && status === 'Ready') || (current === 'Ready' && status === 'Collected');
    if (!allowed) {
      await connection.rollback();
      return fail(res, `Cannot change status from ${current} to ${status}.`, 409);
    }
    await connection.query('UPDATE orders SET status=? WHERE id=?', [status, id]);
    await connection.commit();
    broadcastSSE({ type: 'STATUS_UPDATE', orderId: id, status });
    return ok(res, { id, status });
  } catch {
    try { await connection.rollback(); } catch { /* ignore */ }
    return fail(res, 'Unable to update the order status.', 500);
  } finally {
    connection.release();
  }
});

/* ─── Dashboard (admin) ───────────────────────────────────── */
app.get('/api/dashboard', authenticate, isAdmin, async (req, res) => {
  try {
    const [[totals], [items], [statusCounts], [lowStock], [walletStats], popular, forecast, itemWise] = await Promise.all([
      pool.query(
        "SELECT COUNT(*) AS total_orders, COALESCE(SUM(CASE WHEN p.status='SUCCESS' THEN o.total_amount ELSE 0 END), 0) AS total_revenue FROM orders o LEFT JOIN payments p ON p.order_id=o.id"
      ),
      pool.query('SELECT COALESCE(SUM(quantity_sold), 0) AS items_sold FROM inventory'),
      pool.query("SELECT SUM(status='Preparing') AS active_orders, SUM(status='Ready') AS ready_orders FROM orders"),
      pool.query('SELECT COUNT(*) AS low_stock_items FROM menu_items WHERE available_quantity BETWEEN 1 AND 20'),
      pool.query(
        `SELECT
           (SELECT COUNT(*) FROM wallets) AS active_wallet_users,
           (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE type='CREDIT' AND reference_type='MONTHLY_CREDIT') AS total_credits,
           (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE type='DEBIT' AND reference_type='ORDER') AS total_wallet_spending,
           (SELECT COALESCE(SUM(balance), 0) FROM wallets) AS outstanding_balance,
           (SELECT COALESCE(SUM(amount), 0) FROM wallet_transactions WHERE type='DEBIT' AND period=? AND reference_type='ORDER') AS spending_this_month,
           (SELECT COUNT(*) FROM wallet_transactions WHERE type='DEBIT' AND reference_type='ORDER') AS wallet_transaction_count`,
        [currentPeriod()]
      ),
      pool.query(
        'SELECT m.name, COALESCE(i.quantity_sold,0) AS quantity_sold FROM menu_items m LEFT JOIN inventory i ON i.menu_item_id=m.id ORDER BY quantity_sold DESC, m.name LIMIT 5'
      ),
      pool.query(
        `SELECT
           m.name,
           COALESCE(SUM(CASE WHEN o.created_at >= NOW() - INTERVAL 7 DAY THEN oi.quantity ELSE 0 END),0) AS historical_demand,
           ROUND(COALESCE(SUM(CASE WHEN o.created_at >= NOW() - INTERVAL 7 DAY THEN oi.quantity ELSE 0 END),0) / 7, 1) AS average_daily_demand,
           CEIL(COALESCE(SUM(CASE WHEN o.created_at >= NOW() - INTERVAL 7 DAY THEN oi.quantity ELSE 0 END),0) / 7) AS forecast_quantity,
           CEIL((COALESCE(SUM(CASE WHEN o.created_at >= NOW() - INTERVAL 7 DAY THEN oi.quantity ELSE 0 END),0) / 7) * 1.2) AS suggested_preparation
         FROM menu_items m
         LEFT JOIN order_items oi ON oi.menu_item_id = m.id
         LEFT JOIN orders o ON o.id = oi.order_id
         GROUP BY m.id, m.name
         ORDER BY m.id`
      ),
      pool.query(
        'SELECT m.name, COALESCE(SUM(oi.quantity),0) AS quantity_sold, COALESCE(SUM(oi.quantity * oi.price),0) AS revenue FROM menu_items m LEFT JOIN order_items oi ON oi.menu_item_id=m.id GROUP BY m.id, m.name ORDER BY quantity_sold DESC, m.name'
      )
    ]);
    const wallet = walletStats[0];
    const monthlyAllowanceTotal = Number(wallet.active_wallet_users) * MONTHLY_ALLOWANCE;
    const spentThisMonth = Number(wallet.spending_this_month);
    return ok(res, {
      stats: {
        ...totals,
        items_sold: items[0].items_sold,
        active_orders: statusCounts[0].active_orders || 0,
        ready_orders: statusCounts[0].ready_orders || 0,
        low_stock_items: lowStock[0].low_stock_items
      },
      wallet: {
        active_wallet_users: Number(wallet.active_wallet_users),
        total_credits: Number(wallet.total_credits),
        total_spending: Number(wallet.total_wallet_spending),
        outstanding_balance: Number(wallet.outstanding_balance),
        spending_this_month: spentThisMonth,
        monthly_utilization_pct: monthlyAllowanceTotal > 0
          ? Math.min(100, Math.round((spentThisMonth / monthlyAllowanceTotal) * 100))
          : 0,
        average_student_spend: Number(wallet.active_wallet_users) > 0
          ? Number((spentThisMonth / Number(wallet.active_wallet_users)).toFixed(2))
          : 0,
        unused_monthly_balance: Math.max(0, monthlyAllowanceTotal - spentThisMonth),
        transaction_count: Number(wallet.wallet_transaction_count)
      },
      popular: popular[0],
      itemWise: itemWise[0],
      forecast: forecast[0]
    });
  } catch (error) {
    console.error('[dashboard]', error.code || error.message);
    return fail(res, 'Unable to load dashboard data.', 500);
  }
});

/* ─── Inventory ───────────────────────────────────────────── */
app.get('/api/inventory', authenticate, isAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT
         m.id, m.name, m.available_quantity, m.availability_status,
         (m.availability_status AND m.available_quantity > 0) AS is_orderable,
         COALESCE(i.quantity_sold, 0) AS quantity_sold,
         CASE
           WHEN m.available_quantity = 0 THEN 'Out of Stock'
           WHEN m.available_quantity <= 20 THEN 'Low Stock'
           ELSE 'Normal'
         END AS stock_status
       FROM menu_items m
       LEFT JOIN inventory i ON i.menu_item_id = m.id
       ORDER BY m.id`
    );
    return ok(res, rows);
  } catch {
    return fail(res, 'Unable to load inventory.', 500);
  }
});

/* ─── 404 + Error Handler ─────────────────────────────────── */
app.use((req, res) => fail(res, 'Endpoint not found.', 404));

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return fail(res, 'Invalid JSON in request body.');
  }
  console.error('[ERROR]', error);
  return fail(res, 'An unexpected server error occurred.', 500);
});

/* ─── Start Server ────────────────────────────────────────── */
const port = Number(process.env.SERVER_PORT || 5000);
async function start() {
  try {
    await pool.query('SELECT 1');
    await rotateLegacySeedPasswords();
    await runWalletIntegrityCheck();
    app.listen(port, () => console.log(`[canteen-server] Running on port ${port} (${NODE_ENV})`));
  } catch (error) {
    console.error('[FATAL] Could not reach the database:', error.message);
    process.exit(1);
  }
}
start();
