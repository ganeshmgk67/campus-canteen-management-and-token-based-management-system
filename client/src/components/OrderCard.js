import React from 'react';
import { Link } from 'react-router-dom';
import { currency, time } from '../api';

export function OrderCard({ order, history = false }) {
  return (
    <article className="order-card">
      <div className="order-card-head">
        <div className="order-token-group">
          <span className="order-token">{order.token}</span>
          <span className={`status ${order.status.toLowerCase()}`}>{order.status}</span>
        </div>
        <span className="order-amount">{currency(order.total_amount)}</span>
      </div>
      <div className="order-summary">
        {order.item_summary || 'Order items'} · {order.total_quantity} item{order.total_quantity !== 1 ? 's' : ''}
      </div>
      <div className="order-meta">
        <span>Order #{order.id}</span>
        <span>
          {time(order.created_at)}
          {!history && order.estimated_pickup && ` · Pickup ${time(order.estimated_pickup)}`}
        </span>
      </div>
      {!history && (
        <div className="order-queue">
          <span>Queue position: <strong>{order.queue_position ? `#${order.queue_position}` : '—'}</strong></span>
          <span>Orders ahead: <strong>{order.orders_ahead ?? '—'}</strong></span>
          <Link className="btn btn-outline btn-sm" to={`/student/token/${order.token}`}>
            View Live →
          </Link>
        </div>
      )}
    </article>
  );
}
