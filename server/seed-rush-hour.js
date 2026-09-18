require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { ensureWalletAndMonthlyCredit, currentPeriod } = require('./wallet');

async function run() {
  const pool = mysql.createPool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'canteen_db' });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [students] = await connection.query("SELECT id FROM users WHERE role='student' ORDER BY id LIMIT 1");
    const [items] = await connection.query('SELECT id, price, available_quantity, preparation_time FROM menu_items WHERE availability_status=TRUE AND available_quantity >= 10 ORDER BY id LIMIT 3 FOR UPDATE');
    if (!students.length || items.length < 3) throw new Error('Run database/setup.sql first and ensure at least three menu items have 10 available units each');

    const studentId = students[0].id;

    // Ledger-consistent demo: guarantee the student has the current monthly
    // allowance, then top the wallet up so it can fund 30 demo orders
    // (an ADJUSTMENT credit — auditable, never a second monthly credit).
    await ensureWalletAndMonthlyCredit(connection, studentId, currentPeriod());
    const [walletRow] = await connection.query('SELECT id, balance FROM wallets WHERE user_id=? FOR UPDATE', [studentId]);
    const maxItemPrice = Math.max(...items.map(i => Number(i.price)));
    const needed = maxItemPrice * 30;
    const shortfall = needed - Number(walletRow[0].balance);
    if (shortfall > 0) {
      await connection.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, amount, balance_after, reference_type, period, description)
         VALUES (?, 'CREDIT', ?, ?, 'ADJUSTMENT', NULL, ?)`,
        [walletRow[0].id, shortfall.toFixed(2), (Number(walletRow[0].balance) + shortfall).toFixed(2), 'Rush-hour demonstration funding']
      );
      await connection.query('UPDATE wallets SET balance = balance + ? WHERE id=?', [shortfall.toFixed(2), walletRow[0].id]);
    }

    for (let index = 0; index < 30; index += 1) {
      const item = items[index % items.length]; const quantity = 1;
      if (Number(item.available_quantity) < quantity) throw new Error('Not enough stock to create rush-hour orders');
      const total = Number(item.price) * quantity; const token = `C-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const pickup = new Date(Date.now() + (index + 1) * Number(item.preparation_time) * 60000);
      const [order] = await connection.query("INSERT INTO orders (user_id, token, total_amount, estimated_pickup, status) VALUES (?, ?, ?, ?, 'Preparing')", [studentId, token, total, pickup]);
      await connection.query('INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES (?, ?, ?, ?)', [order.insertId, item.id, quantity, item.price]);
      await connection.query("INSERT INTO payments (order_id, payment_method, amount, status) VALUES (?, 'STUDENT_WALLET', ?, 'SUCCESS')", [order.insertId, total]);
      const [newBalance] = await connection.query('SELECT balance FROM wallets WHERE id=? FOR UPDATE', [walletRow[0].id]);
      await connection.query(
        `INSERT INTO wallet_transactions
           (wallet_id, type, amount, balance_after, reference_type, reference_id, period, description)
         VALUES (?, 'DEBIT', ?, ?, 'ORDER', ?, ?, ?)`,
        [walletRow[0].id, total.toFixed(2), (Number(newBalance[0].balance) - total).toFixed(2), order.insertId, currentPeriod(), `Order ${token} — canteen purchase`]
      );
      await connection.query('UPDATE wallets SET balance = balance - ? WHERE id=?', [total.toFixed(2), walletRow[0].id]);
      await connection.query('UPDATE menu_items SET available_quantity=available_quantity-?, availability_status=IF(available_quantity-? <= 0, FALSE, availability_status) WHERE id=?', [quantity, quantity, item.id]);
      await connection.query('UPDATE inventory SET quantity_sold=quantity_sold+? WHERE menu_item_id=?', [quantity, item.id]);
      item.available_quantity -= quantity;
    }
    await connection.commit();
    console.log('30 paid, inventory-backed, wallet-debited rush-hour orders inserted successfully.');
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  } finally { connection.release(); await pool.end(); }
}
run().catch(error => { console.error(error.message); process.exit(1); });
