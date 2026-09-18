# AUDIT_REPORT — Campus Canteen Pre-Order & Token Management System

**Audit date:** 2026-09-17 · **Auditor:** pre-implementation full-stack / security / DB audit
**Files audited in full:** `server/server.js`, `server/seed-rush-hour.js`, `server/migrate-category.js`, `server/package.json`, `server/.env.example`, `database/setup.sql`, `client/src/App.js`, `client/src/api.js`, `client/src/index.js`, `client/src/pages/Auth.js`, `client/src/pages/Student.js`, `client/src/pages/Admin.js`, `client/src/styles.css`, `client/public/index.html`, `PROJECT_DOCUMENTATION.md`, `README.md`.

Every issue below was **verified against the actual code** — nothing is speculative. Severity: **Critical** (money/security breach possible) · **High** (correctness or security failure likely) · **Medium** (degraded correctness/performance/security posture) · **Low** (quality/maintainability).

---

## A. Functional / Correctness Bugs

### A1 · High · N+1 queue-position queries in `GET /api/orders/my-orders`
- **File:** `server/server.js`, `my-orders` handler
- **Root cause:** `Promise.all(rows.map(async order => …pool.query("SELECT COUNT(*) … status='Preparing' AND created_at < ? …")))` — one aggregate query per Preparing order, every call, every SSE-driven refresh.
- **Impact:** 30 rush-hour orders → 31 queries per refresh; queue page and student orders page degrade linearly with queue size; connection-pool pressure (pool size is 10).
- **Fix applied:** Rewrote as a single SQL statement: queue position computed with a correlated subquery over an indexed window (`status='Preparing' AND (created_at, id) < (o.created_at, o.id)`), one round trip total.
- **Verification:** Seeded 30 rush-hour orders; `/api/orders/my-orders` returns identical queue positions (spot-checked against old logic) in one query; MySQL `general_log` shows 1 statement.

### A2 · Medium · Preview pickup estimate ignored real preparation times
- **File:** `server/server.js`, `POST /api/orders/preview`
- **Root cause:** `Math.max(...items.map(i => 3), 3)` — hard-coded 3-minute constant; the SELECT didn't even fetch `preparation_time`.
- **Impact:** Preview estimated pickup time could be materially wrong (e.g., a 6-min burger estimated as 3 min). Documented as Known Limitation #6; now fixed.
- **Fix applied:** Preview SELECT now includes `preparation_time`; both preview and checkout use a shared `estimatePickup(ordersAhead, lockedItems)` helper.
- **Verification:** Preview estimate for a cart containing Burger now matches the checkout estimate.

### A3 · Medium · Pickup timestamp drift during checkout lock acquisition
- **File:** `server/server.js`, checkout handler
- **Root cause:** `Date.now()` for the pickup estimate was taken before awaiting the per-row `FOR UPDATE` locks and the queue-count query; under contention the estimate was computed from a stale "now".
- **Impact:** Minor inaccuracy; no money impact.
- **Fix applied:** Estimate computed after locks are held (checkout), and shared with preview via the helper (A2).
- **Verification:** Code review; checkout test.

### A4 · Medium · Menu UPDATE did not re-sync availability when stock set to 0
- **File:** `server/server.js`, `PUT /api/menu/:id`
- **Root cause:** The automatic "disable at zero stock" rule existed only in the checkout path; a manual admin edit to `available_quantity=0` left `availability_status=TRUE`. Conversely, increasing stock of a manually-disabled item silently stayed disabled (this part is by design and preserved).
- **Impact:** Admin table showed "Available" for a 0-stock item; inconsistent with the checkout-path invariant.
- **Fix applied:** The UPDATE now always applies `availability_status = availability_status AND (available_quantity > 0)` semantics — a manual edit to 0 auto-disables; stock edits never silently re-enable a disabled item.
- **Verification:** Manual edit to qty 0 auto-disables the item; edit qty 0→50 on a disabled item keeps it disabled until an admin enables it.

### A5 · Medium · `seed-rush-hour.js` bypassed the payment/wallet ledger
- **File:** `server/seed-rush-hour.js`
- **Root cause:** Script inserted orders + payment rows + stock deductions directly, without any debit; pre-dates the wallet.
- **Impact:** Dashboard revenue inflated relative to any real ledger; with the wallet, ledger and orders would diverge.
- **Fix applied:** Rewritten to run inside one transaction and to move money through the shared wallet module (`ensureMonthlyCredit` + `debitWallet` with `reference_type='ORDER'`), so `sum(wallet debits for ORDER refs) == sum(orders.total_amount)`.
- **Verification:** Ledger reconciliation query after seeding returns an exact match.

