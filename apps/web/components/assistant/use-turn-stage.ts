'use client';

import { useEffect, useState } from 'react';

/**
 * Poll the assistant's current stage label while a turn is in flight.
 *
 * `active` should be the chat's pending flag. While active, we poll
 * GET /api/assistant/turn/stage on a self-scheduling timer (~900ms; no
 * overlap) and return the latest label ("Thinking…", "Searching the web…", …)
 * for display next to the typing dots. Returns null when idle or between
 * recognisable stages — the caller falls back to plain dots.
 */
export function useTurnStage(active: boolean): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLabel(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch('/api/assistant/turn/stage', { cache: 'no-store' });
        if (!cancelled && res.ok) {
          const data = (await res.json()) as { label?: string | null };
          setLabel(data.label ?? null);
        }
      } catch {
        // Network blip — keep the last label and try again next tick.
      }
      if (!cancelled) timer = setTimeout(poll, 900);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  return label;
}
