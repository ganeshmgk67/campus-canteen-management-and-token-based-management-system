import React from 'react';
import { currency, time } from '../api';

/**
 * Digital token pass — the "PAID" chip now reflects the Student Wallet payment.
 */
export default function TokenPass({ order }) {
  const statusChipClass = order.status === 'Ready' ? 'ready' : order.status === 'Collected' ? 'collected' : '';
  return (
    <section className="token-pass" aria-label="Digital token pass">
      <div className="pass-top">
        <span className="pass-brand">Campus Canteen</span>
        <span className={`pass-chip ${statusChipClass}`}>PAID · STUDENT WALLET</span>
      </div>

      <div className="token-number">{order.token}</div>

      <div className="pass-divider">
        <span className="pass-divider-icon">✦</span>
      </div>

      <div className="token-grid">
        <div>
          <span className="token-label">Order ID</span>
          <span className="token-value">#{order.id}</span>
        </div>
        <div>
          <span className="token-label">Status</span>
          <span className="token-value">{order.status}</span>
        </div>
        <div>
          <span className="token-label">Est. Pickup</span>
          <span className="token-value">{time(order.estimated_pickup)}</span>
        </div>
        <div>
          <span className="token-label">Amount</span>
          <span className="token-value">{currency(order.total_amount)}</span>
        </div>
      </div>
    </section>
  );
}