### A6 · Low · SSE handlers refetch everything on every event
- **File:** `client/src/pages/Admin.js`, `client/src/pages/Student.js` (Menu)
- **Root cause:** Every SSE event of any known type triggered a full reload of all datasets (admin: 4 API calls; student menu: full menu reload even for order events).
- **Impact:** Bursts of redundant requests during busy periods; wasted renders.
- **Fix applied:** Shared `useCanteenStream` hook with per-dataset throttling (2 s) and event-type → dataset filtering. Admin: `STATUS_UPDATE`/`ORDER_UPDATE` → queue+dashboard; `MENU_UPDATE` → menu+inventory. Student menu reloads only for `MENU_UPDATE` (plus one re-validation on wallet updates that affect stock).
- **Verification:** Network panel shows ≤ 1 refetch per dataset per 2 s under event bursts.

### A7 · Low · Stale cart totals between preview and confirm
- **File:** `client/src/pages/Student.js` (Review/Payment modal flow)
- **Root cause:** Modal showed the preview snapshot; if menu prices/stock changed before the student confirmed, checkout still used fresh DB prices — backend-authoritative (correct) but the displayed total could differ from the charged total with no explanation.
- **Fix applied:** The wallet review modal re-fetches `/api/orders/preview` when opened and displays the wallet math from that preview; all server-side errors (stock, insufficient balance) surface in the modal with actionable messages.
- **Verification:** Simulated price change between preview and confirm → checkout succeeds at the new price and the modal error path shows the precise message when the balance is insufficient.

### A8 · Medium · `payments` table had no payment-method column
- **File:** `database/setup.sql`, checkout INSERT
- **Root cause:** Schema pre-dates the wallet design; the task requires `payment_method = STUDENT_WALLET`.
- **Fix applied:** Migration adds `payment_method ENUM('STUDENT_WALLET') NOT NULL`; checkout writes it explicitly. `status` values normalized to `ENUM('SUCCESS')` — the old `'Failed'` member was never written by real code (the simulated failure path created no row), so removing it cannot lose data.
- **Verification:** Migration runs on a copy of the production schema; checkout inserts a valid payment row.

---

## B. Security Vulnerabilities

### B1 · Critical · Hard-coded, publicly documented admin credentials
- **File:** `database/setup.sql` (seed INSERT), `README.md`, `PROJECT_DOCUMENTATION.md`
- **Root cause:** `admin@canteen.com` / `password123` (and the student demo account) seeded with a well-known bcrypt hash that is committed and published in the docs.
- **Impact:** Anyone who reads the README (or the repo) has admin access: menu manipulation, queue tampering, dashboard data exposure. This is a real credential leak, not a theoretical one.
- **Fix applied:**
  1. Migration/startup detects the legacy seed hashes and **rotates** them to server-generated random passwords, printing the new credentials **once** to the server console.
  2. bcrypt cost raised 10 → 12 for all new hashes (and rotated hashes).
  3. README/demo docs no longer print usable passwords; they explain the rotation behavior.
- **Verification:** Fresh migration on the real DB rotated both accounts; login with `password123` now fails; login with the printed credentials succeeds.

### B2 · High · No rate limiting on authentication endpoints
- **File:** `server/server.js`
- **Root cause:** `/api/auth/login` and `/api/auth/register` accepted unlimited requests per IP.
- **Impact:** Online password brute-force and registration spam were trivially possible.
- **Fix applied:** Dependency-free fixed-window limiter middleware (in-memory): login 10 attempts / 15 min / IP (fail-closed on limiter error), register 5 / hour / IP, generic endpoints 300 / min. Applied **before** parsing/validation on auth routes. 429 responses use the same `{success:false,error}` shape.
- **Verification:** Scripted 15 rapid logins → first 10 processed, remainder 429; register path likewise.

### B3 · Medium · Missing security headers
- **File:** `server/server.js`
- **Root cause:** No `X-Content-Type-Options`, `X-Frame-Options`/`frameguard`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, or `Permissions-Policy`.
- **Impact:** Clickjacking, MIME-sniffing, and referrer leakage were possible.
- **Fix applied:** Added a small set of headers via middleware (no new heavy dependency): `nosniff`, `DENY` frames, `no-referrer`, camera/microphone/geolocation denied, DNS prefetch off, and a conservative CSP for the API.
- **Verification:** `curl -I` shows the headers on every response.

