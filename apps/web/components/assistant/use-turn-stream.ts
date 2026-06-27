'use client';

import { useEffect, useRef, useState } from 'react';
import { apiEventStream } from '@/lib/api-fetch';
import { isTurnStreamingEnabledClient } from '@/lib/turn-streaming';
import type { TurnEvent } from '@mantle/client-types';

/** One step in a turn's thought trail (a `status` event, kept). */
export interface ThoughtEvent {
  /** Stable step id — lets a later narrated event replace this line in place. */
  stepId?: string;
  /** Coarse bucket for the icon/theme (thinking | web | brain | delegate | tool). */
  kind: string;
  /** The user-facing line ("Let me dig through your notes on cars…"). */
  label: string;
}

export interface TurnStream {
  /** Latest status label — for the live typing line. Null before any event. */
  label: string | null;
  /** Ordered, consecutive-deduped trail of status steps seen this turn. Becomes
   *  the persistent "thought" record attached to the reply. */
  trail: ThoughtEvent[];
  /** Accumulated visible reply text from `text-delta` events (the LATEST tool-loop
   *  round — a new round resets the buffer, so tool-then-answer turns show only the
   *  final answer typing out). Empty until the model emits text. Advisory: the
   *  durable reply reconciles it on completion. */
  reply: string;
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
  const [reply, setReply] = useState('');
  // Ref accumulator for the reply so appends are deterministic (the setState
  // updater stays a pure set-to-same-string, safe under StrictMode double-invoke).
  const replyRef = useRef('');
  const replyRoundRef = useRef(-1);

  useEffect(() => {
    if (!turnId || !isTurnStreamingEnabledClient()) {
      setTrail([]);
      setReply('');
      replyRef.current = '';
      replyRoundRef.current = -1;
      return;
    }
    replyRef.current = '';
    replyRoundRef.current = -1;
    let stopped = false;
    const stop = apiEventStream(
      `/api/assistant/turn/${turnId}/stream`,
      (data) => {
        if (stopped) return;
        try {
          const ev = JSON.parse(data) as TurnEvent;
          if (ev && ev.type === 'text-delta' && typeof ev.data?.text === 'string') {
            const round = typeof ev.round === 'number' ? ev.round : 0;
            if (round > replyRoundRef.current) {
              // A fresh round (e.g. the final answer after tool calls) — replace
              // the buffer so intermediate-round text isn't shown beneath it.
              replyRoundRef.current = round;
              replyRef.current = ev.data.text;
            } else {
              replyRef.current += ev.data.text;
            }
            setReply(replyRef.current);
            return;
          }
          if (ev && ev.type === 'status' && typeof ev.data?.label === 'string') {
            const stepId = ev.data.stepId;
            const incoming: ThoughtEvent = { stepId, kind: ev.data.kind ?? 'tool', label: ev.data.label };
            setTrail((prev) => {
              // Upgrade in place: a later narrated event for the same step
              // replaces the grounded line rather than appending a duplicate.
              if (stepId) {
                const i = prev.findIndex((t) => t.stepId === stepId);
                if (i >= 0) {
                  if (prev[i]!.label === incoming.label) return prev;
                  const copy = prev.slice();
                  copy[i] = { ...copy[i]!, label: incoming.label, kind: incoming.kind };
                  return copy;
                }
              }
              // Append, collapsing a consecutive duplicate label (Thinking… ×3).
              const last = prev[prev.length - 1];
              if (last && last.label === incoming.label) return prev;
              return [...prev, incoming];
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
      setReply('');
      replyRef.current = '';
      replyRoundRef.current = -1;
    };
  }, [turnId]);

  return { label: trail.length ? trail[trail.length - 1]!.label : null, trail, reply };
}
