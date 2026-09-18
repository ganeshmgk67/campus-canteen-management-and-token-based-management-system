import React, { useContext, useState } from 'react';
import { AuthContext } from '../App';
import { api } from '../api';

export default function Auth() {
  const { login } = useContext(AuthContext);
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const update = key => event => setForm(current => ({ ...current, [key]: event.target.value }));

  const submit = async event => {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const data = await api(
        mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        { method: 'POST', body: JSON.stringify(form) }
      );
      if (mode === 'login') {
        await login(data);
      } else {
        setNotice(data.message || 'Registration successful. Please sign in.');
        setMode('login');
        setForm({ name: '', email: form.email, password: '' });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setError('');
    setNotice('');
    setMode(mode === 'login' ? 'register' : 'login');
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="eyebrow">Campus Operations</div>
        <h1>{mode === 'login' ? 'Welcome Back.' : 'Join the Queue.'}</h1>
        <p className="muted small" style={{ marginTop: 6, fontFamily: "'Lora', serif", fontStyle: 'italic' }}>
          {mode === 'login'
            ? 'Sign in to pre-order and skip the queue.'
            : 'Create your student account to start ordering.'}
        </p>
        <div className="auth-divider" />

        {error && (
          <div className="error-box" role="alert">
            <span>⚠</span>
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div className="notice-box" role="status">
            <span>✓ {notice}</span>
          </div>
        )}

        <form onSubmit={submit} className="stack">
          {mode === 'register' && (
            <div>
              <label className="form-label" htmlFor="auth-name">Full Name</label>
              <input
                id="auth-name"
                className="input"
                placeholder="Your full name"
                value={form.name}
                onChange={update('name')}
                maxLength="100"
                required
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label className="form-label" htmlFor="auth-email">Email Address</label>
            <input
              id="auth-email"
              className="input"
              type="email"
              placeholder="you@campus.edu"
              value={form.email}
              onChange={update('email')}
              required
              autoComplete="email"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              placeholder={mode === 'login' ? 'Your password' : '6–72 characters'}
              minLength="6"
              maxLength="72"
              value={form.password}
              onChange={update('password')}
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>
          <button className="btn btn-walnut full btn-lg" disabled={busy} style={{ marginTop: 4 }}>
            {busy
              ? <><span className="spinner" style={{ borderTopColor: '#c9a84c' }} /> Please wait…</>
              : mode === 'login' ? 'Sign In →' : 'Create Account →'}
          </button>
        </form>

        <button className="link-btn" onClick={switchMode}>
          {mode === 'login'
            ? 'New student? Register for free'
            : 'Already have an account? Sign in'}
        </button>
      </section>
    </main>
  );
}