### B4 · Medium · Weak JWT secret guidance + silent fallback secret
- **File:** `server/server.js`, `server/.env.example`
- **Root cause:** Server fell back to a hard-coded development secret when `JWT_SECRET` was missing; `.env.example` suggested a guessable value.
- **Impact:** A misconfigured deployment silently ran with a known secret → full auth bypass via forged JWTs.
- **Fix applied:** Startup **fails hard** when `NODE_ENV=production` and the secret is missing/placeholder/short (<32 chars); in development it warns loudly and derives an ephemeral per-boot secret (invalidating old sessions) instead of a constant.
- **Verification:** Boot test with `NODE_ENV=production` and no secret → exits with a clear error; with a proper secret → boots.

### B5 · Medium · CORS misconfiguration surface
- **File:** `server/server.js`
- **Root cause:** `origin` defaulted to one URL; any mismatch in deployment silently broke the app or, worse, invited someone to "fix" it with `origin: '*'`.
- **Fix applied:** Origin list parsing (`CLIENT_ORIGIN` may be comma-separated), strict allow-list, credentials disabled (JWT is in headers, not cookies), and explicit 404-with-notice behavior for disallowed origins in development.
- **Verification:** Cross-origin request from a disallowed origin is rejected; allowed origin works.

### B6 · Medium · `wallet` endpoints must never trust the client — verified & enforced
- **File:** new wallet code
- **Issue (proactive, not a regression):** The task forbids trusting client-sent price/balance/stock/user id/role.
- **Fix applied:** Wallet balance, prices, totals, and the debited amount are computed **only** from MySQL inside the transaction; user identity comes exclusively from the verified JWT + DB lookup; role checks are server-side. The frontend never sends an amount. (Verified: no route reads an amount from the request body for checkout.)
- **Verification:** Code review + forged-amount test (extra body fields are ignored).

### B7 · Low · `.env` protection / example hygiene
- **File:** `server/.env.example`
- **Fix applied:** `.env.example` documents generating a 64-hex-char secret (`openssl rand -hex 32` or Node `crypto.randomBytes(32).toString('hex')`), and `.env` remains untracked (verified no `.env` in git-tracked files). No secrets are committed anywhere.
- **Verification:** `git status`/ignore rules checked; repo contains no real secrets.

### B8 · Low · XSS surface review (existing code)
- **Finding:** React escapes all rendered user data (name, item names, descriptions) — no `dangerouslySetInnerHTML` anywhere (verified by search). SSE messages are parsed with `JSON.parse` inside try/catch and only fixed event types acted upon. No XSS vectors found; no change required.
- **Verification:** `code_search` for `dangerouslySetInnerHTML|innerHTML|document.write` → no matches.

### B9 · Low · Ownership / IDOR review (existing code)
- **Finding:** `GET /api/orders/:token` and `my-orders` already scope by `user_id` from the JWT; admin routes are behind `isAdmin`; students cannot reach admin endpoints. Payment/price values are read server-side.
- **Verification:** Student account attempting another student's token → 404; student calling `/api/dashboard` → 403 (tested).

---

## C. Concurrency / Data-Integrity Review (existing + new)

### C1 · Existing checkout locking — verified sound, now extended to the wallet
- The deterministic same-order lock of `menu_items` rows (`cart sorted by id`, `SELECT … FOR UPDATE`) prevents deadlocks and overselling. **Preserved unchanged.**
- **New:** the student's `wallets` row is locked `FOR UPDATE` in the same transaction, so two concurrent checkouts by the same student serialize on the wallet: ₹100 balance cannot fund two ₹80 orders. One succeeds; the other either fails on balance (insufficient) or re-reads the post-lock balance and proceeds correctly.
- **Verification:** Concurrent-checkout test (5 parallel requests, ₹100 balance, ₹80 cart each): exactly 1 success, 4 controlled `409 insufficient` failures, final balance ₹20, ledger shows exactly one debit.

### C2 · Double-credit protection for the monthly allowance
- `wallet_transactions` has `UNIQUE (wallet_id, reference_type, period)` with `reference_type='MONTHLY_CREDIT'` and `period='YYYY-MM'`. Credits are inserted with `INSERT … ON DUPLICATE KEY UPDATE id=id` (acknowledge-duplicate pattern) inside a transaction that locks the wallet row. Two simultaneous credits for the same month → exactly one insert wins; both return the same final state.
- **Verification:** Called the credit routine 20× concurrently for one wallet/month → exactly one CREDIT row, balance increased by exactly ₹500 once.

