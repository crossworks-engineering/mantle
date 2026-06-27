'use client';

import { useEffect, useState } from 'react';
import { apiEventStream } from '@/lib/api-fetch';
import { isTurnStreamingEnabledClient } from '@/lib/turn-streaming';
import type { TurnEvent } from '@mantle/client-types';

/** One grounded step in a turn's thought trail (a `status` event, kept). */
export interface ThoughtEvent {
  /** Coarse bucket for the icon/theme (thinking | web | brain | delegate | tool). */
  kind: string;
  /** The user-facing line ("Searching your brain for “Pinnacle”…"). */
  label: string;
}

export interface TurnStream {
  /** Latest status label — for the live typing line. Null before any event. */
  label: string | null;
  /** Ordered, consecutive-deduped trail of status steps seen this turn. Becomes
   *  the persistent "thought" record attached to the reply. */
  trail: ThoughtEvent[];
}

/**
 * Subscribe to one in-flight turn's live status and accumulate it into a trail.
 *
 * The client mints the turn's id (the submit's uuid) and passes it here while
 * the turn runs; the SSE stream pushes `status` events the instant each step
 * starts. We keep the whole ordered sequence (not just the latest) so the caller
 * can both show the live line AND freeze the trail onto the finished reply as a
 * record. No-op (empty) when streaming is disabled or `turnId` is null, leaving
 * the poll fallback in charge.
 */
export function useTurnStream(turnId: string | null): TurnStream {
  const [trail, setTrail] = useState<ThoughtEvent[]>([]);

  useEffect(() => {
    if (!turnId || !isTurnStreamingEnabledClient()) {
      setTrail([]);
      return;
    }
    let stopped = false;
    const stop = apiEventStream(
      `/api/assistant/turn/${turnId}/stream`,
      (data) => {
        if (stopped) return;
        try {
          const ev = JSON.parse(data) as TurnEvent;
          if (ev && ev.type === 'status' && typeof ev.data?.label === 'string') {
            const next: ThoughtEvent = { kind: ev.data.kind ?? 'tool', label: ev.data.label };
            setTrail((prev) => {
              // Collapse consecutive duplicates (e.g. Thinking… → Thinking…).
              const last = prev[prev.length - 1];
              if (last && last.label === next.label) return prev;
              return [...prev, next];
            });
          }
        } catch {
          /* malformed frame — ignore, keep the trail */
        }
      },
      { onError: () => {} },
    );

    return () => {
      stopped = true;
      stop();
      setTrail([]);
    };
  }, [turnId]);

  return { label: trail.length ? trail[trail.length - 1]!.label : null, trail };
}
