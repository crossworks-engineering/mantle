'use client';

import { useEffect, useState } from 'react';

/**
 * Ticking clock for live countdowns / relative times. Returns `0` on the server
 * and the first client render (so SSR and hydration match — no mismatch), then
 * the real `Date.now()` after mount, updating every `intervalMs`. Callers should
 * treat `0` as "not mounted yet" and render a static fallback.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
