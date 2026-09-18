# 🍔 Campus Canteen — Pre-Order & Token Management System

A full-stack enterprise-grade web application for campus canteen operations featuring token-based order management, atomic wallet transactions, real-time Server-Sent Events (SSE) updates, spending analytics, and inventory control.

---

## 🚀 Key Features

### 👨‍🎓 Student Portal
- **Internal Campus Wallet**: Automatic **₹500/month** allowance credit backed by an immutable ledger.
- **Atomic Checkout**: Single-transaction cart checkout with automatic price validation, stock decrement, and wallet debit.
- **Token Generation**: Unique token system (e.g., `C-8B3F9267`) for seamless queue pickup.
- **Spending Intelligence**: Real-time spending breakdown by category, top ordered items, burn-rate analytics, and budget-runout warnings.
- **Live Queue Tracking**: Real-time order status updates (`Preparing` ➔ `Ready` ➔ `Collected`) via Server-Sent Events (SSE).

### 👨‍🍳 Admin Command Centre
- **Live Order Queue**: Dynamic queue dashboard with single-click status transitions.
- **Menu Management**: Full CRUD operations for menu items (Add, Edit price/quantity/prep time, Enable/Disable, Delete).
- **Inventory Tracking**: Stock level tracking with automated low-stock warnings and wastage monitoring.
- **Campus Wallet Operations**: View student balances and issue audited wallet top-ups (₹10–₹500) with custom reason tracking.
- **Sales Analytics & Forecasting**: Item-wise revenue breakdowns and 7-day demand forecasting.

---

## 🔑 Default Credentials

> **Note**: Seeded default accounts are pre-configured for instant testing and demonstration.

| Account Type | Email | Default Password | Access Level |
|---|---|---|---|
| **Admin** | `admin@canteen.com` | `admin123` | Full Canteen Command Centre Access |
| **Student** | `student@canteen.com` | `student123` | Student Wallet & Food Pre-Ordering |

*New student accounts created via the Register form receive an automatic ₹500 monthly campus wallet credit.*

---

## 🛠️ Tech Stack & Architecture

- **Frontend**: React.js (SPA), Vanilla CSS with CSS Variables & Glassmorphism design system, EventSource API for SSE.
- **Backend**: Node.js, Express.js (REST API + SSE Stream), JWT Authentication, bcrypt (12 rounds) password hashing.
- **Database**: MySQL 8+ with ACID transactions (`FOR UPDATE` locking, correlated subqueries, composite indexes).

---

## 📂 Project Structure

```text
canteen-system/
├── client/                     # React Frontend
│   ├── public/                 # Static assets & index.html
│   └── src/
│       ├── api.js              # Centralized API fetch wrapper
│       ├── App.js              # Auth provider & routing
│       ├── components/         # Modal, Toast, Loading & UI primitives
│       ├── pages/
│       │   ├── Admin.js        # Admin command centre
│       │   ├── Auth.js         # Register & Login forms
│       │   └── Student.js      # Student menu, cart & wallet analytics
│       └── stream.js           # SSE custom event hook
├── server/                     # Express REST API & Database Integration
│   ├── .env.example            # Environment variable template
│   ├── wallet.js               # Ledger balance & credit operations
│   ├── wallet-audit.js         # Offline balance vs. ledger integrity check
│   ├── server.js               # Main server entry point & endpoints
│   └── tests/                  # Integration test suite
└── database/
    └── setup.sql               # Database schema & initial seed data
```

---

## ⚡ Quick Start & Setup

### 1. Prerequisites
- Node.js (v16 or higher) & npm
- MySQL 8.0+

### 2. Database Setup
Import the database schema and seed data into MySQL:

```bash
mysql -u root -p < database/setup.sql
```

### 3. Backend Configuration & Launch
Navigate to the `server/` directory, create your `.env` configuration file, and start the API:

```bash
cd server
npm install

# Copy example environment file
cp .env.example .env

# Start the server
npm start
```

The Express API will run on `http://localhost:5000`.

### 4. Frontend Launch
In a new terminal, navigate to the `client/` directory and start the React dev server:

```bash
cd client
npm install
npm start
```

Open `http://localhost:3000` in your web browser.

---

## 🧪 Testing & Verification

Run the automated backend integration test suite:

```bash
cd server
npm test
```

Verify wallet balance ledger integrity:

```bash
cd server
npm run wallet:audit
# To repair any ledger drift automatically:
npm run wallet:audit -- --repair
```

---

## 📜 License

This project is licensed under the MIT License.