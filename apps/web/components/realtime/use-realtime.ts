'use client';

import { useEffect, useRef } from 'react';
import { apiEventStream } from '@/lib/api-fetch';

/**
 * Subscribe to live node changes over SSE (/api/realtime). Calls `onChange`
 * whenever a node of one of the given `types` is created/ingested for the
 * current owner — e.g. `useRealtime(['event'], () => router.refresh())` makes a
 * server-rendered screen repaint the moment the data changes, no manual refresh.
 *
 * Uses `apiEventStream` (not raw `EventSource`) so a detached/Electron client can
 * carry the base-URL + bearer — `EventSource` can do neither. It auto-reconnects
 * with backoff, so transient drops self-heal; the connection closes on unmount.
 */
export type RealtimeChange = { type: string; id: string };

export function useRealtime(types: string[], onChange: (c: RealtimeChange) => void): void {
  // Keep the latest callback without re-opening the stream each render.
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  const key = types.join(',');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const qs = key ? `?types=${encodeURIComponent(key)}` : '';
    return apiEventStream(`/api/realtime${qs}`, (data) => {
      try {
        cbRef.current(JSON.parse(data) as RealtimeChange);
      } catch {
        /* ignore malformed frame */
      }
    });
  }, [key]);
}
