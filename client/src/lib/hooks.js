import { useCallback, useEffect, useRef, useState } from 'react';
import { flushQueue, queuedCount } from './api.js';

/**
 * One hook for every read. Returns the four states a network view
 * actually has: loading, error, empty and loaded.
 *
 * Designing for all four is not a nicety here. On an unreliable
 * connection the error and empty states are seen constantly, and a view
 * that only handles the happy path shows a blank screen instead of
 * telling the participant what to do.
 */
export function useResource(loader, deps = []) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async () => {
    setState((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading' }));
    try {
      const data = await loader();
      if (mounted.current) setState({ status: 'loaded', data, error: null });
    } catch (error) {
      if (mounted.current) setState((current) => ({ status: 'error', data: current.data, error }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { run(); }, [run]);

  return { ...state, reload: run };
}

/**
 * Connection awareness.
 *
 * navigator.onLine only reports whether the device has a network
 * interface, not whether it can reach anything, so it is treated as a
 * hint. The Network Information API, where available, tells us the
 * effective connection type, which is what drives the low-bandwidth
 * affordances: on 2G we stop auto-loading heavy content and ask first.
 */
export function useConnection() {
  const [state, setState] = useState(() => readConnection());

  useEffect(() => {
    const update = () => setState(readConnection());

    window.addEventListener('online', update);
    window.addEventListener('offline', update);

    const connection = navigator.connection;
    connection?.addEventListener?.('change', update);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      connection?.removeEventListener?.('change', update);
    };
  }, []);

  return state;
}

function readConnection() {
  const connection = typeof navigator !== 'undefined' ? navigator.connection : null;
  const effectiveType = connection?.effectiveType ?? null;
  return {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    effectiveType,
    slow: effectiveType === 'slow-2g' || effectiveType === '2g',
    saveData: Boolean(connection?.saveData)
  };
}

/** Number of writes waiting to be replayed, polled cheaply. */
export function usePendingWrites() {
  const [count, setCount] = useState(() => queuedCount());

  useEffect(() => {
    const tick = () => setCount(queuedCount());
    const timer = setInterval(tick, 3000);
    const onOnline = async () => {
      await flushQueue();
      tick();
    };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return count;
}
