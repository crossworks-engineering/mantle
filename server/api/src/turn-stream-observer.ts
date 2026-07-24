/**
 * Trace → live-turn-stream bridge (the Step-1 producer).
 *
 * While a responder turn runs (a trace opened with a `turnId`), the tracing
 * layer fires a step observer on every step start/end. Here we map each step
 * START to a grounded `status` event ("Searching your brain for …") and publish
 * it over the `turn_stream` NOTIFY channel, so the web/companion client can
 * narrate the turn live instead of polling. See docs/live-turn-streaming.md.
 *
 * Step 1 emits `status` only. Tool-start/end and token deltas (`text-delta`)
 * come in later phases — the observer already receives `end` events; it just
 * ignores them for now.
 *
 * Lives in apps/api because that's where the turn executes. Installed once at
 * boot; a no-op for every trace without a `turnId` (background work pays
 * nothing — the gate is in the tracing layer).
 */

import {
  setStepObserver,
  setTurnDeltaObserver,
  setTurnLifecycleObserver,
  type StepObserverEvent,
  type TurnDeltaEvent,
  type TurnLifecycleEvent,
} from '@mantle/tracing';
import { stageLabelForStep, type StageLabel } from '@mantle/assistant-runtime';
import { publishTurnEvent, TURN_EVENT_SCHEMA_VERSION } from '@mantle/turn-stream';
import type { TurnEvent } from '@mantle/client-types';
import { isTurnNarrationEnabled, narrateStatus } from './turn-narration';

/** Token streaming (Phase 3): installing the delta observer is what makes the
 *  tool-loop stream (`isTurnStreaming()`). On by default, on its own flag so it
 *  can be turned off independently of the status stream; set
 *  `MANTLE_TURN_TOKENS=0` to disable just the live reply typing. */
export function isTurnTokenStreamingEnabled(): boolean {
  const v = process.env.MANTLE_TURN_TOKENS?.trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Build a `status` event for one step. `stepId` ties the grounded line to its
 *  later narrated upgrade so the client replaces it in place. */
function statusEvent(
  e: StepObserverEvent,
  label: string,
  stage: StageLabel,
  stepId: string,
): TurnEvent {
  return {
    v: TURN_EVENT_SCHEMA_VERSION,
    turnId: e.turnId,
    seq: e.seq,
    round: 0, // tool-loop round — populated in a later phase
    type: 'status',
    data: { label, kind: stage.kind, stepId },
  };
}

/** Map one streamed token delta → a `text-delta` / `reasoning-delta` turn event.
 *  `seq` shares the trace's monotonic cursor with status events, so the client
 *  orders the whole stream (status + tokens) on one sequence. */
function deltaEvent(e: TurnDeltaEvent): TurnEvent {
  return {
    v: TURN_EVENT_SCHEMA_VERSION,
    turnId: e.turnId,
    seq: e.seq,
    round: e.round,
    type: e.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
    data: { text: e.text },
  };
}

/** Map a turn-lifecycle transition → its `turn-start` / `done` / `error` turn
 *  event. These ride the SAME `seq` cursor as status/token events (terminal
 *  events come last). `round` is 0 — lifecycle events aren't round-scoped. */
function lifecycleEvent(e: TurnLifecycleEvent): TurnEvent {
  const base = { v: TURN_EVENT_SCHEMA_VERSION, turnId: e.turnId, seq: e.seq, round: 0 } as const;
  if (e.phase === 'turn-start') {
    return {
      ...base,
      type: 'turn-start',
      data: {
        agentSlug: typeof e.data.agentSlug === 'string' ? e.data.agentSlug : '',
        model: typeof e.data.model === 'string' ? e.data.model : null,
        ...(typeof e.data.inboundId === 'string' ? { inboundId: e.data.inboundId } : {}),
        ...(typeof e.data.outboundId === 'string' ? { outboundId: e.data.outboundId } : {}),
      },
    };
  }
  if (e.phase === 'error') {
    return {
      ...base,
      type: 'error',
      data: {
        status: 'failed',
        message: typeof e.data.message === 'string' ? e.data.message : 'turn failed',
      },
    };
  }
  return {
    ...base,
    type: 'done',
    data: {
      status: 'complete',
      ...(typeof e.data.tokensOut === 'number' ? { tokensOut: e.data.tokensOut } : {}),
    },
  };
}

export function installTurnStreamObserver(): void {
  // Phase 3: token deltas. Installing this observer is ALSO what flips
  // `isTurnStreaming()` true in the tool-loop, so the turn only streams (uses the
  // adapter's chatStream + streaming HTTP) when this flag is set. Each delta
  // publishes over the SAME NOTIFY bus as status — fire-and-forget, never throws.
  if (isTurnTokenStreamingEnabled()) {
    setTurnDeltaObserver((e: TurnDeltaEvent) => {
      void publishTurnEvent(e.ownerId, deltaEvent(e));
    });
  }

  // Turn lifecycle (turn-start / done / error). Always installed — these frame
  // the stream the same way `status` does and are gated client-side by the web
  // SSE route's MANTLE_TURN_STREAMING flag, not by the token flag. The runtime's
  // emitTurnLifecycle calls are free no-ops until this observer exists.
  setTurnLifecycleObserver((e: TurnLifecycleEvent) => {
    void publishTurnEvent(e.ownerId, lifecycleEvent(e));
  });

  setStepObserver((e: StepObserverEvent) => {
    // Narrate on step entry. (End events drive tool-end/token phases later.)
    if (e.phase !== 'start') return;
    // Seed the thinking-phrase rotation with the step's seq so each LLM round
    // shows a different phrase (stable for that step — never flickers mid-step).
    const stage = stageLabelForStep(e.name, e.input, e.seq);
    if (!stage) return; // unrecognised step (e.g. load_context) → no status line

    const stepId = String(e.seq); // unique per step-start within a turn

    // 1) Grounded line, published INSTANTLY so the trail never waits on the LLM.
    //    publishTurnEvent never throws (a dropped status is cosmetic).
    void publishTurnEvent(e.ownerId, statusEvent(e, stage.label, stage, stepId));

    // 2) Narrated upgrade — Step 2. Only for tool actions (skip 'thinking' to
    //    save spend), strictly OFF the critical path (not awaited), gated by the
    //    narration flag. On success it replaces line `stepId` in the trail; on
    //    failure the grounded line simply stays.
    if (isTurnNarrationEnabled() && stage.kind !== 'thinking') {
      void narrateStatus(e.ownerId, stage.label).then((narrated) => {
        if (narrated) void publishTurnEvent(e.ownerId, statusEvent(e, narrated, stage, stepId));
      });
    }
  });
}
