# Campus Canteen Pre-Order and Token Management System

## 1. Project Overview

Campus Canteen is a full-stack web application for campus food pre-ordering and kitchen queue management. Students browse food, add items to a cart, and pay from an internal **campus wallet** (₹500 monthly allowance credited automatically and idempotently) — checkout, order creation, stock deduction and the wallet debit commit in one atomic MySQL transaction. Administrators manage the live queue, menu, inventory, wallet analytics, and sales/demand information.

The system is built with:

- React.js frontend
- Node.js and Express.js backend
- MySQL 8+ database
- JWT authentication
- bcrypt password hashing
- REST API communication
- Server-Sent Events (SSE) for live updates
- CSS responsive design

## 2. Main Objectives

The system is designed to:

1. Reduce waiting time at the campus canteen.
2. Allow students to pre-order food before pickup.
3. Provide secure student and administrator accounts.
4. Prevent ordering items that are unavailable or out of stock.
5. Generate unique digital tokens for orders.
6. Give students live information about order progress and queue position.
7. Help canteen staff manage orders and menu availability.
8. Track inventory usage, sales, and popular items.
9. Provide a simple demand forecast for food preparation.
10. Demonstrate transactional checkout and reliable database updates.

## 3. User Roles

### 3.1 Student

A student can:

- Register a new account.
- Log in and log out.
- Browse the menu.
- Filter items by category.
- View prices, descriptions, images or image fallbacks, and stock status.
- Add food to a local cart.
- Increase or decrease item quantities.
- Clear the cart.
- Preview an order before payment.
- Pay from the campus wallet (internal credit system, no real money).
- View wallet balance, monthly credit, spending this month and transaction history.
- See deterministic spending insights (burn rate, category split, budget warnings).
- Receive a unique digital token after successful checkout.
- View current orders.
- View collected order history.
- Track order status and queue position.
- Receive live updates through SSE.

### 3.2 Administrator

An administrator can:

- Log in using an administrator account.
- View the active kitchen queue.
- Separate preparing orders from ready orders.
- Mark orders as Ready.
- Mark ready orders as Collected.
- Add menu items.
- Edit menu items.
- Enable or disable menu items.
- Delete menu items when permitted.
- Confirm deletion through an in-app confirmation dialog.
- View current stock and quantity sold.
- View low-stock and out-of-stock statuses.
- View sales and operational KPIs.
- View item-wise sales.
- View popular food items.
- View seven-day demand forecasts.
- Receive live queue, menu, and order updates.

## 4. Application Routes

### 4.1 Frontend Routes

| Route                   | Access        | Purpose                                      |
| ----------------------- | ------------- | -------------------------------------------- |
| `/`                     | Public        | Login and registration screen                |
| `/student/`             | Student       | Redirects to the student menu                |
| `/student/menu`         | Student       | Browse menu and manage cart                  |
| `/student/orders`       | Student       | View current and collected orders            |
| `/student/token/:token` | Student       | View a digital token and live order progress |
| `/admin`                | Administrator | Admin operations dashboard                   |

Role protection is applied in the React router. Students cannot access administrator pages, and administrators cannot use student pages through the protected routes.

## 5. Authentication and Account Management

### 5.1 Registration

The registration screen collects:

- Full name
- Email address
- Password

Frontend validation requires a name, valid email input, and a password between 6 and 72 characters. The backend repeats validation so that client-side validation cannot be bypassed.

Registration behavior:

1. The email is trimmed and converted to lowercase.
2. The password is hashed with bcrypt.
3. The account is inserted into the `users` table.
4. New registrations are always assigned the `student` role.
5. Duplicate email addresses return a clear error.
6. Successful registration returns the user to the login mode.

### 5.2 Login

Login accepts an email and password. The backend:

1. Normalizes the email to lowercase.
2. Finds the user by unique email.
3. Compares the submitted password with the bcrypt hash.
4. Creates a JWT containing the user ID.
5. Sets the JWT expiry to one day.
6. Returns the token to the frontend.

The frontend stores only the JWT token in `localStorage`. It then requests `/api/auth/me` to load the current profile.

### 5.3 Session Restoration

When the application starts:

1. The frontend checks for a saved JWT.
2. If a token exists, it calls `/api/auth/me`.
3. The backend verifies the JWT and reloads the user from MySQL.
4. If the token is invalid or expired, the token is removed and the login screen is shown.
5. If the user no longer exists, access is rejected.

The backend checks the user record on every authenticated request, so deleting a user invalidates access even if a JWT still exists.

