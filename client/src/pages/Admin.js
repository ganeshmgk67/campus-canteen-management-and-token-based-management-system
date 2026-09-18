import React, { useEffect, useState } from "react";
import { api, authHeaders, currency, time } from "../api";
import { useCanteenStream, STREAM_REFRESH_MAP } from "../stream";
import { EmptyState, Loading, Modal } from "../components/ui";

const TOPUP_REASONS = [
  "Allowance top-up",
  "Compensation for service issue",
  "Staff meal allowance",
  "Manual adjustment",
];

const BLANK_ITEM = {
  name: "",
  description: "",
  price: "",
  available_quantity: "",
  availability_status: true,
  category: "Snacks",
  preparation_time: 3,
  image: "",
};

export default function Admin() {
  const [view, setView] = useState("queue");
  const [orders, setOrders] = useState([]);
  const [dash, setDash] = useState({
    stats: {},
    forecast: [],
    popular: [],
    itemWise: [],
  });
  const [inventory, setInventory] = useState([]);
  const [menu, setMenu] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("notice");
  const [updating, setUpdating] = useState(null);
  const [editor, setEditor] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [studentWallets, setStudentWallets] = useState([]);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [queue, dashboard, stock, items, walletRows] = await Promise.all([
        api("/api/orders", { headers: authHeaders() }),
        api("/api/dashboard", { headers: authHeaders() }),
        api("/api/inventory", { headers: authHeaders() }),
        api("/api/menu"),
        api("/api/admin/wallet/students", { headers: authHeaders() }),
      ]);
      setOrders(queue);
      setDash(dashboard);
      setInventory(stock);
      setMenu(items);
      setStudentWallets(walletRows);
    } catch (err) {
      setMessage(err.message);
      setMessageType("error");
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  const [connection, setConnection] = useState("connecting");

  // Throttled, filtered SSE refreshes: orders/dashboard refresh on order
  // events, menu/inventory on menu events, wallet cards on wallet events.
  // (Replaces the previous reload-everything-on-any-event behavior.)
  useCanteenStream({
    onStatus: setConnection,
    onEvent: (type) => {
      const targets = STREAM_REFRESH_MAP[type] || [];
      if (type === "WALLET_UPDATE") {
        refreshWallets();
        return;
      }
      if (targets.includes("orders") || targets.includes("dashboard") || targets.includes("stock") || targets.includes("menu")) {
        load(true);
      }
    },
  });

  useEffect(() => {
    load();
  }, []);

  const tell = (text, type = "notice") => {
    setMessage(text);
    setMessageType(type);
  };

  const refreshWallets = async () => {
    try {
      setStudentWallets(await api("/api/admin/wallet/students", { headers: authHeaders() }));
    } catch {
      /* wallet list refresh is best-effort; primary toast from the action shows errors */
    }
  };

  const updateStatus = async (order) => {
    const status = order.status === "Preparing" ? "Ready" : "Collected";
    setUpdating(order.id);
    try {
      await api(`/api/orders/${order.id}/status`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ status }),
      });
      tell(`${order.token} marked ${status}.`);
      await load(true);
    } catch (err) {
      tell(err.message, "error");
    } finally {
      setUpdating(null);
    }
  };

  const saveItem = async (item) => {
    const payload = { ...item };
    delete payload.is_orderable;
    ["price", "available_quantity", "preparation_time"].forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(payload, key))
        payload[key] = Number(payload[key]);
    });
    if (Object.prototype.hasOwnProperty.call(payload, "availability_status")) {
      payload.availability_status = Boolean(payload.availability_status);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "description")) {
      payload.description = payload.description || "";
    }
    if (Object.prototype.hasOwnProperty.call(payload, "image")) {
      payload.image = payload.image || "";
    }
    setUpdating("menu");
    try {
      if (item.id) {
        await api(`/api/menu/${item.id}`, {
          method: "PUT",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/menu", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
      }
      setEditor(null);
      tell(`Menu item ${item.id ? "updated" : "added"}.`);
      await load(true);
    } catch (err) {
      tell(err.message, "error");
    } finally {
      setUpdating(null);
    }
  };

  const removeItem = async (item) => {
    setUpdating(item.id);
    try {
      await api(`/api/menu/${item.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      tell(`${item.name} deleted.`);
      await load(true);
    } catch (err) {
      tell(err.message, "error");
    } finally {
      setUpdating(null);
      setDeleting(null);
    }
  };

  const toggle = (item) =>
    saveItem({ id: item.id, availability_status: !item.availability_status });

  const TABS = ["queue", "menu", "inventory", "dashboard", "wallet"];

  return (
    <main className="page wide">
      <div className="admin-head">
        <div>
          <div className="eyebrow">Canteen Command Centre</div>
          <h1>Operations</h1>
          <p className="page-subtitle">
            Queue · Inventory · Sales · Demand — all in one place.
          </p>
        </div>
        <div className="tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`tab-admin${view === tab ? " active" : ""}`}
              onClick={() => setView(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="live-connection-row">
        <span className={`connection ${connection}`}>
          {connection === "live" ? "● Live updates" : "↻ Reconnecting"}
        </span>
      </div>

      {message && (
        <div
          className={messageType === "error" ? "error-box" : "notice-box"}
          role="status"
        >
          {messageType === "error" ? <span>⚠</span> : <span>✓</span>}
          <span>{message}</span>
          <button
            className="dismiss"
            onClick={() => setMessage("")}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {loading ? (
        <Loading label="Loading canteen operations…" />
      ) : (
        <>
          {view === "queue" && (
            <Queue
              orders={orders}
              updating={updating}
              updateStatus={updateStatus}
              inventory={inventory}
            />
          )}
          {view === "menu" && (
            <MenuManagement
              menu={menu}
              editor={editor}
              setEditor={setEditor}
              deleting={deleting}
              setDeleting={setDeleting}
              saveItem={saveItem}
              removeItem={removeItem}
              toggle={toggle}
              updating={updating}
            />
          )}
          {view === "inventory" && <Inventory rows={inventory} />}
          {view === "dashboard" && (
            <>
              <WalletAnalytics data={dash.wallet} />
              <Dashboard dash={dash} />
            </>
          )}
          {view === "wallet" && (
            <WalletManagement
              rows={studentWallets}
              onDone={async (msg, type) => {
                tell(msg, type);
                await refreshWallets();
              }}
            />
          )}
        </>
      )}
    </main>
  );
}

/* ─── Queue ──────────────────────────────────────────────── */
function Queue({ orders, updating, updateStatus, inventory }) {
  const preparing = orders.filter((o) => o.status === "Preparing");
  const ready = orders.filter((o) => o.status === "Ready");
  const lowStock = inventory.filter(
    (i) => i.stock_status === "Low Stock",
  ).length;

  const renderRows = (rows) =>
    rows.map((order) => (
      <tr key={order.id}>
        <td>
          <strong
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 16,
              letterSpacing: ".04em",
              color: "var(--primary)",
            }}
          >
            {order.token}
          </strong>
        </td>
        <td>#{order.id}</td>
        <td>{order.student_name}</td>
        <td className="item-cell">
          {order.item_summary || `${order.total_items} item(s)`}
        </td>
        <td>{order.total_items}</td>
        <td>{time(order.created_at)}</td>
        <td>{time(order.estimated_pickup)}</td>
        <td>
          <strong>{currency(order.total_amount)}</strong>
        </td>
        <td>
          <span className={`status ${order.status.toLowerCase()}`}>
            {order.status}
          </span>
        </td>
        <td>
          <button
            className="btn btn-walnut btn-sm"
            disabled={updating === order.id}
            onClick={() => updateStatus(order)}
          >
            {updating === order.id
              ? "Updating…"
              : order.status === "Preparing"
                ? "Mark Ready"
                : "Mark Collected"}
          </button>
        </td>
      </tr>
    ));

  const renderTable = (rows, title) => (
    <section className="panel queue-section" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="muted small">
          {rows.length} order{rows.length !== 1 ? "s" : ""}
        </span>
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Order</th>
                <th>Student</th>
                <th>Items</th>
                <th>Qty</th>
                <th>Ordered</th>
                <th>Pickup</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>{renderRows(rows)}</tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title={`No ${title.toLowerCase()}`}
          text="This section updates automatically when an order arrives."
        />
      )}
    </section>
  );

  return (
    <>
      {/* Mini KPI row */}
      <div className="queue-kpi-row">
        <div className="queue-kpi accent">
          <span className="qk-label">Active Orders</span>
          <span className="qk-value">{orders.length}</span>
        </div>
        <div className="queue-kpi warn">
          <span className="qk-label">Preparing</span>
          <span className="qk-value">{preparing.length}</span>
        </div>
        <div className="queue-kpi ok">
          <span className="qk-label">Ready</span>
          <span className="qk-value">{ready.length}</span>
        </div>
        <div className={`queue-kpi${lowStock > 0 ? " warn" : ""}`}>
          <span className="qk-label">Low Stock</span>
          <span className="qk-value">{lowStock}</span>
        </div>
      </div>

      {/* Live label */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <div>
          <h2
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontSize: 20,
              fontWeight: 700,
              color: "var(--primary)",
              textTransform: "uppercase",
              letterSpacing: ".04em",
            }}
          >
            Live Order Queue
          </h2>
          <p className="muted small" style={{ marginTop: 2 }}>
            Preparing orders are prioritised. Collected orders leave the active
            queue.
          </p>
        </div>
        <span className="live-dot">Live SSE</span>
      </div>

      {renderTable(preparing, "Preparing")}
      {renderTable(ready, "Ready for Pickup")}
    </>
  );
}

/* ─── Menu Management ────────────────────────────────────── */
function MenuManagement({
  menu,
  editor,
  setEditor,
  deleting,
  setDeleting,
  saveItem,
  removeItem,
  toggle,
  updating,
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Menu Management</h2>
        <button
          className="btn btn-walnut btn-sm"
          onClick={() => setEditor({ ...BLANK_ITEM })}
        >
          + Add Item
        </button>
      </div>

      {editor && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="Menu item editor"
        >
          <MenuForm
            item={editor}
            onCancel={() => setEditor(null)}
            onSave={saveItem}
            busy={updating === "menu"}
          />
        </div>
      )}

      {deleting && (
        <div
          className="modal"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="delete-title"
          aria-describedby="delete-description"
        >
          <div className="modal-card confirm-card">
            <div className="modal-head">
              <div>
                <div className="eyebrow">Menu Item</div>
                <h2 id="delete-title">Delete Item?</h2>
              </div>
              <button
                type="button"
                className="dismiss btn btn-ghost"
                onClick={() => setDeleting(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p id="delete-description" className="muted confirm-copy">
              Delete <strong>{deleting.name}</strong>? This action cannot be
              undone.
            </p>
            <div className="button-group confirm-actions">
              <button
                type="button"
                className="btn btn-danger"
                autoFocus
                disabled={updating === deleting.id}
                onClick={() => removeItem(deleting)}
              >
                {updating === deleting.id ? (
                  <>
                    <span className="spinner" /> Deleting…
                  </>
                ) : (
                  "Delete Item"
                )}
              </button>
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => setDeleting(null)}
                disabled={updating === deleting.id}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {menu.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Price</th>
                <th>Stock</th>
                <th>Prep</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {menu.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <div className="muted small">{item.description}</div>
                  </td>
                  <td>{item.category}</td>
                  <td>
                    <strong>{currency(item.price)}</strong>
                  </td>
                  <td>{item.available_quantity}</td>
                  <td>{item.preparation_time} min</td>
                  <td>
                    <span
                      className={`status ${item.is_orderable ? "ready" : "collected"}`}
                    >
                      {item.is_orderable ? "Available" : "Unavailable"}
                    </span>
                  </td>
                  <td>
                    <div className="button-group">
                      <button
                        className="btn btn-sm btn-outline"
                        onClick={() => setEditor({ ...item })}
                      >
                        Edit
                      </button>
                      <button
                        className="btn btn-sm btn-outline"
                        disabled={updating === "menu"}
                        onClick={() => toggle(item)}
                      >
                        {item.availability_status ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={updating === item.id}
                        onClick={() => setDeleting(item)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No menu items"
          text="Add an item to start taking orders."
        />
      )}
    </section>
  );
}

/* ─── Menu Form (Modal) ──────────────────────────────────── */
function MenuForm({ item, onCancel, onSave, busy }) {
  const [form, setForm] = useState(item);
  const update = (key) => (event) =>
    setForm((c) => ({
      ...c,
      [key]:
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value,
    }));

  return (
    <form
      className="modal-card menu-form"
      style={{
        width: "min(560px, 100%)",
        maxHeight: "calc(100vh - 32px)",
        overflowY: "auto",
      }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
    >
      <div className="modal-head">
        <div>
          <div className="eyebrow">Menu Item</div>
          <h2>{item.id ? `Edit — ${item.name}` : "New Menu Item"}</h2>
        </div>
        <button
          type="button"
          className="dismiss btn btn-ghost"
          onClick={onCancel}
          aria-label="Close"
        >
          ×
        </button>
      </div>

      <div className="form-grid" style={{ marginTop: 8 }}>
        <div>
          <label className="form-label" htmlFor="mf-name">
            Item Name *
          </label>
          <input
            id="mf-name"
            className="input"
            placeholder="e.g. Masala Dosa"
            value={form.name}
            onChange={update("name")}
            required
          />
        </div>
        <div>
          <label className="form-label" htmlFor="mf-category">
            Category
          </label>
          <select
            id="mf-category"
            className="input"
            value={form.category || "Snacks"}
            onChange={update("category")}
          >
            <option>Breakfast</option>
            <option>Snacks</option>
            <option>Beverages</option>
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="mf-price">
            Price (₹) *
          </label>
          <input
            id="mf-price"
            className="input"
            type="number"
            placeholder="0.00"
            min="0.01"
            step="0.01"
            value={form.price}
            onChange={update("price")}
            required
          />
        </div>
        <div>
          <label className="form-label" htmlFor="mf-qty">
            Available Quantity *
          </label>
          <input
            id="mf-qty"
            className="input"
            type="number"
            placeholder="0"
            min="0"
            step="1"
            value={form.available_quantity}
            onChange={update("available_quantity")}
            required
          />
        </div>
        <div>
          <label className="form-label" htmlFor="mf-prep">
            Preparation Time (min) *
          </label>
          <input
            id="mf-prep"
            className="input"
            type="number"
            placeholder="3"
            min="1"
            max="60"
            value={form.preparation_time}
            onChange={update("preparation_time")}
            required
          />
        </div>
        <div>
          <label className="form-label" htmlFor="mf-image">
            Image Filename
          </label>
          <input
            id="mf-image"
            className="input"
            placeholder="e.g. idli.jpg"
            value={form.image || ""}
            onChange={update("image")}
          />
        </div>
        <div className="form-span">
          <label className="form-label" htmlFor="mf-desc">
            Description
          </label>
          <input
            id="mf-desc"
            className="input"
            placeholder="Short description"
            value={form.description || ""}
            onChange={update("description")}
          />
        </div>
        <div className="form-span">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.availability_status)}
              onChange={update("availability_status")}
            />
            Available for ordering
          </label>
        </div>
      </div>

      <div className="button-group" style={{ marginTop: 20 }}>
        <button className="btn btn-walnut" disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" style={{ borderTopColor: "#c9a84c" }} />{" "}
              Saving…
            </>
          ) : (
            "Save Item"
          )}
        </button>
        <button type="button" className="btn btn-outline" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ─── Inventory ──────────────────────────────────────────── */
function Inventory({ rows }) {
  const maxQty = Math.max(...rows.map((r) => Number(r.available_quantity)), 1);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Inventory</h2>
          <p className="muted small">
            Low stock: 1–20 items · Out of stock: 0 items
          </p>
        </div>
      </div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Current Stock</th>
                <th>Quantity Sold</th>
                <th>Availability</th>
                <th>Stock Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const pct = Math.max(
                  3,
                  (Number(item.available_quantity) / maxQty) * 100,
                );
                const barClass =
                  item.stock_status === "Out of Stock"
                    ? "out"
                    : item.stock_status === "Low Stock"
                      ? "low"
                      : "normal";
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                    </td>
                    <td>
                      <div className="stock-bar-wrap">
                        <strong>{item.available_quantity}</strong>
                        <div className="stock-bar-bg">
                          <div
                            className={`stock-bar-fill ${barClass}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td>{item.quantity_sold}</td>
                    <td>{item.is_orderable ? "Available" : "Disabled"}</td>
                    <td>
                      <span
                        className={`stock-badge ${item.stock_status.toLowerCase().replaceAll(" ", "-")}`}
                      >
                        {item.stock_status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No inventory records"
          text="Inventory will appear when menu items are added."
        />
      )}
    </section>
  );
}

/* ─── Dashboard ──────────────────────────────────────────── */
function Dashboard({ dash }) {
  const stats = dash.stats || {};
  const topItem = dash.popular?.[0];

  const kpis = [
    { label: "Total Orders", value: stats.total_orders || 0 },
    {
      label: "Total Revenue",
      value: currency(stats.total_revenue),
      cls: "accent",
    },
    { label: "Items Sold", value: stats.items_sold || 0 },
    { label: "Active Orders", value: stats.active_orders || 0, cls: "warn" },
    { label: "Ready Orders", value: stats.ready_orders || 0, cls: "ok" },
    {
      label: "Low Stock",
      value: stats.low_stock_items || 0,
      cls: stats.low_stock_items > 0 ? "warn" : "",
    },
  ];

  return (
    <section>
      {/* KPI Grid */}
      <div className="kpi-grid">
        {kpis.map(({ label, value, cls }) => (
          <div className={`kpi${cls ? ` ${cls}` : ""}`} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      {/* Operational Insights */}
      <section className="panel insights">
        <div className="panel-head">
          <h2>Operational Insights</h2>
          <span className="muted small">Live database view</span>
        </div>
        <div className="insight-grid">
          <div className="insight-card">
            <span className="i-label">Most Ordered</span>
            <span className="i-value">
              {topItem
                ? `${topItem.name} (${topItem.quantity_sold})`
                : "No sales yet"}
            </span>
          </div>
          <div className="insight-card">
            <span className="i-label">Queue Now</span>
            <span className="i-value">
              {stats.active_orders || 0} preparing · {stats.ready_orders || 0}{" "}
              ready
            </span>
          </div>
          <div className="insight-card">
            <span className="i-label">Stock Watch</span>
            <span
              className="i-value"
              style={{
                color:
                  (stats.low_stock_items || 0) > 0
                    ? "var(--warning)"
                    : "var(--ok)",
              }}
            >
              {stats.low_stock_items || 0} low-stock item
              {stats.low_stock_items !== 1 ? "s" : ""}
            </span>
          </div>
          <div className="insight-card">
            <span className="i-label">Queue Clearance</span>
            <span
              className="i-value"
              style={{
                color: stats.active_orders ? "var(--warning)" : "var(--ok)",
              }}
            >
              {stats.active_orders ? "In progress" : "Queue clear"}
            </span>
          </div>
        </div>
      </section>

      {/* Sales tables */}
      <div className="dashboard-grid">
        <DataTable
          title="Item-wise Sales"
          rows={dash.itemWise}
          headers={["Item", "Qty Sold", "Revenue"]}
          cells={(row) => (
            <>
              <td>{row.name}</td>
              <td>{row.quantity_sold}</td>
              <td>
                <strong>{currency(row.revenue)}</strong>
              </td>
            </>
          )}
          empty="No sales data yet."
        />
        <DataTable
          title="Popular Items"
          rows={dash.popular}
          headers={["Item", "Quantity Sold"]}
          cells={(row) => (
            <>
              <td>{row.name}</td>
              <td>
                <div className="bar-cell">
                  <span
                    className="bar"
                    style={{
                      width: topItem?.quantity_sold
                        ? `${Math.max(6, (Number(row.quantity_sold) / Number(topItem.quantity_sold)) * 100)}px`
                        : "3px",
                    }}
                  />
                  {row.quantity_sold}
                </div>
              </td>
            </>
          )}
          empty="No popular items yet."
        />
      </div>

      {/* Demand Forecast */}
      <section className="panel forecast-panel">
        <div className="panel-head">
          <div>
            <h2>Demand Forecast</h2>
            <p className="muted small">
              7-day historical average with 20% preparation buffer.
            </p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Historical Demand</th>
                <th>Avg Daily Demand</th>
                <th>Forecast Qty</th>
                <th>Suggested Preparation</th>
              </tr>
            </thead>
            <tbody>
              {dash.forecast?.length ? (
                dash.forecast.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.historical_demand}</td>
                    <td>{row.average_daily_demand}</td>
                    <td>{row.forecast_quantity}</td>
                    <td>
                      <strong style={{ color: "var(--accent)" }}>
                        {row.suggested_preparation}
                      </strong>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="5">
                    <EmptyState
                      title="No forecast data"
                      text="Forecasts appear as order history is collected."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

/* ─── Wallet Analytics (aggregate only — no per-student finances) ─── */
function WalletAnalytics({ data }) {
  if (!data) return null;
  const cards = [
    { label: "Active Wallet Users", value: data.active_wallet_users },
    { label: "Total Credits Issued", value: currency(data.total_credits), cls: "ok" },
    { label: "Total Wallet Spending", value: currency(data.total_spending), cls: "accent" },
    { label: "Spending This Month", value: currency(data.spending_this_month) },
    { label: "Monthly Utilization", value: `${data.monthly_utilization_pct}%`, cls: data.monthly_utilization_pct > 80 ? "warn" : "" },
    { label: "Avg Student Spend (month)", value: currency(data.average_student_spend) },
    { label: "Unused Monthly Balance", value: currency(data.unused_monthly_balance) },
    { label: "Wallet Transactions", value: data.transaction_count },
  ];
  return (
    <section className="panel wallet-admin-panel">
      <div className="panel-head">
        <div>
          <h2>Campus Wallet Analytics</h2>
          <p className="muted small">
            Aggregate credit-system health. Individual balances stay private to students.
          </p>
        </div>
      </div>
      <div className="wallet-admin-grid">
        {cards.map(({ label, value, cls }) => (
          <div className={`kpi${cls ? ` ${cls}` : ""}`} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─── Data Table Helper ──────────────────────────────────── */
function DataTable({ title, rows, headers, cells, empty }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      {rows?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>{cells(row)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={title} text={empty} />
      )}
    </section>
  );
}

/* ─── Wallet Management (campus office) ───────────────────── */
function WalletManagement({ rows, onDone }) {
  const [form, setForm] = useState({ userId: "", amount: "", reason: TOPUP_REASONS[0], note: "" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.userId) return;
    setBusy(true);
    try {
      const result = await api("/api/admin/wallet/topup", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          userId: Number(form.userId),
          amount: Number(form.amount),
          reason: form.reason,
          note: form.note.trim(),
        }),
      });
      await onDone(
        `Credited ${currency(result.amount)} — new balance ${currency(result.balance)}.`,
      );
      setForm({ userId: "", amount: "", reason: TOPUP_REASONS[0], note: "" });
    } catch (err) {
      await onDone(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const confirmRow = confirming || null;
  if (confirmRow) {
    return (
      <Modal
        label={`Confirm top-up for ${confirmRow.name}`}
        onClose={() => setConfirming(null)}
      >
        <div className="topup-confirm">
          <h3>Confirm wallet top-up</h3>
          <p className="topup-summary">
            <strong>{currency(confirmRow.amount)}</strong> → {confirmRow.name} (
            {confirmRow.email})
          </p>
          <p className="topup-meta">
            Reason: {confirmRow.reason}
            {confirmRow.note ? ` — ${confirmRow.note}` : ""}
          </p>
          <p className="topup-meta">
            Recorded as an audited <code>ADJUSTMENT</code> credit in the student's
            transaction ledger. This cannot be hidden or undone.
          </p>
          <div className="wm-actions">
            <button className="btn btn-ghost" onClick={() => setConfirming(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api("/api/admin/wallet/topup", {
                    method: "POST",
                    headers: authHeaders(),
                    body: JSON.stringify({
                      userId: confirmRow.id,
                      amount: confirmRow.amount,
                      reason: confirmRow.reason,
                      note: confirmRow.note,
                    }),
                  });
                  setConfirming(null);
                  await onDone(
                    `Credited ${currency(result.amount)} — new balance ${currency(result.balance)}.`,
                  );
                } catch (err) {
                  setConfirming(null);
                  await onDone(err.message, "error");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Crediting…" : "Confirm credit"}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <section className="wallet-admin" aria-label="Student wallet management">
      <div className="panel-head">
        <h2>Student Wallets</h2>
        <span className="muted small">Balances · audited top-ups</span>
      </div>

      <form className="topup-form" onSubmit={submit}>
        <label>
          Student
          <select
            required
            value={form.userId}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
          >
            <option value="" disabled>
              Select student…
            </option>
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} ({row.email}) — {currency(row.balance)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (₹10–₹500)
          <input
            type="number"
            min="10"
            max="500"
            step="1"
            required
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="e.g. 100"
          />
        </label>
        <label>
          Reason
          <select
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          >
            {TOPUP_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>
        <label className="topup-note">
          Note (optional)
          <input
            type="text"
            maxLength={200}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="Shown in the student's ledger"
          />
        </label>
        <button className="btn btn-primary" disabled={busy || !form.userId}>
          {busy ? "Crediting…" : "Review top-up"}
        </button>
      </form>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Student</th>
              <th>Email</th>
              <th>Balance</th>
              <th>Spent This Month</th>
              <th>Allowance</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.balance <= 50 ? "row-low" : ""}>
                <td>{row.name}</td>
                <td>{row.email}</td>
                <td>
                  <strong className={row.balance <= 50 ? "low-balance" : ""}>
                    {currency(row.balance)}
                  </strong>
                </td>
                <td>{currency(row.spent_this_month)}</td>
                <td>{currency(row.monthly_allowance)}</td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setConfirming({
                        id: row.id,
                        name: row.name,
                        email: row.email,
                        amount: 100,
                        reason: TOPUP_REASONS[0],
                        note: "",
                      })
                    }
                    aria-label={`Quick top-up ₹100 for ${row.name}`}
                  >
                    + ₹100 quick
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <EmptyState
          title="No student wallets yet"
          text="Wallets are created automatically when students register."
        />
      )}
    </section>
  );
}
