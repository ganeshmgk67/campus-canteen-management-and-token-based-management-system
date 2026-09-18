CREATE DATABASE IF NOT EXISTS canteen_db;
USE canteen_db;

DROP TABLE IF EXISTS wallet_transactions;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS menu_items;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('student','admin') NOT NULL DEFAULT 'student',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE menu_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL CHECK (price > 0),
  available_quantity INT NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
  availability_status BOOLEAN NOT NULL DEFAULT TRUE,
  category ENUM('Breakfast','Snacks','Beverages') NOT NULL DEFAULT 'Snacks',
  image VARCHAR(255),
  preparation_time INT NOT NULL DEFAULT 3 CHECK (preparation_time BETWEEN 1 AND 60),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE inventory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  menu_item_id INT NOT NULL UNIQUE,
  quantity_sold INT NOT NULL DEFAULT 0 CHECK (quantity_sold >= 0),
  wastage_quantity INT NOT NULL DEFAULT 0 CHECK (wastage_quantity >= 0),
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token VARCHAR(20) NOT NULL UNIQUE,
  total_amount DECIMAL(10,2) NOT NULL CHECK (total_amount >= 0),
  status ENUM('Preparing','Ready','Collected') NOT NULL DEFAULT 'Preparing',
  estimated_pickup DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_orders_status_created (status, created_at),
  INDEX idx_orders_user_created (user_id, created_at),
  INDEX idx_orders_queue (status, created_at, id),
  INDEX idx_orders_user_status (user_id, status)
);

CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  menu_item_id INT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
  INDEX idx_order_items_menu (menu_item_id)
);

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL UNIQUE,
  payment_method ENUM('STUDENT_WALLET') NOT NULL,
  amount DECIMAL(10,2) NOT NULL CHECK (amount >= 0),
  status ENUM('SUCCESS') NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE wallets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  balance DECIMAL(10,2) NOT NULL DEFAULT 0.00 CHECK (balance >= 0),
  monthly_allowance DECIMAL(10,2) NOT NULL DEFAULT 500.00 CHECK (monthly_allowance > 0),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
  -- Uniqueness ONLY applies to monthly credits (ORDER debits repeat freely within
  -- a period — that is normal spending). NULL credit_period values are allowed
  -- to repeat in the unique index.
  credit_period CHAR(7) GENERATED ALWAYS AS (IF(reference_type = 'MONTHLY_CREDIT', period, NULL)) STORED,
  UNIQUE KEY uq_wallet_credit_period (wallet_id, credit_period),
  INDEX idx_wt_wallet_created (wallet_id, created_at DESC),
  INDEX idx_wt_wallet_period (wallet_id, period),
  INDEX idx_wt_reference (reference_type, reference_id)
);

-- Demo accounts default credentials:
-- Admin: admin@canteen.com / admin123
-- Student: student@canteen.com / student123
INSERT IGNORE INTO users (name, email, password, role) VALUES
('Admin Staff', 'admin@canteen.com', '$2b$12$Aa695p57SStxiFwbVeDEHOAOLZB.vQkXDmrauEZfrMStm5ogs0PjG', 'admin'),
('Student User', 'student@canteen.com', '$2b$12$JPz79zyzFizSdVBcR2LpJ.eiHWOvjHKvlHEQRxbuN6mDBqxr6n6Cq', 'student');

INSERT INTO menu_items (name, description, price, available_quantity, availability_status, category, image, preparation_time) VALUES
('Idli', 'Soft fluffy idlis', 20.00, 100, TRUE, 'Breakfast', 'idli.jpg', 3),
('Dosa', 'Crispy plain dosa', 20.00, 50, TRUE, 'Breakfast', 'dosa.jpg', 4),
('Vada', 'Crispy medu vada', 5.00, 80, TRUE, 'Snacks', 'vada.jpg', 3),
('Sandwich', 'Grilled veg sandwich', 10.00, 40, TRUE, 'Snacks', 'sandwich.jpg', 5),
('Burger', 'Aloo tikki burger', 20.00, 30, TRUE, 'Snacks', 'burger.jpg', 6),
('Filter Coffee', 'Authentic South Indian coffee', 10.00, 150, TRUE, 'Beverages', 'coffee.jpg', 2);

INSERT INTO inventory (menu_item_id, quantity_sold) VALUES
(1,0),(2,0),(3,0),(4,0),(5,0),(6,0);

-- Seed wallet for the demo student. The cached balance MUST equal the ledger
-- sum (source-of-truth invariant): the credit row and the balance are inserted
-- together. The server verifies this invariant on every boot and an offline
-- auditor (npm run wallet:audit) can repair any drift from the ledger.
INSERT IGNORE INTO wallets (user_id, balance) VALUES (2, 500.00);
INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, reference_type, period, description) VALUES
(1, 'CREDIT', 500.00, 500.00, 'MONTHLY_CREDIT', DATE_FORMAT(NOW(), '%Y-%m'), CONCAT('Monthly campus allowance — ', DATE_FORMAT(NOW(), '%Y-%m')));