### 5.4 Authorization

The backend uses two middleware functions:

- `authenticate`: requires a valid `Authorization: Bearer <token>` header.
- `isAdmin`: requires the authenticated user role to be `admin`.

All administrator menu, order, dashboard, and inventory endpoints use both checks.

## 6. Student User Experience

### 6.1 Menu Screen

The menu page displays food items in responsive cards. Each item includes:

- Item name
- Description
- Price in Indian rupees
- Category
- Food image when available
- First-letter fallback when an image fails
- Available quantity
- Low-stock label
- Sold-out label
- Add button or quantity control

Available categories are:

- All
- Breakfast
- Snacks
- Beverages

An item is orderable only when both conditions are true:

- `availability_status` is enabled.
- `available_quantity` is greater than zero.

Stock labels are:

- More than 20 units: available
- 1 to 20 units: low stock
- 0 units or disabled: sold out/unavailable

### 6.2 Cart

The cart is maintained in frontend state while the student is using the menu page. It supports:

- Adding an item.
- Increasing quantity.
- Decreasing quantity.
- Removing an item when quantity reaches zero.
- Preventing quantity from exceeding displayed stock.
- Clearing the complete cart.
- Showing total item count.
- Showing the calculated cart amount.

The server remains authoritative. Client-side stock checks improve usability, but the server checks stock again during preview and checkout.

### 6.3 Order Preview

Before payment, the frontend sends the cart to `/api/orders/preview`.

The backend:

- Validates the cart structure.
- Combines duplicate item IDs.
- Checks that items exist and are enabled.
- Checks current stock.
- Reads current prices directly from MySQL.
- Calculates line totals and total amount.
- Calculates an estimated pickup time.
- Returns the order summary without reserving inventory.

The preview modal displays item quantities, line totals, total amount, and the estimated pickup time.

### 6.4 Wallet Payment

The simulated payment UI (Simulate Success / Simulate Failure buttons) has been removed. Payment is now an internal campus-wallet debit:

1. The review modal fetches the student's live wallet balance via `GET /api/wallet`.
2. The modal shows Order Total, Wallet Balance and either Remaining Balance or Required Additional Balance.
3. The pay button is disabled when the balance is insufficient — and the backend independently re-checks the balance and returns HTTP 402 with `Insufficient wallet balance. Available: ₹X. Required: ₹Y.` if needed.
4. A rejected checkout creates no order, no payment row, no stock change and no ledger entry.
5. On success the backend creates the order, payment record (`payment_method='STUDENT_WALLET', status='SUCCESS'`), wallet debit ledger row and stock deductions in one transaction, then the student is taken to the digital token.

### 6.5 Checkout Transaction

Checkout is implemented as a database transaction. The backend:

1. Validates and normalizes the submitted cart.
2. Sorts item IDs in deterministic order.
3. Starts a MySQL transaction.
4. Locks the selected menu rows using `SELECT ... FOR UPDATE`.
5. Rechecks availability and stock while rows are locked.
6. Reads prices from the database.
7. Calculates the final total.
8. Generates a cryptographically random token.
9. Inserts an order.
10. Inserts order item records with price snapshots.
11. Inserts a successful payment record.
12. Deducts menu stock.
13. Updates `inventory.quantity_sold`.
14. Automatically disables an item when its stock reaches zero.
15. Commits all changes atomically.
16. Broadcasts an order update through SSE.

If any step fails, the transaction is rolled back. This prevents partial orders, incorrect stock, or payments without orders.

Duplicate token collisions are retried safely up to three attempts.

### 6.6 Wallet Operations (campus office)
- **Monthly allowance:** ₹500 is credited on the 1st of each month, idempotently (DB unique constraint on the credit period). A boot-time catch-up and an hourly in-server sweep credit any student who missed a period while the server was offline.
- **Admin top-up:** when a student runs out before month-end, an admin can issue an audited top-up (`POST /api/admin/wallet/topup`, Admin → Wallet tab). Amount is limited to ₹10–₹500, a reason from a fixed list is required, and the credit is written to the student's ledger as an `ADJUSTMENT` with the admin's name — visible to the student in their transaction history. The wallet row is locked `FOR UPDATE` and the credit commits atomically with the ledger row.
- **Integrity invariant:** `wallets.balance` must always equal the signed sum of that wallet's ledger rows. The server verifies this on every boot and repairs drift by recomputing from the ledger. `npm run wallet:audit` (add `-- --repair`) performs the same check offline.

### 6.7 Digital Token Screen

