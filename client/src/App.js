import React, { createContext, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, Link, useLocation } from 'react-router-dom';
import Auth from './pages/Auth';
import Student from './pages/Student';
import Admin from './pages/Admin';
import { api, authHeaders } from './api';

export const AuthContext = createContext(null);

function NavLink({ to, children }) {
  const location = useLocation();
  const active = location.pathname.startsWith(to);
  return (
    <Link className={`${active ? 'active' : ''}`} to={to}>{children}</Link>
  );
}

function Shell({ children }) {
  const { user, logout } = React.useContext(AuthContext);
  return (
    <>
      <header className="topbar">
        <Link className="brand" to={user ? (user.role === 'admin' ? '/admin' : '/student') : '/'}>
          Campus Canteen
          <span className="brand-sub">Heritage · Est. 1985</span>
        </Link>
        {user && (
          <div className="topbar-right">
            {user.role === 'student' && (
              <nav className="student-nav">
                <NavLink to="/student/menu">Menu</NavLink>
                <NavLink to="/student/orders">My Orders</NavLink>
                <NavLink to="/student/wallet">Wallet</NavLink>
              </nav>
            )}
            {user.role === 'admin' && (
              <span className="role-label">Admin Panel</span>
            )}
            <span className="role-label">{user.name}</span>
            <button className="btn btn-outline btn-sm" onClick={logout}>Logout</button>
          </div>
        )}
      </header>
      {children}
    </>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  const auth = useMemo(() => ({
    user,
    login: async data => {
      localStorage.removeItem('user');
      localStorage.setItem('token', data.token);
      try {
        const profile = await api('/api/auth/me', { headers: authHeaders() });
        setUser(profile);
      } catch (error) {
        localStorage.removeItem('token');
        throw error;
      }
    },
    logout: () => {
      localStorage.removeItem('user');
      localStorage.removeItem('token');
      setUser(null);
    }
  }), [user]);

  useEffect(() => {
    let active = true;
    localStorage.removeItem('user');
    const token = localStorage.getItem('token');
    if (!token) { setCheckingSession(false); return undefined; }
    api('/api/auth/me', { headers: authHeaders() })
      .then(profile => { if (active) setUser(profile); })
      .catch(() => { localStorage.removeItem('token'); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => auth.logout();
    window.addEventListener('canteen:unauthorized', onUnauthorized);
    return () => window.removeEventListener('canteen:unauthorized', onUnauthorized);
  }, [auth]);

  if (checkingSession) {
    return (
      <div className="loading app-loading">
        <span className="spinner" />
        Checking your session…
      </div>
    );
  }

  return (
    <AuthContext.Provider value={auth}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={user ? <Navigate to={user.role === 'admin' ? '/admin' : '/student/menu'} replace /> : <Auth />} />
            <Route path="/student/*" element={user?.role === 'student' ? <Student /> : <Navigate to="/" replace />} />
            <Route path="/admin/*" element={user?.role === 'admin' ? <Admin /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthContext.Provider>
  );
}
