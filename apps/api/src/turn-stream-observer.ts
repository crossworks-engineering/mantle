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

import { setStepObserver, type StepObserverEvent } from '@mantle/tracing';
import { stageLabelForStep } from '@mantle/assistant-runtime';
import { publishTurnEvent, TURN_EVENT_SCHEMA_VERSION } from '@mantle/turn-stream';
import type { TurnEvent } from '@mantle/client-types';

export function installTurnStreamObserver(): void {
  setStepObserver((e: StepObserverEvent) => {
    // Step 1: narrate on step entry. (End events drive tool-end/token phases.)
    if (e.phase !== 'start') return;
    const stage = stageLabelForStep(e.name, e.input);
    if (!stage) return; // unrecognised step (e.g. load_context) → no status line

    const event: TurnEvent = {
      v: TURN_EVENT_SCHEMA_VERSION,
      turnId: e.turnId,
      seq: e.seq,
      round: 0, // tool-loop round — unused by Step-1 status; populated later
      type: 'status',
      data: { label: stage.label, kind: stage.kind },
    };
    // Fire-and-forget; publishTurnEvent never throws (a dropped status is
    // cosmetic — the poll fallback covers it).
    void publishTurnEvent(e.ownerId, event);
  });
}
