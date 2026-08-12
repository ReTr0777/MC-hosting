'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, errorMessage } from '@/lib/api';

interface Options<T> {
  /** How often to re-fetch, in ms. Omit for a one-shot load. */
  intervalMs?: number;
  /** Set false to hold off fetching (e.g. the tab isn't open yet). */
  enabled?: boolean;
  /** Maps the raw response into the shape the component wants. */
  select?: (raw: any) => T;
}

interface Result<T> {
  data: T;
  /** True only during the very first load, so refreshes don't blank the UI. */
  loading: boolean;
  error: string | null;
  /** Re-fetches immediately; resolves once state has been updated. */
  refresh: () => Promise<void>;
}

/**
 * Fetches a URL and keeps it fresh on an interval.
 *
 * Handles the things the hand-rolled `setInterval` blocks in each panel were
 * getting wrong:
 *  - aborts the in-flight request on unmount or url change, so no state is set
 *    on an unmounted component
 *  - pauses while the tab is hidden and refreshes on return, instead of burning
 *    a request every few seconds against a background tab
 *  - skips a tick if the previous request is still running, so a slow node
 *    can't build up a queue of overlapping requests
 *  - surfaces failures as `error` rather than swallowing them
 */
export function usePolledResource<T>(url: string | null, initial: T, options: Options<T> = {}): Result<T> {
  const { intervalMs, enabled = true, select } = options;

  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Kept in refs so changing them never re-creates the fetch callback (and thus
  // never restarts the interval mid-flight).
  const selectRef = useRef(select);
  selectRef.current = select;

  const mountedRef = useRef(true);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inFlightRef.current?.abort();
    };
  }, []);

  const load = useCallback(async () => {
    if (!url || !enabled) return;

    // A refresh supersedes whatever is already running.
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;

    try {
      const raw = await apiRequest(url, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setData(selectRef.current ? selectRef.current(raw) : (raw as T));
      setError(null);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(errorMessage(err, 'Failed to load'));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
      if (inFlightRef.current === controller) inFlightRef.current = null;
    }
  }, [url, enabled]);

  useEffect(() => {
    if (!url || !enabled) {
      setLoading(false);
      return;
    }

    setLoading(true);
    load();

    if (!intervalMs) return;

    const tick = () => {
      // Nothing to see in a background tab, and mobile browsers throttle it anyway.
      if (typeof document !== 'undefined' && document.hidden) return;
      if (inFlightRef.current) return;
      load();
    };

    const id = setInterval(tick, intervalMs);

    // Catch up straight away when the user comes back to the tab.
    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [url, enabled, intervalMs, load]);

  return { data, loading, error, refresh: load };
}
