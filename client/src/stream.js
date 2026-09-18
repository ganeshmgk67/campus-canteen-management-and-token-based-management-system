import { useEffect, useRef } from 'react';

/**
 * Shared SSE hook for the canteen app.
 *
 * Contract (backend guarantees):
 *  - The stream carries ONLY metadata: { type, ...ids }. Never balances,
 *    amounts, or order contents. Protected data is fetched via authenticated
 *    API calls when an event arrives.
 *  - Known types: CONNECTED, STATUS_UPDATE, ORDER_UPDATE, MENU_UPDATE,
 *    WALLET_UPDATE.
 *
 * Behavior:
 *  - One EventSource per component (per sessionId), closed on unmount/logout.
 *  - Browser-native auto-reconnect (server sends retry: 3000).
 *  - Handlers are throttled per event type (2s) to prevent refetch storms
 *    when multiple events arrive in quick succession.
 */
export function useCanteenStream(handlers, sessionId) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    const source = new EventSource('/api/orders/stream');
    const lastFired = {};

    source.onopen = () => handlersRef.current.onStatus?.('live');
    source.onerror = () => handlersRef.current.onStatus?.('reconnecting');
    source.onmessage = event => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // malformed frame — ignore
      }
      const type = typeof data?.type === 'string' ? data.type : null;
      if (!type || type.length > 40) return;
      if (type === 'CONNECTED') {
        handlersRef.current.onStatus?.('live');
        return;
      }
      // Throttle per type: at most one dispatch per 2 seconds.
      const now = Date.now();
      if (lastFired[type] && now - lastFired[type] < 2000) return;
      lastFired[type] = now;
      handlersRef.current.onEvent?.(type, data);
    };

    return () => source.close();
  }, [sessionIdRef.current]); // re-subscribe only when the session changes (login/logout)
}

/**
 * Maps raw SSE event types to dataset-refresh signals with per-dataset
 * throttling, so pages decide what to reload without duplicating logic.
 */
export const STREAM_REFRESH_MAP = {
  STATUS_UPDATE: ['orders', 'dashboard'],
  ORDER_UPDATE: ['orders', 'dashboard', 'stock'],
  MENU_UPDATE: ['menu', 'stock', 'dashboard'],
  WALLET_UPDATE: ['wallet', 'dashboard']
};
