import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api, authHeaders, currency, time } from '../api';
import { useCanteenStream, STREAM_REFRESH_MAP } from '../stream';
import { Loading, EmptyState } from '../components/ui';
import { OrderCard } from '../components/OrderCard';
import CheckoutModal from '../components/CheckoutModal';
import TokenPass from '../components/TokenPass';
import WalletPage from './Wallet';

/* ─── Constants ─────────────────────────────────────────── */
const CATEGORIES = ['All', 'Breakfast', 'Snacks', 'Beverages'];
const lineCount = cart => cart.reduce((total, item) => total + item.quantity, 0);

/* ─── Food Image ────────────────────────────────────────── */
function FoodImage({ item }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`food-image ${failed ? 'image-fallback' : ''}`}>
      <img
        src={item.image ? `/images/${item.image}` : ''}
        alt={item.name}
        onError={() => setFailed(true)}
      />
      <span aria-hidden="true">{item.name.slice(0, 1)}</span>
    </div>
  );
}

/* ─── Menu ──────────────────────────────────────────────── */
function Menu() {
  const [menu, setMenu] = useState([]);
  const [cart, setCart] = useState([]);
  const [category, setCategory] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const nextMenu = await api('/api/menu');
      setMenu(nextMenu);
      setCart(current =>
        current.flatMap(line => {
          const fresh = nextMenu.find(item => item.id === line.id);
          return fresh?.is_orderable
            ? [{ ...line, ...fresh, quantity: Math.min(line.quantity, Number(fresh.available_quantity)) }]
            : [];
        })
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Menu page reloads only on menu events; the hook throttles per event type.
  useCanteenStream({
    onStatus: () => {},
    onEvent: type => { if (type === 'MENU_UPDATE') load(); }
  });

  useEffect(() => { load(); }, [load]);

  const changeQuantity = (item, diff) => {
    setError('');
    setCart(current => {
      const existing = current.find(l => l.id === item.id);
      const nextQty = (existing?.quantity || 0) + diff;
      if (nextQty <= 0) return current.filter(l => l.id !== item.id);
      if (nextQty > Number(item.available_quantity)) {
        setError(`Only ${item.available_quantity} ${item.name} available.`);
        return current;
      }
      return existing
        ? current.map(l => l.id === item.id ? { ...l, quantity: nextQty } : l)
        : [...current, { ...item, quantity: 1 }];
    });
  };

  const checkout = async () => {
    setError('');
    setCheckingOut(true);
    try {
      const preview = await api('/api/orders/preview', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ cart })
      });
      setSummary(preview);
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setCheckingOut(false);
    }
  };

  const filteredMenu = menu.filter(item => category === 'All' || item.category === category);
  const total = useMemo(() => cart.reduce((sum, l) => sum + Number(l.price) * l.quantity, 0), [cart]);

  return (
    <main className="page">
      <div className="menu-header">
        <div className="menu-header-row">
          <div>
            <div className="eyebrow">Campus Canteen</div>
            <h1 className="font-display">Today's Menu</h1>
            <p className="page-subtitle">Order ahead. Pay from your campus wallet.</p>
            <Link className="wallet-pill" to="/student/wallet">
              <span className="wallet-pill-icon" aria-hidden="true">◆</span>
              <span className="wallet-pill-label">Campus Wallet</span>
              <span className="wallet-pill-hint">balance & spending →</span>
            </Link>
          </div>
          {cart.length > 0 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setCart([])}>
              Clear cart
            </button>
          )}
        </div>
        <div className="category-tabs" aria-label="Menu categories">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              className={`tab${category === cat ? ' active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          <span>⚠</span><span>{error}</span>
          <button className="dismiss" onClick={() => setError('')} aria-label="Dismiss">×</button>
        </div>
      )}

      {loading ? (
        <Loading label="Loading today's menu…" />
      ) : filteredMenu.length ? (
        <div className="menu-grid">
          {filteredMenu.map(item => {
            const inCart = cart.find(l => l.id === item.id)?.quantity || 0;
            const available = Boolean(item.is_orderable);
            const qty = Number(item.available_quantity);
            const stockLabel = !available
              ? 'Sold Out'
              : qty <= 20
              ? `Low Stock · ${qty} left`
              : `${qty} available`;
            const stockClass = !available ? 'off' : qty <= 20 ? 'low' : 'available';

            return (
              <article className="menu-item" key={item.id}>
                <FoodImage item={item} />
                <div className="menu-content">
                  <div className="menu-title-row">
                    <div>
                      <div className="menu-title">{item.name}</div>
                      <div className="menu-desc">{item.description || 'Freshly prepared on campus.'}</div>
                    </div>
                    <span className="menu-price">{currency(item.price)}</span>
                  </div>
                  <div className="menu-actions">
                    <span className={`stock ${stockClass}`}>{stockLabel}</span>
                    {inCart ? (
                      <div className="quantity-control">
                        <button aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(item, -1)}>−</button>
                        <span>{inCart}</span>
                        <button
                          aria-label={`Add one ${item.name}`}
                          disabled={!available || inCart >= item.available_quantity}
                          onClick={() => changeQuantity(item, 1)}
                        >+</button>
                      </div>
                    ) : (
                      <button
                        className="btn btn-walnut btn-sm"
                        disabled={!available}
                        onClick={() => changeQuantity(item, 1)}
                      >
                        {available ? 'Add' : 'Sold Out'}
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState title="No items in this category" text="Try another menu category." />
      )}

      {cart.length > 0 && (
        <aside className="cart-bar">
          <div className="cart-bar-info">
            <strong>{currency(total)}</strong>
            <span>{lineCount(cart)} item{lineCount(cart) !== 1 ? 's' : ''} in cart</span>
          </div>
          <div className="cart-bar-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setCart([])} aria-label="Clear cart">
              Clear
            </button>
            <button className="btn btn-primary" disabled={checkingOut} onClick={checkout}>
              {checkingOut ? <><span className="spinner" />Checking stock…</> : 'Review & Checkout →'}
            </button>
          </div>
        </aside>
      )}

      {summary && (
        <CheckoutModal
          summary={summary}
          cart={cart}
          close={() => setSummary(null)}
          onSuccess={order => { setCart([]); navigate(`/student/token/${order.token}`); }}
          refresh={load}
          onRefreshMenu={load}
        />
      )}
    </main>
  );
}

/* ─── My Orders ─────────────────────────────────────────── */
function MyOrders() {
  const [orders, setOrders] = useState({ current: [], history: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('connecting');

  const load = useCallback(async () => {
    try {
      setOrders(await api('/api/orders/my-orders', { headers: authHeaders() }));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useCanteenStream({
    onStatus: setConnection,
    onEvent: type => {
      if (STREAM_REFRESH_MAP[type]?.includes('orders')) load();
    }
  });

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <main className="page center">
        <Loading label="Loading your orders…" />
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Student Orders</div>
          <h1>My Orders</h1>
          <p className="page-subtitle">Track active pickups and revisit your order history.</p>
        </div>
        <span className={`connection ${connection}`}>
          {connection === 'live' ? '● Live' : '↻ Reconnecting'}
        </span>
      </div>

      {error && (
        <div className="error-box" role="alert">
          <span>⚠</span><span>{error}</span>
        </div>
      )}

      <section className="orders-section">
        <div className="section-title">
          <h2>Current Orders</h2>
          <span className="section-count">{orders.current.length}</span>
        </div>
        {orders.current.length
          ? orders.current.map(order => <OrderCard key={order.id} order={order} />)
          : <EmptyState title="No current orders" text="Your active orders will appear here after checkout." />}
      </section>

      <section className="orders-section">
        <div className="section-title">
          <h2>Order History</h2>
          <span className="section-count">{orders.history.length}</span>
        </div>
        {orders.history.length
          ? orders.history.map(order => <OrderCard key={order.id} order={order} history />)
          : <EmptyState title="No collected orders" text="Your completed orders will remain here for reference." />}
      </section>
    </main>
  );
}

/* ─── Token Screen ──────────────────────────────────────── */
function TokenScreen() {
  const { token } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('connecting');

  const load = useCallback(async () => {
    try {
      setOrder(await api(`/api/orders/${token}`, { headers: authHeaders() }));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [token]);

  useCanteenStream({
    onStatus: setConnection,
    onEvent: type => {
      if (STREAM_REFRESH_MAP[type]?.includes('orders')) load();
    }
  });

  useEffect(() => { load(); }, [load]);

  const steps = ['Order Placed', 'Payment Verified', 'Preparing', 'Ready for Pickup', 'Collected'];
  const current = order?.status === 'Preparing' ? 2
    : order?.status === 'Ready' ? 3
    : order?.status === 'Collected' ? 4
    : 1;

  if (error && !order) {
    return (
      <main className="page">
        <div className="error-box" role="alert"><span>⚠</span><span>{error}</span></div>
        <Link className="back-link" to="/student/menu">← Back to menu</Link>
      </main>
    );
  }
  if (!order) {
    return (
      <main className="page center">
        <Loading label="Loading your digital token…" />
      </main>
    );
  }

  return (
    <main className="page">
      <Link to="/student/orders" className="back-link">← My Orders</Link>
      <div className="token-layout">
        <TokenPass order={order} />

        <section className="queue-card">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Live Queue</div>
              <h2>
                {order.status === 'Collected' ? 'Order Collected' : order.status === 'Ready' ? 'Ready for Pickup' : 'Being Prepared'}
              </h2>
            </div>
            <span className={`connection ${connection}`}>
              {connection === 'live' ? '● Live' : '↻ Reconnecting'}
            </span>
          </div>

          <div className="token-items">
            {order.items?.map(item => (
              <div className="item-row" key={item.name}>
                <span className="item-name">{item.name} × {item.quantity}</span>
                <span className="item-price">{currency(Number(item.price) * item.quantity)}</span>
              </div>
            ))}
          </div>

          <div className="queue-numbers">
            <div>
              <span className="q-label">Queue Position</span>
              <span className="q-value">{order.status === 'Preparing' ? `#${order.queue_position}` : '—'}</span>
            </div>
            <div>
              <span className="q-label">Orders Ahead</span>
              <span className="q-value">{order.orders_ahead}</span>
            </div>
          </div>

          <ol className="timeline" aria-label="Order progress">
            {steps.map((step, index) => (
              <li key={step} className={index < current ? 'done' : index === current ? 'active' : ''}>
                {step}
              </li>
            ))}
          </ol>

          {error && <div className="error-box" role="alert"><span>⚠</span><span>{error}</span></div>}
          <p className="muted small" style={{ fontStyle: 'italic' }}>
            Status updates appear automatically when canteen staff process your order.
          </p>
        </section>
      </div>
    </main>
  );
}

/* ─── Router ────────────────────────────────────────────── */
export default function Student() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/student/menu" replace />} />
      <Route path="/menu" element={<Menu />} />
      <Route path="/orders" element={<MyOrders />} />
      <Route path="/wallet" element={<WalletPage />} />
      <Route path="/token/:token" element={<TokenScreen />} />
      <Route path="*" element={<Navigate to="/student/menu" replace />} />
    </Routes>
  );
}
