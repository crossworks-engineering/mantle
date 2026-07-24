'use client';

import { useEffect, useRef } from 'react';
import { apiEventStream } from '@mantle/web-ui/api-fetch';

export type RealtimeChange = { type: string; id: string };

/**
 * All `useRealtime()` consumers share ONE `/api/realtime` connection per tab —
 * a module-level singleton that fans out to every subscriber and filters by
 * type client-side. Per-hook connections exhausted the browser's HTTP/1.1
 * ~6-per-origin pool: ~4 held-open SSE sockets app-wide (sidebar pending badge,
 * pending-question sync, runs strip, a list screen) left ordinary `fetch`es
 * starving intermittently — the tables "spinner-forever" over the plain-`http://`
 * workstation dev path (prod negotiates HTTP/2, which multiplexes, so it was
 * dev-only). Collapsing to one socket removes the pressure and makes the
 * duplicate `pending_tool_call` subscription harmless (two subscribers, one
 * stream).
 *
 * The server route's `?types=` filter is only a bandwidth nicety — an unfiltered
 * stream is already owner-scoped — so the per-consumer type filter moved here.
 * Reconnect/backoff/auth-bounce all still come from `apiEventStream` unchanged.
 */
type Subscriber = { types: string[] | null; cb: (c: RealtimeChange) => void };

const subscribers = new Map<number, Subscriber>();
let nextId = 1;
let stopStream: (() => void) | null = null;
let linger: ReturnType<typeof setTimeout> | null = null;

/** Open the shared stream if it isn't already running. */
function ensureStream(): void {
  if (stopStream) return;
  stopStream = apiEventStream('/api/realtime', (data) => {
    let change: RealtimeChange;
    try {
      change = JSON.parse(data) as RealtimeChange;
    } catch {
      return; // ignore malformed frame
    }
    for (const sub of subscribers.values()) {
      if (sub.types && !sub.types.includes(change.type)) continue;
      try {
        sub.cb(change);
      } catch {
        /* one consumer's bug must not break the fan-out to the others */
      }
    }
  });
}

/** Register a subscriber against the shared stream; returns an unsubscribe fn. */
function subscribe(sub: Subscriber): () => void {
  const id = nextId++;
  subscribers.set(id, sub);
  if (linger) {
    clearTimeout(linger);
    linger = null;
  }
  ensureStream();
  return () => {
    subscribers.delete(id);
    if (subscribers.size > 0) return;
    // Linger before closing so a route transition (last subscriber unmounts,
    // next mounts a frame later) and StrictMode's mount→unmount→mount don't
    // churn the underlying connection.
    linger = setTimeout(() => {
      linger = null;
      if (subscribers.size === 0) {
        stopStream?.();
        stopStream = null;
      }
    }, 5_000);
  };
}

/**
 * Subscribe to live node changes over SSE (/api/realtime). Calls `onChange`
 * whenever a node of one of the given `types` is created/ingested for the
 * current owner — e.g. `useRealtime(['event'], () => router.refresh())` makes a
 * server-rendered screen repaint the moment the data changes, no manual refresh.
 * An empty `types` array subscribes to every type.
 *
 * Backed by a single shared connection per tab (see the module comment above),
 * itself built on `apiEventStream` (not raw `EventSource`) so a detached/Electron
 * client can carry the base-URL + bearer — `EventSource` can do neither. It
 * auto-reconnects with exponential backoff + jitter, so transient drops
 * self-heal; the connection closes once the last subscriber unmounts.
 *
 * **Best-effort by design — NOT guaranteed delivery.** The server side is a
 * Postgres LISTEN/NOTIFY bridge (ephemeral pub/sub, no replayable backlog), so
 * there's no `Last-Event-ID` resumption: a change that fires *during* a
 * reconnect gap is missed. This is a "ping to refetch" trigger, not a data
 * channel — the next change re-pings and the screen catches up, so a stale row
 * self-heals on the following event. For a screen that must not miss the gap,
 * pair this with a periodic `refetchInterval` on its query as a safety net.
 */
export function useRealtime(types: string[], onChange: (c: RealtimeChange) => void): void {
  // Keep the latest callback without re-registering the subscriber each render.
  const cbRef = useRef(onChange);
  cbRef.current = onChange;

  const key = types.join(',');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const filter = key ? key.split(',') : null; // '' ⇒ all types, as before
    return subscribe({ types: filter, cb: (c) => cbRef.current(c) });
  }, [key]);
}