After checkout, the student sees a digital token screen containing:

- Unique token number in the format `C-XXXXXXXX`.
- Order status.
- Total amount.
- Ordered item list.
- Estimated pickup time.
- Queue position.
- Number of orders ahead.
- Order progress timeline.

The token page receives live status changes through SSE.

### 6.8 My Orders

The orders page separates:

- Current orders: Preparing and Ready.
- Collected orders: completed pickup history.

Each order can show:

- Token number
- Status
- Item summary
- Total amount
- Order time
- Estimated pickup time
- Queue position

## 7. Administrator Features

### 7.1 Admin Queue

The queue page displays active orders and separates them into:

- Preparing
- Ready for Pickup

Each queue row includes:

- Token
- Order ID
- Student name
- Ordered items
- Total quantity
- Order time
- Pickup estimate
- Amount
- Current status
- Action button

Allowed status transitions are strictly controlled:

```text
Preparing -> Ready -> Collected
```

Invalid transitions are rejected by the backend.

The queue view also displays mini KPIs for:

- Active orders
- Preparing orders
- Ready orders
- Low-stock items

Collected orders leave the active queue.

### 7.2 Menu Management

Administrators can create menu items with:

- Name
- Description
- Price
- Available quantity
- Availability status
- Category
- Image filename
- Preparation time

Menu editing supports partial updates. The backend validates:

- Name maximum: 100 characters
- Positive price
- Whole-number quantity of zero or more
- Preparation time: 1 to 60 minutes
- Category: Breakfast, Snacks, or Beverages
- Description maximum: 1000 characters
- Image filename maximum: 255 characters

Menu actions:

- Add item
- Edit item
- Enable item
- Disable item
- Delete item

When quantity becomes zero, the backend automatically disables the item. Increasing quantity does not automatically re-enable an item; the administrator can enable it separately.

Deleting an item is protected by an accessible in-app confirmation dialog. Items with existing order history cannot be deleted because their historical references must remain valid.

### 7.3 Inventory Management

The inventory page shows:

- Food item
- Current stock
- Quantity sold
- Availability
- Stock status
- Visual stock bar

Stock statuses:

- `Normal`: more than 20 units
- `Low Stock`: 1 to 20 units
- `Out of Stock`: 0 units

Inventory quantity is changed through the menu item editor. There is no separate stock-adjustment endpoint.

### 7.4 Dashboard

The administrator dashboard displays the following KPIs:

- Total orders
- Total revenue
- Items sold
- Active orders
- Ready orders
- Low-stock items

Operational insight panels include:

- Most ordered item
- Current queue summary
- Low-stock count
- Queue clearance state

Sales reports include:

- Item-wise quantity sold
- Item-wise revenue
- Popular items ranked by quantity sold

### 7.5 Demand Forecasting

The forecast uses order history from the latest seven days.

Formula:

```text
Historical demand = total quantity sold during the latest seven days
Average daily demand = historical demand / 7
Suggested preparation = ceiling(average daily demand * 1.2)
```

The forecast table displays:

- Item name
- Historical demand
- Average daily demand
- Forecast quantity
- Suggested preparation quantity

The 20 percent buffer is intended to help staff prepare enough food for expected demand.

## 8. Live Updates with Server-Sent Events

The backend exposes:

```text
GET /api/orders/stream
```

The stream sends:

- Initial connection information
- Periodic keep-alive comments
- Update event metadata

Update types include:

- `CONNECTED`
- `STATUS_UPDATE`
- `ORDER_UPDATE`
- `MENU_UPDATE`

The student menu, order list, token page, and admin dashboard listen for relevant events and reload their protected API data when an update arrives.

The frontend tracks connection state:

- Connecting
- Live
- Reconnecting

The browser automatically attempts to reconnect when the stream is interrupted.

## 9. REST API Reference

### Public and Authentication APIs

| Method | Endpoint             | Access        | Purpose                                 |
| ------ | -------------------- | ------------- | --------------------------------------- |
| `GET`  | `/api/health`        | Public        | Checks server and database availability |
| `POST` | `/api/auth/register` | Public        | Creates a student account               |
| `POST` | `/api/auth/login`    | Public        | Authenticates a user and returns a JWT  |
| `GET`  | `/api/auth/me`       | Authenticated | Returns the current user profile        |
| `GET`  | `/api/menu`          | Public        | Returns menu items and orderability     |
| `GET`  | `/api/orders/stream` | Public SSE    | Sends live update metadata              |