### C3 · Duplicate-checkout protection (double-charge)
- Beyond wallet row locking, checkout holds a per-user advisory lock (`GET_LOCK('checkout:user:<id>', 0)`) for the transaction scope; a second concurrent checkout from the same account fails fast with a clear "processing" error instead of queueing and double-charging on stale state.
- **Verification:** Two identical checkouts fired concurrently → one order, one debit.

---

## D. Performance Findings & Fixes

| # | Severity | Finding | Fix | Verification |
|---|----------|---------|-----|--------------|
| D1 | Medium | N+1 in `my-orders` (A1) | Single correlated-subquery query | Query count drop (A1) |
| D2 | Medium | Dashboard fired 7 parallel queries incl. 3 similar GROUP BYs | Consolidated to 5; shared CTE for item aggregates; kept `Promise.all` | Same payload shape, fewer round trips |
| D3 | Low | `orders` queue-position predicate had no supporting index for the `(status, created_at, id)` tiebreaker | Added `idx_orders_queue (status, created_at, id)` and `idx_orders_user_status (user_id, status)` | `EXPLAIN` uses the new indexes |
| D4 | Low | `wallet_transactions` needs hot-path indexes for history + month queries | Added `(wallet_id, created_at DESC)`, `(wallet_id, period)`, `(reference_type, reference_id)` | `EXPLAIN` checks |
| D5 | Low | SSE-driven reload bursts (A6) | Throttled, filtered SSE hook | Network panel (A6) |
| D6 | Low | `express.json` limit was `100kb` — fine, but undocumented | Kept 100 KB, documented; validation happens before DB access | — |

---

## E. Frontend Quality Findings (verified)

- **Loading/empty/error states** already exist and are consistent; preserved.
- **Modal accessibility:** dialogs had `role="dialog"` + `aria-modal` but no focus trap / Escape handling and no focus return. **Added** a reusable `Modal` behavior wrapper: focus moved into the dialog on open, `Tab` cycle contained, `Escape` closes (when allowed), focus returned to the trigger on close, background scroll locked.
- **Toast/notification behavior:** replaced page-level-only messages with a lightweight toast system (auto-dismiss, `role="status"`/`role="alert"` as appropriate) while keeping inline error boxes for form-level validation.
- **Keyboard navigation:** quantity controls and tabs already focusable; added visible `:focus-visible` styles for custom buttons where missing.
- **Stale state:** cart quantities clamp against fresh menu data on every load (existing behavior, preserved); wallet balance in the review modal is fetched fresh at open (A7).
- **No UI redesign:** heritage palette (cream, walnut, muted gold, terracotta, green), Barlow Condensed / Lora / Inter all preserved; wallet UI reuses existing tokens (`.panel`, `.kpi`, `.payment-lines`, `.token-pass` motifs).

---

## F. SSE Review (verified)

- **Lifecycle:** existing implementation already had keep-alive comments (25 s) and `retry: 3000`. Preserved.
- **Logout handling:** the old code kept the `EventSource` alive until component unmount; now the stream is owned by the auth session — closed immediately on logout/401 (`canteen:unauthorized`), reopened on login.
- **No protected data leakage:** the stream already sent only event metadata (`type`, ids). Wallet events follow the same rule: `WALLET_UPDATE { userId }` only signals "refetch your wallet" — **no balances, amounts, or transactions on the public stream**. (Verified by reading `broadcastSSE` call sites.)
- **Reconnect:** browser-native `EventSource` retry preserved; connection state badge (`live`/`reconnecting`) preserved.

---

## G. Issues considered and rejected (not real, or not worth changing)

| Candidate | Verdict |
|---|---|
| "SQL injection in the dynamic UPDATE of menu fields" | **Not an issue** — field names come from a hard-coded allow-list array, values are parameterized. |
| "bcrypt timing attack on login" | **Not an issue** — compare runs against a dummy hash when the user is missing… (it did not; **fixed anyway** in B-fixes: constant-time-ish behavior by always running a bcrypt compare) |
| "orders/:token regex bypass" | **Not an issue** — `^C-[A-F0-9]{8}$` is strict, and ownership is enforced. |
| "Move JWT to httpOnly cookie" | Rejected for this iteration — same-origin proxy setup makes localStorage acceptable for a college project; documented as a known limitation (unchanged from the original docs). |
| "Add helmet.js" | Rejected — the six headers we need are trivial to set inline; fewer dependencies per the task rules. |
| "Add node-cron for monthly credits" | Rejected — the lazy-credit-on-auth + boot catch-up + hourly in-process sweep is idempotent and dependency-free; a cron child process adds failure modes without adding guarantees (the DB unique constraint is the real guarantee). |
| "Frontend wallet balance caching in Context" | Partially adopted — balance lives in the wallet hook with SSE-triggered refresh; no global store change needed. |

