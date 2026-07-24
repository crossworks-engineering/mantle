'use client';

import { useEffect, useRef, useState } from 'react';
import { apiEventStream } from '@mantle/web-ui/api-fetch';
import { isTurnStreamingEnabledClient } from '@/lib/turn-streaming';
import type { TurnEvent } from '@mantle/client-types';

/** One step in a turn's thought trail (a `status` event, kept). */
export interface ThoughtEvent {
  /** Stable step id — lets a later narrated event replace this line in place. */
  stepId?: string;
  /** Coarse bucket for the icon/theme (thinking | web | brain | delegate | tool …). */
  kind: string;
  /** The user-facing line ("Let me dig through your notes on cars…"). */
  label: string;
  /** Elapsed ms into the turn when this step started (client-stamped on arrival).
   *  Shown beside the step so the user can follow the flow's timing. Preserved
   *  across a grounded→narrated upgrade (the step's start time doesn't change). */
  elapsedMs?: number;
}

/** Lifecycle of the subscribed turn, driven by the terminal bus events. */
export type TurnPhase = 'idle' | 'streaming' | 'done' | 'error';

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
  /** Accumulated model reasoning from `reasoning-delta` events — the real
   *  thinking the model surfaced this turn (when thinking is enabled and the
   *  provider streams `display:'summarized'` text). Empty when the model emits
   *  no surfaced reasoning. Ephemeral decoration: never persisted, so reloading
   *  a past turn shows no trace. Accumulates across rounds. */
  reasoning: string;
  /** Where this turn is in its lifecycle. 'streaming' once subscribed; flips to
   *  'done'/'error' when the terminal bus event lands. The caller reconciles to
   *  the durable row on 'done' and surfaces `error` on 'error'. */
  phase: TurnPhase;
  /** Durable `assistant_messages` id of the outbound (reply) row, from the
   *  `turn-start` event — the reconciliation handle for the finished turn. */
  outboundId: string | null;
  /** Durable id of the inbound (user) row, from `turn-start`. */
  inboundId: string | null;
  /** Failure reason once `phase === 'error'`; null otherwise. */
  error: string | null;
  /** Epoch ms when the live subscription opened — the anchor for the elapsed
   *  timer in the status footer. Null when idle. */
  startedAt: number | null;
  /** Output tokens so far: a char-based ESTIMATE (≈chars/4) of the streamed
   *  reply + reasoning while the turn runs, replaced by the REAL `tokensOut`
   *  from the `done` event when the turn lands. Null before any output. */
  tokens: number | null;
  /** True while `tokens` is the streamed estimate; false once it's the real
   *  count from `done`. Lets the footer mark the live number as approximate. */
  tokensApprox: boolean;
}

/** Rough output-token estimate from a running character count. ~4 chars/token
 *  is the standard English heuristic — good enough for a live readout that the
 *  real `tokensOut` from `done` supersedes the moment the turn finishes. */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4));
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
  const [reasoning, setReasoning] = useState('');
  const [phase, setPhase] = useState<TurnPhase>('idle');
  const [outboundId, setOutboundId] = useState<string | null>(null);
  const [inboundId, setInboundId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tokens, setTokens] = useState<number | null>(null);
  const [tokensApprox, setTokensApprox] = useState(true);
  // Ref accumulator for the reply so appends are deterministic (the setState
  // updater stays a pure set-to-same-string, safe under StrictMode double-invoke).
  const replyRef = useRef('');
  const replyRoundRef = useRef(-1);
  // Reasoning accumulates across ALL rounds (unlike the round-scoped reply) so
  // the full thinking trace for the turn is visible, not just the last round's.
  const reasoningRef = useRef('');
  // Running character count of all streamed output (visible reply + reasoning),
  // converted to the token estimate. Kept in a ref so it accumulates across
  // rounds independently of the round-scoped reply buffer.
  const outCharsRef = useRef(0);

  useEffect(() => {
    if (!turnId || !isTurnStreamingEnabledClient()) {
      setTrail([]);
      setReply('');
      setReasoning('');
      setPhase('idle');
      setOutboundId(null);
      setInboundId(null);
      setError(null);
      setStartedAt(null);
      setTokens(null);
      setTokensApprox(true);
      replyRef.current = '';
      replyRoundRef.current = -1;
      reasoningRef.current = '';
      outCharsRef.current = 0;
      return;
    }
    replyRef.current = '';
    replyRoundRef.current = -1;
    reasoningRef.current = '';
    setReasoning('');
    outCharsRef.current = 0;
    setPhase('streaming');
    setError(null);
    setTokens(null);
    setTokensApprox(true);
    // Captured in-closure so each status event can stamp its elapsed time off the
    // same anchor the footer timer uses.
    const startedAtMs = Date.now();
    setStartedAt(startedAtMs);
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
            // Token estimate counts ALL streamed output across rounds (not just
            // the latest round's visible buffer), so it tracks total generation.
            outCharsRef.current += ev.data.text.length;
            setTokens(estimateTokens(outCharsRef.current));
            return;
          }
          if (ev && ev.type === 'reasoning-delta' && typeof ev.data?.text === 'string') {
            // Surface the real reasoning (collapsible "Thinking" trace) AND count
            // its tokens toward the output estimate — it's billed output, kept
            // out of the visible reply buffer.
            reasoningRef.current += ev.data.text;
            setReasoning(reasoningRef.current);
            outCharsRef.current += ev.data.text.length;
            setTokens(estimateTokens(outCharsRef.current));
            return;
          }
          if (ev && ev.type === 'turn-start') {
            // The durable rows now exist — capture their ids for reconciliation.
            if (typeof ev.data?.outboundId === 'string') setOutboundId(ev.data.outboundId);
            if (typeof ev.data?.inboundId === 'string') setInboundId(ev.data.inboundId);
            return;
          }
          if (ev && ev.type === 'done') {
            // Swap the streamed estimate for the real output-token total when the
            // runner reports it (>0); otherwise keep the estimate.
            if (typeof ev.data?.tokensOut === 'number' && ev.data.tokensOut > 0) {
              setTokens(ev.data.tokensOut);
              setTokensApprox(false);
            }
            setPhase('done');
            return;
          }
          if (ev && ev.type === 'error') {
            setError(typeof ev.data?.message === 'string' ? ev.data.message : 'The turn failed.');
            setPhase('error');
            return;
          }
          if (ev && ev.type === 'status' && typeof ev.data?.label === 'string') {
            const stepId = ev.data.stepId;
            const incoming: ThoughtEvent = {
              stepId,
              kind: ev.data.kind ?? 'tool',
              label: ev.data.label,
              elapsedMs: Date.now() - startedAtMs,
            };
            setTrail((prev) => {
              // Upgrade in place: a later narrated event for the same step
              // replaces the grounded line rather than appending a duplicate.
              // Keep the original elapsedMs — the step started when it first arrived.
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
      setReasoning('');
      setPhase('idle');
      setOutboundId(null);
      setInboundId(null);
      setError(null);
      setStartedAt(null);
      setTokens(null);
      setTokensApprox(true);
      replyRef.current = '';
      replyRoundRef.current = -1;
      reasoningRef.current = '';
      outCharsRef.current = 0;
    };
  }, [turnId]);

  return {
    label: trail.length ? trail[trail.length - 1]!.label : null,
    trail,
    reply,
    reasoning,
    phase,
    outboundId,
    inboundId,
    error,
    startedAt,
    tokens,
    tokensApprox,
  };
}