### Student and Authenticated APIs

| Method | Endpoint                | Access        | Purpose                               |
| ------ | ----------------------- | ------------- | ------------------------------------- |
| `POST` | `/api/orders/preview`   | Authenticated | Validates cart and calculates preview |
| `POST` | `/api/orders/checkout`  | Authenticated | Creates a paid order transactionally  |
| `GET`  | `/api/orders/my-orders` | Authenticated | Returns the current user's orders     |
| `GET`  | `/api/orders/:token`    | Authenticated | Returns one owned order by token      |
| `GET`  | `/api/wallet`           | Student | Balance, monthly credit, spent-this-month, next reset |
| `GET`  | `/api/wallet/transactions` | Student | Paginated wallet ledger (limit/offset/type filters) |
| `GET`  | `/api/wallet/insights`  | Student | Deterministic spending intelligence from the ledger |

### Administrator APIs

| Method   | Endpoint                 | Access | Purpose                            |
| -------- | ------------------------ | ------ | ---------------------------------- |
| `POST`   | `/api/menu`              | Admin  | Adds a menu item                   |
| `PUT`    | `/api/menu/:id`          | Admin  | Updates a menu item                |
| `DELETE` | `/api/menu/:id`          | Admin  | Deletes an unused menu item        |
| `GET`    | `/api/orders`            | Admin  | Returns the active kitchen queue   |
| `PUT`    | `/api/orders/:id/status` | Admin  | Advances order status              |
| `GET`    | `/api/dashboard`         | Admin  | Returns KPIs, sales, forecasts, aggregate wallet analytics |
| `GET`    | `/api/inventory`         | Admin  | Returns inventory and stock status |
| `GET`    | `/api/admin/wallet/students` | Admin | Student wallet balances and monthly spend |
| `POST`   | `/api/admin/wallet/topup` | Admin  | Audited wallet top-up (₹10–₹500, ledger `ADJUSTMENT`) |

All successful API responses use a common structure similar to:

```json
{
  "success": true,
  "data": {}
}
```

Errors use a structure similar to:

```json
{
  "success": false,
  "error": "A human-readable error message"
}
```

## 10. Database Design

The database is named `canteen_db`.

### 10.1 `users`

Stores registered accounts.

Important columns:

- `id`: primary key
- `name`: user name
- `email`: unique email address
- `password`: bcrypt hash
- `role`: `student` or `admin`
- `created_at`: registration time

### 10.2 `menu_items`

Stores available food items.

Important columns:

- `id`: primary key
- `name`
- `description`
- `price`
- `available_quantity`
- `availability_status`
- `category`
- `image`
- `preparation_time`
- `created_at`

Constraints include positive prices, non-negative quantities, supported categories, and preparation time between 1 and 60 minutes.

### 10.3 `inventory`

Stores item-level inventory statistics.

Important columns:

- `id`: primary key
- `menu_item_id`: unique foreign key to `menu_items`
- `quantity_sold`
- `wastage_quantity`
- `updated_at`

### 10.4 `orders`

Stores placed orders.

Important columns:

- `id`: primary key
- `user_id`: foreign key to `users`
- `token`: unique digital token
- `total_amount`
- `status`: Preparing, Ready, or Collected
- `estimated_pickup`
- `created_at`

Indexes support active queue queries and per-user order history queries.

### 10.5 `order_items`

Stores the individual lines of an order.

Important columns:

- `id`: primary key
- `order_id`: foreign key to `orders`
- `menu_item_id`: foreign key to `menu_items`
- `quantity`
- `price`: price snapshot at checkout time

The price snapshot preserves historical order values even if the menu price changes later.

### 10.6 `payments`

Stores payment records.

Important columns:

- `id`: primary key
- `order_id`: unique foreign key to `orders`
- `payment_method`: `STUDENT_WALLET`
- `amount`
- `status`: `SUCCESS`
- `created_at`

Checkout creates successful wallet-payment records only. An insufficient-balance checkout returns a controlled 402 error and creates **no** payment row, order, stock change or ledger entry.

## 11. Data Integrity and Security Features

The project includes:

- bcrypt password hashing
- JWT-based authentication
- Role-based administrator authorization
- Unique email constraint
- Unique order-token constraint
- Foreign keys between related tables
- Positive and non-negative database checks
- Server-side price and quantity validation
- Database-derived prices during checkout
- Transactional inventory deduction
- Row locking during checkout
- Deterministic item locking order to reduce deadlocks
- Atomic order, payment, stock, and inventory updates
- Protected user-specific order lookup
- Invalid status transition prevention
- JSON request-size limit of 100 KB
- CORS configuration with a configurable frontend origin
- Central API error formatting
- Invalid JSON handling