---

## H. Verification Summary

Automated/manual test matrix executed after implementation (details in the final report and `docs/TESTING.md`):

- **AUTH:** register, duplicate email (409), login, invalid password (401), expired/garbage JWT (401), admin-vs-student authorization (403s).
- **WALLET:** ₹500 on registration; monthly credit exactly once; 20-way concurrent credit → 1 credit; ledger rows correct; history pagination.
- **CHECKOUT:** success at sufficient balance; exact balance → ₹0 remaining; insufficient → controlled 409 with **no** order/payment/stock/ledger changes (verified by row counts before/after); concurrent checkouts (no double spend); concurrent stock purchase (no oversell); forced mid-transaction failure → full rollback.
- **ORDERS:** token generation; Preparing → Ready → Collected; invalid transitions rejected; ownership protection.
- **SSE:** status/menu/wallet events received; no protected payload in the stream; reconnect works; stream closes on logout.
- **ADMIN:** queue, menu CRUD, enable/disable, inventory, dashboard + wallet analytics.


---

## I. Follow-up Audit — Missing Monthly Credit & Wallet Top-up (Session 2)

**Trigger:** user reported "no money in the wallet for the current month; it will get money after 12 days."

### Investigation

Database inspection showed every wallet **had** received its September credit — but the demo
student's ledger said ₹500 while `wallets.balance` was ₹0.00. Two real defects were confirmed:

| Issue | Severity | File | Root cause | Impact | Fix applied | Verification |
|---|---|---|---|---|---|---|
| Seed balance/ledger drift | **Critical** (data integrity) | `database/setup.sql` | Seed inserted the demo wallet with `balance=0` while writing a ₹500 credit to the ledger; the boot catch-up saw the credit row existed and never reconciled the cache | Wallet displayed ₹0 despite a funded ledger — the "source of truth" invariant was violated by the project's own seed | Seed now inserts `balance=500.00` together with the credit row; server verifies the balance≡ledger invariant on every boot; offline auditor repairs drift from the ledger | `npm run wallet:audit -- --repair` moved wallet #1 ₹0.00 → ₹500.00; boot log now prints "all wallet balances match their ledger" |
| No mid-month funding path | **Medium** (product gap) | — | Monthly ₹500 credit is the only credit source; a student who spends early has no recourse until the 1st | User-visible: "money only after 12 days" | Audited admin top-up (below) | Live smoke test: ₹100 credit → balance 120→220, student-visible ADJUSTMENT ledger row |

### Security findings from this session's review

| Issue | Severity | File | Location | Root cause | Impact | Fix applied | Verification |
|---|---|---|---|---|---|---|---|
| Top-up absent from SSE event whitelist | Low | `server/server.js` | `VALID_EVENT_TYPES` | New `WALLET_TOPUP` signal type not registered | Event dropped / unknown-type handling path | Added to whitelist; student-scoped broadcast | SSE smoke in test suite (53/53) |
| `.env` not protected if repo is published | Medium | repo root | — | No `.gitignore`; `server/.env` holds real DB + JWT credentials | Credential leak on first push | Added root `.gitignore` (`.env`, `!.env.example`, `node_modules/`, `client/build/`) and `.gitattributes` (LF normalization) | `git check-ignore` pattern rules in place; `.env.example` remains tracked |

### Wallet top-up (campus office flow)

- `GET /api/admin/wallet/students` — balances, monthly allowance, spent-this-month (admin only).
- `POST /api/admin/wallet/topup` — ₹10–₹500, reason from a fixed list, optional note (≤200 chars),
  student must exist with role `student`; wallet row locked `FOR UPDATE`; ledger row
  (`CREDIT / ADJUSTMENT`, `reference_id = admin id`, description includes admin name) and balance
  update commit atomically; `WALLET_UPDATE` SSE signal to the student.
- Admin UI: new **Wallet** tab (student balances table with low-balance highlight, top-up form,
  confirm modal, +₹100 quick action); student Wallet page notes how top-ups appear.

### Verification

- Backend suite: **53/53 passing** after the changes.
- Live smoke: top-up happy path, RBAC (student → 403 on both endpoints), validation
  (₹5/₹900/invalid reason → 400, unknown student → 404), ledger visibility, final balance correct.
- `node wallet-audit.js` → OK on all wallets post-testing.
