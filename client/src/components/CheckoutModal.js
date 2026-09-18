import React, { useEffect, useState } from 'react';
import { api, authHeaders, currency, time } from '../api';
import { Modal, Loading } from './ui';

/**
 * Wallet checkout modal — replaces the old simulated payment flow.
 * Shows order total vs live wallet balance with remaining/shortfall math.
 * The server remains authoritative: it re-prices and re-checks the balance.
 */
export default function CheckoutModal({ summary, cart, close, onSuccess, refresh, onRefreshMenu }) {
  const [wallet, setWallet] = useState(null);
  const [walletError, setWalletError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Fetch the balance fresh when the modal opens — never trust stale state.
  useEffect(() => {
    let active = true;
    api('/api/wallet', { headers: authHeaders() })
      .then(data => { if (active) setWallet(data); })
      .catch(err => { if (active) setWalletError(err.message); });
    return () => { active = false; };
  }, []);

  const total = Number(summary.total_amount);
  const balance = wallet ? Number(wallet.balance) : null;
  const remaining = balance != null ? (balance - total).toFixed(2) : null;
  const shortfall = balance != null ? Math.max(0, total - balance).toFixed(2) : null;
  const insufficient = balance != null && balance < total;

  const confirm = async () => {
    setError('');
    setNotice('');
    setConfirming(true);
    try {
      const order = await api('/api/orders/checkout', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ cart })
      });
      await refresh();
      onSuccess(order);
    } catch (err) {
      setError(err.message);
      await refresh();
      // Stock may have changed while the modal was open — revalidate the menu.
      if (!/Insufficient wallet balance/.test(err.message) && onRefreshMenu) {
        setNotice('Stock may have changed — your cart was re-validated against the menu.');
        onRefreshMenu();
      }
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Modal label="Confirm wallet payment" onClose={close}>
      <div className="modal-head">
        <div>
          <div className="eyebrow">Wallet Payment</div>
          <h2>Confirm Order</h2>
        </div>
        <button className="dismiss btn btn-ghost" onClick={close} aria-label="Close">×</button>
      </div>

      <div className="payment-lines">
        {summary.items.map(item => (
          <div className="line" key={item.id}>
            <span>{item.name} × {item.quantity}</span>
            <strong>{currency(item.line_total)}</strong>
          </div>
        ))}
      </div>
      <div className="payment-total">
        <span className="label">Order Total</span>
        <span className="amount">{currency(summary.total_amount)}</span>
      </div>

      <div className="wallet-checkout-box">
        {walletError && (
          <div className="error-box" role="alert">
            <span>⚠</span><span>Could not load your wallet: {walletError}</span>
          </div>
        )}
        {!wallet && !walletError && <Loading label="Checking wallet balance…" />}
        {wallet && (
          <div className="wallet-math">
            <div className="wm-row">
              <span className="wm-label">Wallet Balance</span>
              <span className="wm-value">{currency(balance)}</span>
            </div>
            <div className="wm-row">
              <span className="wm-label">Order Total</span>
              <span className="wm-value">{currency(total)}</span>
            </div>
            {insufficient ? (
              <div className="wm-row warn">
                <span className="wm-label">Required Additional Balance</span>
                <span className="wm-value">{currency(shortfall)}</span>
              </div>
            ) : (
              <div className="wm-row ok">
                <span className="wm-label">Remaining After Order</span>
                <span className="wm-value">{currency(remaining)}</span>
              </div>
            )}
            <div className={`wm-status ${insufficient ? 'insufficient' : 'sufficient'}`} role="status">
              {insufficient ? 'Insufficient Balance' : 'Payment method: Student Wallet'}
            </div>
          </div>
        )}
      </div>

      {summary.estimated_pickup && (
        <p className="pickup-note">
          <span>🕐</span>
          Estimated pickup: <strong>{time(summary.estimated_pickup)}</strong>
        </p>
      )}

      {error && (
        <div className="error-box" role="alert">
          <span>⚠</span><span>{error}</span>
        </div>
      )}
      {notice && <div className="notice-box" role="status"><span>✓ {notice}</span></div>}

      <div className="action-row">
        <button
          className="btn btn-walnut full btn-lg"
          disabled={confirming || !wallet || insufficient || Boolean(walletError)}
          onClick={confirm}
        >
          {confirming
            ? <><span className="spinner" />Processing payment…</>
            : insufficient
              ? 'Insufficient Balance'
              : `Pay ${currency(total)} from Wallet`}
        </button>
        <button className="btn btn-outline full" onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}