## 12. User Interface and Design

The interface uses a consistent heritage canteen theme:

- Cream background
- Dark walnut brown primary color
- Muted gold accents
- Terracotta action color
- Green success/status color
- Warm borders and subtle shadows

Typography uses:

- Barlow Condensed for headings and tokens
- Lora for editorial labels and subtitles
- Inter for general interface text

UI features include:

- Responsive layouts for desktop, tablet, and mobile
- Responsive menu grid
- Mobile-friendly cart bar
- Responsive admin tables with horizontal scrolling
- Loading spinners
- Empty states
- Error and success notices
- Accessible form labels
- Descriptive button labels
- ARIA labels for dialogs and icon-like controls
- Keyboard-focusable buttons and form elements
- Themed modal dialogs
- Food image fallback initials
- Live connection indicator
- Status badges for order and inventory states

## 13. Project Files

```text
canteen-system/
|-- README.md
|-- PROJECT_DOCUMENTATION.md
|-- database/
|   `-- setup.sql
|-- server/
|   |-- package.json
|   |-- server.js
|   |-- migrate-category.js
|   |-- seed-rush-hour.js
|   `-- .env.example
`-- client/
    |-- package.json
    |-- public/
    |   |-- index.html
    |   `-- images/
    `-- src/
        |-- api.js
        |-- App.js
        |-- index.js
        |-- styles.css
        `-- pages/
            |-- Admin.js
            |-- Auth.js
            `-- Student.js
```

## 14. Important Frontend Modules

### `client/src/App.js`

Provides:

- React application shell
- Authentication context
- Protected routes
- Student and admin navigation
- Session restoration
- Logout behavior
- Unauthorized-event handling

### `client/src/api.js`

Provides:

- JSON fetch wrapper
- Standard API response handling
- Authorization headers
- Unauthorized session event dispatching
- Currency formatting
- Time formatting

### `client/src/pages/Auth.js`

Provides:

- Login form
- Registration form
- Client-side form constraints
- Loading state
- Error messages
- Registration success notice

### `client/src/pages/Student.js`

Provides:

- Menu page
- Cart behavior
- Category filtering
- Food image fallback
- Review modal
- Payment modal
- My Orders page
- Token page
- Queue tracking
- SSE updates
- Loading and empty-state components

### `client/src/pages/Admin.js`

Provides:

- Queue tab
- Menu tab
- Inventory tab
- Dashboard tab
- Menu form
- Delete confirmation dialog
- Status updates
- Admin loading and notices
- SSE refresh behavior

### `client/src/styles.css`

Provides the full responsive visual system, including:

- Color variables
- Typography
- Layouts
- Buttons
- Forms
- Tables
- Cards
- Modals
- Status badges
- Loading states
- Empty states
- Mobile breakpoints

## 15. Server Configuration

Configuration is read from `server/.env`.

Expected values:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=canteen_db
JWT_SECRET=use_a_private_secret
SERVER_PORT=5000
CLIENT_ORIGIN=http://localhost:3000
```

The backend defaults to port `5000`. The React development server uses port `3000` and proxies API requests to the backend.

## 16. Installation and Running

### 16.1 Database Setup

Run the SQL script for the initial schema and seed data:

```powershell
cd "C:\Users\Jeyaramalakshmi M\Downloads\canteen-system\canteen-system"
Get-Content .\database\setup.sql | & "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe" -u root -p
```

The current setup script preserves the `users` table and registered accounts when run again. It resets menu, inventory, order, and payment-related operational data. Therefore, do not run it when you need to preserve existing orders or menu changes.

### 16.2 Start the Backend

```powershell
cd "C:\Users\Jeyaramalakshmi M\Downloads\canteen-system\canteen-system\server"
npm install
npm start
```

The server should report that it is running on port `5000`.

### 16.3 Start the Frontend

Open another terminal:

```powershell
cd "C:\Users\Jeyaramalakshmi M\Downloads\canteen-system\canteen-system\client"
npm install
npm start
```

Open:

```text
http://localhost:3000
```

### 16.4 Health Check

```powershell
Invoke-RestMethod http://localhost:5000/api/health
```

A successful response identifies the service as `canteen-server`.

## 17. NPM Commands

### Server commands

```bash
npm start
npm run seed:rush-hour
npm run migrate:category
```

