'use client';

import { useEffect, useState } from 'react';
import { apiEventStream } from '@/lib/api-fetch';
import { isTurnStreamingEnabledClient } from '@/lib/turn-streaming';
import type { TurnEvent } from '@mantle/client-types';

/**
 * Subscribe to the live status of one in-flight turn and return the latest
 * status label ("Searching your brain for …"), or null.
 *
 * The client mints the turn's id (the submit's uuid) and passes it here while
 * the turn is in flight; the SSE stream pushes `status` events the moment each
 * step starts — instant, vs the ~900ms poll. No-op (returns null) when streaming
 * is disabled or `turnId` is null, so the caller's poll fallback (`useTurnStage`)
 * stays in charge while the feature is dark.
 *
 * Best-effort: a dropped connection auto-reconnects (apiEventStream), and any
 * gap is covered by the durable reply on the POST's return. We read only
 * `status` here; richer event types arrive in later phases.
 */
export function useTurnStreamStatus(turnId: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!turnId || !isTurnStreamingEnabledClient()) {
      setLabel(null);
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
            setLabel(ev.data.label);
          }
        } catch {
          /* malformed frame — ignore, keep the last label */
        }
      },
      { onError: () => {} },
    );

    return () => {
      stopped = true;
      stop();
      setLabel(null);
    };
  }, [turnId]);

  return label;
}
