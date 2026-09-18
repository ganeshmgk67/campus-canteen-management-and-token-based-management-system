import React, { useCallback, useEffect, useState } from 'react';
import { api, authHeaders, currency } from '../api';
import { useCanteenStream, STREAM_REFRESH_MAP } from '../stream';
import { Loading, EmptyState } from '../components/ui';

/**
 * Student Campus Wallet: balance hero, spending insights, transaction ledger.
 * All money data comes from the authenticated API — never from client state.
 */
export default function WalletPage() {
  const [wallet, setWallet] = useState(null);
  const [insights, setInsights] = useState(null);
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [w, i, h] = await Promise.all([
        api('/api/wallet', { headers: authHeaders() }),
        api('/api/wallet/insights', { headers: authHeaders() }),
        api('/api/wallet/transactions?limit=25', { headers: authHeaders() })
      ]);
      setWallet(w);
      setInsights(i);
      setHistory(h);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useCanteenStream({
    onStatus: () => {},
    onEvent: type => {
      if (STREAM_REFRESH_MAP[type]?.includes('wallet')) load();
    }
  });

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <main className="page center"><Loading label="Loading your wallet…" /></main>;
  }

  const usage = wallet
    ? Math.min(100, Math.round((wallet.spent_this_month / (wallet.monthly_allowance || 1)) * 100))
    : 0;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Campus Wallet</div>
          <h1>My Wallet</h1>
          <p className="page-subtitle">Balance, monthly allowance and every rupee tracked.</p>
        </div>
        {wallet && <span className="section-count">{wallet.period}</span>}
      </div>

      {error && (
        <div className="error-box" role="alert">
          <span>⚠</span><span>{error}</span>
        </div>
      )}

      {wallet && (
        <>
          <section className="wallet-hero" aria-label="Wallet balance summary">
            <div className="wallet-hero-main">
              <span className="eyebrow">Available Balance</span>
              <div className="wallet-balance">{currency(wallet.balance)}</div>
              <div className="wallet-hero-meta">
                Monthly credit {currency(wallet.monthly_credit)} · Next reset{' '}
                {wallet.next_reset ? new Date(wallet.next_reset).toLocaleDateString() : '—'}
              </div>
            </div>
            <div className="wallet-hero-side">
              <div>
                <span className="eyebrow">Spent This Month</span>
                <div className="wallet-hero-number">{currency(wallet.spent_this_month)}</div>
              </div>
              <div>
                <span className="eyebrow">Monthly Allowance</span>
                <div className="wallet-hero-number">{currency(wallet.monthly_allowance)}</div>
              </div>
            </div>
            <div
              className="wallet-usage-bar"
              role="progressbar"
              aria-valuenow={usage}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="Monthly allowance used"
            >
              <div className={`wallet-usage-fill ${usage > 80 ? 'high' : ''}`} style={{ width: `${usage}%` }} />
            </div>
          </section>

          {insights?.budget_warning && (
            <div className="wallet-warning" role="alert">
              <span>⚠</span>
              <span>{insights.budget_warning}</span>
            </div>
          )}

          <p className="wallet-note">
            Your wallet is credited {currency(wallet.monthly_allowance)} automatically on the 1st of
            every month. Running low before month-end? Campus office staff can issue an audited
            top-up to your wallet — every credit is recorded in your transaction history.
          </p>

          <section className="wallet-panel">
            <div className="panel-head">
              <h2>Spending Insights</h2>
              <span className="muted small">Deterministic — computed from your ledger</span>
            </div>
            <div className="wallet-insight-grid">
              <div className="insight-card">
                <span className="i-label">Daily burn rate</span>
                <span className="i-value">{currency(insights?.daily_burn_rate)}</span>
              </div>
              <div className="insight-card">
                <span className="i-label">Projected month-end spend</span>
                <span className="i-value">{currency(insights?.projected_month_end_spend)}</span>
              </div>
              <div className="insight-card">
                <span className="i-label">Days until balance runs out</span>
                <span className="i-value">
                  {insights?.days_until_runout == null ? '—' : `${insights.days_until_runout} days`}
                </span>
              </div>
              <div className="insight-card">
                <span className="i-label">Top item this month</span>
                <span className="i-value">
                  {insights?.top_items?.[0]
                    ? `${insights.top_items[0].name} × ${insights.top_items[0].quantity}`
                    : '—'}
                </span>
              </div>
            </div>

            {insights?.by_category?.length > 0 && (
              <div className="wallet-category-bars">
                {insights.by_category.map(row => {
                  const maxSpent = Math.max(...insights.by_category.map(r => r.spent));
                  return (
                    <div className="wcb-row" key={row.category}>
                      <span className="wcb-label">{row.category}</span>
                      <div className="wcb-bar-bg">
                        <div className="wcb-bar-fill" style={{ width: `${Math.max(3, (row.spent / maxSpent) * 100)}%` }} />
                      </div>
                      <span className="wcb-amount">{currency(row.spent)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="wallet-panel">
            <div className="panel-head">
              <h2>Recent Transactions</h2>
              <span className="muted small">{history?.total ?? 0} total records</span>
            </div>
            {history?.transactions?.length ? (
              <div className="wallet-tx-list">
                {history.transactions.map(tx => (
                  <div className="wallet-tx" key={tx.id}>
                    <div className={`wallet-tx-icon ${tx.type.toLowerCase()}`} aria-hidden="true">
                      {tx.type === 'CREDIT' ? '↓' : '↑'}
                    </div>
                    <div className="wallet-tx-info">
                      <strong>{tx.description}</strong>
                      <span>
                        {new Date(tx.created_at).toLocaleString()} · {tx.reference_type.replace('_', ' ').toLowerCase()}
                      </span>
                    </div>
                    <div className={`wallet-tx-amount ${tx.type.toLowerCase()}`}>
                      {tx.type === 'CREDIT' ? '+' : '−'}{currency(tx.amount)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No transactions yet"
                text="Your ₹500 monthly credit and wallet purchases will appear here."
              />
            )}
          </section>
        </>
      )}
    </main>
  );
}