- `npm start`: starts the Express API.
- `npm run seed:rush-hour`: creates 30 paid active demonstration orders in one transaction.
- `npm run migrate:category`: adds and classifies the category column for older databases.

### Client commands

```bash
npm start
npm run build
```

- `npm start`: starts the React development server.
- `npm run build`: creates the optimized production build.

## 18. Demo Accounts

The database seed includes `admin@canteen.com` and `student@canteen.com`. Their seeded passwords are **publicly documented in this repository**, so the server automatically rotates them on first boot and prints the new credentials **once** to the server console:

```text
[security] rotated legacy seed password
[security]   admin@canteen.com → <generated>
[security]   (printed once — change it after first login)
```

Copy the printed credentials immediately; they are not stored in plaintext and will not be shown again. New student registrations are stored permanently in MySQL unless the users table is deliberately deleted or the database is restored from an older backup.

## 19. Rush-Hour Demonstration

Run from the `server` directory:

```bash
npm run seed:rush-hour
```

The script:

- Selects the first student account.
- Selects up to three enabled menu items with at least 10 available units.
- Creates 30 paid orders.
- Adds order item rows.
- Updates menu stock.
- Updates quantity sold.
- Uses real preparation times for pickup estimates.
- Executes the whole operation inside one transaction.

The script requires at least three suitable menu items and enough stock.

## 20. Database Reset Warning

`database/setup.sql` should be treated as a setup and seed script, not as a daily startup command.

It currently:

- Preserves the `users` table and registered accounts.
- Drops and recreates order-related and menu-related operational data.
- Re-seeds demo menu items and inventory.
- Resets menu quantities and order history.

Always create a database backup before running schema or seed scripts on a database containing important data.

## 21. Known Limitations

1. Food image files are not currently included in `client/public/images`, so the interface uses first-letter fallbacks for seeded menu items.
2. The frontend stores JWT tokens in `localStorage`, which is less resistant to XSS than an HTTP-only cookie approach.
3. There is no server-side logout token revocation. Logout removes the browser token only.
4. If `JWT_SECRET` is not configured, the server warns and uses a development fallback secret. Production deployments must define a strong secret.
5. The SSE endpoint is public and broadcasts update metadata to connected browsers. Protected data is still reloaded through authenticated API calls.
6. The preview pickup estimate uses a general preparation estimate, while final checkout uses the actual stored preparation time for each item. The preview and final estimate can therefore differ.
7. Payment is an internal wallet system; there is no real-money gateway integration.
8. Wallet payments are internal credits; there is no real-money gateway integration.
9. Inventory changes are made through menu editing; there is no dedicated inventory adjustment history.
10. The rush-hour seed script changes the database directly and does not broadcast updates to already-open browser clients.
11. Dashboard total order count includes all orders, while revenue uses successful payments.
12. The project does not currently include automated unit, integration, or end-to-end test suites.
13. The project uses React Scripts 5 and may display Node.js deprecation warnings from older build tooling. These warnings do not prevent the application from running.

## 22. Suggested Demonstration Flow

### Student demonstration

1. Open the application.
2. Register a new student account.
3. Log in.
4. Open Today's Menu.
5. Filter by a category.
6. Add one or more items.
7. Change quantities in the cart.
8. Review the order and confirm the wallet payment (or attempt an over-balance order to see the insufficient-balance guard).
9. Display the digital token.
10. Open My Orders.
11. Open the Wallet page and show balance, spending insights and the transaction ledger.
12. Show queue position and live status.

### Administrator demonstration

1. Log out from the student account.
2. Log in as the administrator.
3. Show the active queue.
4. Mark an order Ready.
5. Mark it Collected.
6. Open Menu Management.
7. Add or edit an item.
8. Disable and enable an item.
9. Delete an item using the confirmation modal.
10. Open Inventory and show stock status.
11. Open Dashboard and show KPIs.
12. Show item-wise sales and popular items.
13. Show the seven-day demand forecast.
14. Run the rush-hour seed command if a larger queue is needed.

## 23. Summary

Campus Canteen combines student ordering, digital tokens, wallet-based payment with an auditable transaction ledger, inventory validation, administrator queue management, menu control, wallet analytics, sales reporting, demand forecasting, and live browser updates in one application. The strongest technical features are the role-based API, bcrypt authentication, JWT sessions, MySQL constraints, transaction-safe checkout with wallet row locking, per-user advisory checkout locks, idempotent monthly wallet credits enforced by database constraints, unique token generation, and throttled SSE-based refresh behavior.
