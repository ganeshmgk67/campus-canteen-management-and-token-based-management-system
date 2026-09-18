import React, { useEffect, useRef } from 'react';

export function Loading({ label }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

/**
 * Accessible modal wrapper: focus trap, Escape-to-close, focus restore,
 * background scroll lock.
 */
export function Modal({ label, onClose, children, closeOnEscape = true }) {
  const cardRef = useRef(null);
  const openerRef = useRef(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const card = cardRef.current;
    const focusables = () => (card
      ? Array.from(
          card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ).filter(el => !el.disabled)
      : []);
    focusables()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = event => {
      if (event.key === 'Escape' && closeOnEscape) { onClose(); return; }
      if (event.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        const firstEl = list[0];
        const lastEl = list[list.length - 1];
        if (event.shiftKey && document.activeElement === firstEl) { event.preventDefault(); lastEl.focus(); }
        else if (!event.shiftKey && document.activeElement === lastEl) { event.preventDefault(); firstEl.focus(); }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus?.();
    };
  }, [onClose, closeOnEscape]);

  return (
    <div
      className="modal"
      onMouseDown={event => { if (event.target === event.currentTarget && closeOnEscape) onClose(); }}
    >
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
