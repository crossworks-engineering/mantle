/**
 * Tracing primitives — AsyncLocalStorage-keyed trace + step context.
 *
 * The `traceStore` propagates the current `TraceContext` through async
 * boundaries so callers don't have to thread it via arguments. Each
 * `step()` call attaches under the current step (if any) or directly to
 * the trace; ordinal preserves order within a parent.
 *
 * Writes are fire-and-forget: the hot path never awaits an INSERT for
 * trace bookkeeping. A failed trace write is logged but never thrown.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { eq, sql } from 'drizzle-orm';
import { db, traces, traceSteps } from '@mantle/db';
import { truncateJson } from './truncate';
import { runDurableStep } from './durable';

export type TraceKind =
  | 'responder_turn'
  | 'extractor_run'
  | 'summarizer_run'
  | 'reflector_run'
  | 'photo_ingest'
  | 'content_ingest'
  | 'heartbeat_fire'
  | 'federation_request'
  | 'manual';

export type TraceStepKind =
  | 'db_read'
  | 'db_write'
  | 'llm_call'
  | 'embed'
  | 'http'
  | 'notify'
  | 'compute'
  | 'send';

export type StepStatus = 'running' | 'success' | 'error' | 'skipped';

export type StartTraceInit = {
  kind: TraceKind;
  ownerId: string;
  /** When set, this trace's steps are published as live turn events keyed by
   *  this id (the responder turn). Omit for background traces — they pay nothing. */
  turnId?: string;
  subjectId?: string;
  subjectKind?: string;
  agentId?: string | null;
  data?: Record<string, unknown>;
};

export type StartStepInit = {
  name: string;
  kind: TraceStepKind;
  input?: Record<string, unknown>;
};

/** Lifecycle phase of a step, for the optional step observer. */
export type StepPhase = 'start' | 'end';

/**
 * A step lifecycle event handed to a registered observer. Fired ONLY for traces
 * opened with a `turnId` (the live-streamed responder turn), so generic
 * background traces pay nothing. This is the generic tap the runner uses to turn
 * trace steps into live `status`/tool events — tracing itself knows nothing
 * about turn streaming beyond carrying the id and calling back.
 */
export type StepObserverEvent = {
  traceId: string;
  ownerId: string;
  /** The turn correlation id this trace was opened with. */
  turnId: string;
  /** Monotonic per-turn sequence across all observed step events. */
  seq: number;
  name: string;
  kind: TraceStepKind;
  phase: StepPhase;
  /** For `end`: did the step succeed (success|skipped)? Always true for `start`. */
  ok: boolean;
  /** The step's input args — carried on `start` only, for label enrichment. */
  input?: Record<string, unknown>;
};

export type StepObserver = (e: StepObserverEvent) => void;

export type TokenDelta = {
  input?: number;
  output?: number;
  cacheRead?: number;
};

/** Mutable context for a single open trace. */
export type TraceContext = {
  readonly id: string;
  readonly ownerId: string;
  /** Live-streaming correlation id; null for un-streamed (background) traces.
   *  A delegated child inherits the parent's `turnId` (see startTrace) so its
   *  steps surface in the SAME live stream. */
  readonly turnId: string | null;
  /** True only for the trace that INTRODUCED the turnId (the top-level turn);
   *  false for delegated children that inherited it. The token-delta (reply text)
   *  stream is gated to the root so a sub-agent's output never pollutes the
   *  visible reply — children still surface their STATUS in the trail. */
  readonly isStreamRoot: boolean;
  startedAtMs: number;
  ordinalCounter: number; // next root-step ordinal
  childOrdinals: Map<string, number>; // parent step id -> next child ordinal
  tokens: { in: number; out: number; cacheRead: number };
  costMicroUsd: number;
  stepCount: number;
  status: 'running' | 'success' | 'error';
  failedError: string | null;
};

/** Handle a caller passes around inside a step body to enrich it. */
export type StepHandle = {
  readonly id: string;
  readonly traceId: string;
  setOutput(o: Record<string, unknown>): void;
  setMeta(m: Record<string, unknown>): void;
  addTokens(delta: TokenDelta): void;
  addCost(microUsd: number): void;
  setSkipped(reason?: string): void;
  /** Mark this step as FAILED without throwing — for operations that report a
   *  structured failure (a tool returning `{ ok: false, error }`) rather than
   *  raising. Flips the step's status to 'error' and records the message in the
   *  `error` column, so /traces shows a failed tool call as a failure instead of
   *  a 'success' with empty output. The caller still returns/handles the value
   *  normally (the model usually adapts to an error result). */
  setError(message: string): void;
};

type ActiveStep = {
  id: string;
  traceId: string;
  parentStepId: string | null;
  ordinal: number;
  startedAtMs: number;
  output: Record<string, unknown>;
  meta: Record<string, unknown>;
  skippedReason: string | null;
  failedReason: string | null;
};

const traceStore = new AsyncLocalStorage<TraceContext>();
const stepStore = new AsyncLocalStorage<ActiveStep>();

export function currentTrace(): TraceContext | null {
  return traceStore.getStore() ?? null;
}

export function currentStep(): ActiveStep | null {
  return stepStore.getStore() ?? null;
}

// ─── Per-turn live sequence cursor ───────────────────────────────────────────
//
// The stream's `seq` must be monotonic across the WHOLE turn, including any
// delegated sub-agents — each of which runs in its OWN trace (for cost) but
// INHERITS the turn's `turnId`. A per-trace counter would restart at 0 inside
// each child and collide; this per-turnId registry keeps one cursor for status
// + token events from the root turn and every descendant. The root trace deletes
// its entry when it finishes (all children have settled by then).
const turnSeqCounters = new Map<string, number>();
function nextTurnSeq(turnId: string): number {
  const n = turnSeqCounters.get(turnId) ?? 0;
  turnSeqCounters.set(turnId, n + 1);
  return n;
}

// ─── Per-turn abort registry (stop a streamed turn mid-flight) ───────────────
//
// A turn's LLM streaming call needs to be cancellable across the process
// boundary: the user hits Stop in `apps/web`, which NOTIFYs `apps/api`, which
// must abort the in-flight generation. The runner registers an AbortController
// per turn (keyed by the streamId/turnId); the cancel listener calls `abortTurn`
// and the chat dispatcher threads the signal into the adapter via
// `currentTurnAbortSignal()` (read off the current trace's turnId, so delegated
// sub-agents — which inherit the turnId — abort with the root turn too).
const turnAbortControllers = new Map<string, { controller: AbortController; ownerId: string }>();

/** Register an AbortController for `turnId`. The runner calls this at turn start
 *  and {@link unregisterTurnAbort} in a finally. Returns the controller so the
 *  runner can inspect `.signal.aborted` after the loop (a user stop vs. a real
 *  error). */
export function registerTurnAbort(turnId: string, ownerId: string): AbortController {
  const controller = new AbortController();
  turnAbortControllers.set(turnId, { controller, ownerId });
  return controller;
}

/** Abort the in-flight turn `turnId` iff it belongs to `ownerId` (the isolation
 *  check — a turnId guessed from another owner won't match). Returns whether a
 *  matching live turn was found + aborted. NEVER throws. */
export function abortTurn(ownerId: string, turnId: string): boolean {
  const entry = turnAbortControllers.get(turnId);
  if (!entry || entry.ownerId !== ownerId) return false;
  try {
    entry.controller.abort();
    return true;
  } catch {
    return false;
  }
}

/** Drop a turn's controller (the turn ended). */
export function unregisterTurnAbort(turnId: string): void {
  turnAbortControllers.delete(turnId);
}

/** The AbortSignal for the CURRENT turn (read off the active trace's turnId), or
 *  undefined outside a registered turn. The chat dispatcher passes this to the
 *  streaming adapter so a Stop halts generation. */
export function currentTurnAbortSignal(): AbortSignal | undefined {
  const t = currentTrace();
  return t?.turnId ? turnAbortControllers.get(t.turnId)?.controller.signal : undefined;
}

let stepObserver: StepObserver | null = null;

/**
 * Register a single global step observer (or clear it with null). The runner
 * (apps/api) installs one to publish live turn events; every other process
 * leaves it unset and pays nothing. Generic by design — tracing only ever hands
 * back the step's identity + the trace's `turnId`/`ownerId`.
 */
export function setStepObserver(fn: StepObserver | null): void {
  stepObserver = fn;
}

/** Fire the observer for a step lifecycle transition. NEVER throws — an observer
 *  fault must not break the traced work. No-op unless an observer is registered
 *  AND this trace carries a `turnId` (so background traces stay free). */
function notifyStepObserver(
  trace: TraceContext,
  e: {
    name: string;
    kind: TraceStepKind;
    phase: StepPhase;
    ok: boolean;
    input?: Record<string, unknown>;
  },
): void {
  const obs = stepObserver;
  if (!obs || !trace.turnId) return;
  try {
    obs({
      traceId: trace.id,
      ownerId: trace.ownerId,
      turnId: trace.turnId,
      seq: nextTurnSeq(trace.turnId),
      name: e.name,
      kind: e.kind,
      phase: e.phase,
      ok: e.ok,
      input: e.input,
    });
  } catch (err) {
    logErr('step observer', err);
  }
}

// ─── Turn token-delta observer (Phase 3 streaming) ───────────────────────────

/** One streamed token delta for the current turn. `seq` shares the trace's
 *  monotonic `streamSeq` with status events, so a client orders BOTH on one
 *  cursor. */
export type TurnDeltaEvent = {
  turnId: string;
  ownerId: string;
  seq: number;
  round: number;
  kind: 'text' | 'reasoning';
  text: string;
};
export type TurnDeltaObserver = (e: TurnDeltaEvent) => void;

let turnDeltaObserver: TurnDeltaObserver | null = null;

/** Register the global turn-delta observer (the runner installs one to publish
 *  tokens to the live bus). Unset everywhere else — token streaming costs nothing
 *  until a runner installs it, and installing it is ALSO the gate that turns
 *  streaming on (see `isTurnStreaming`). */
export function setTurnDeltaObserver(fn: TurnDeltaObserver | null): void {
  turnDeltaObserver = fn;
}

/** True iff token streaming is active for the current turn: an observer is
 *  installed AND this is a streamed trace (carries a `turnId`). The tool-loop
 *  checks this to choose `adapter.chatStream()` over `adapter.chat()`. */
export function isTurnStreaming(): boolean {
  return turnDeltaObserver !== null && !!currentTrace()?.turnId;
}

/** Emit one streamed token delta for the current turn. No-op unless streaming is
 *  active. Shares the trace's `streamSeq` so deltas + status events interleave on
 *  one monotonic cursor. NEVER throws — a publish fault must not break the turn. */
export function emitTurnDelta(round: number, kind: 'text' | 'reasoning', text: string): void {
  const obs = turnDeltaObserver;
  const trace = currentTrace();
  // Only the ROOT turn streams reply text — a delegated sub-agent's tokens are
  // intermediate (its result is folded back into the persona's own reply), so
  // they must not append to the visible reply buffer. Sub-agent STATUS still
  // surfaces via the step observer above.
  if (!obs || !trace?.turnId || !trace.isStreamRoot) return;
  try {
    obs({
      turnId: trace.turnId,
      ownerId: trace.ownerId,
      seq: nextTurnSeq(trace.turnId),
      round,
      kind,
      text,
    });
  } catch (err) {
    logErr('turn delta observer', err);
  }
}

// ─── Turn lifecycle observer (Phase 3c: turn-start + terminal events) ─────────

/** Lifecycle transition of a whole turn (vs. one step): `turn-start` once the
 *  durable rows exist, `done`/`error` once the outbound row is finalized. */
export type TurnLifecyclePhase = 'turn-start' | 'done' | 'error';

/** A turn lifecycle event. Unlike status/token events these are driven
 *  EXPLICITLY by the runtime — not by the trace — so their timing tracks the
 *  durable `assistant_messages` row (turn-start after the rows exist; done/error
 *  after the outbound text is committed), and they may fire OUTSIDE the trace
 *  context (the outbound row is finalized after the responder trace closes).
 *  `seq` shares the per-turn cursor with status + token events. */
export type TurnLifecycleEvent = {
  turnId: string;
  ownerId: string;
  seq: number;
  phase: TurnLifecyclePhase;
  /** Phase-specific payload — row ids for `turn-start`, the message for `error`. */
  data: Record<string, unknown>;
};
export type TurnLifecycleObserver = (e: TurnLifecycleEvent) => void;

let turnLifecycleObserver: TurnLifecycleObserver | null = null;

/** Register the global turn-lifecycle observer (the runner installs one to
 *  publish turn-start/done/error to the live bus). Unset everywhere else, so the
 *  runtime's `emitTurnLifecycle` calls are free no-ops outside the runner. */
export function setTurnLifecycleObserver(fn: TurnLifecycleObserver | null): void {
  turnLifecycleObserver = fn;
}

/** Emit a turn lifecycle event for `turnId`. Allocates `seq` from the per-turn
 *  cursor; on a TERMINAL phase (done/error) it also retires that cursor — so the
 *  terminal event owns end-of-turn cleanup (startTrace defers to it; see there).
 *  NEVER throws — a publish fault must not break the turn. */
export function emitTurnLifecycle(
  turnId: string,
  ownerId: string,
  phase: TurnLifecyclePhase,
  data: Record<string, unknown> = {},
): void {
  const obs = turnLifecycleObserver;
  if (!obs) return;
  try {
    obs({ turnId, ownerId, seq: nextTurnSeq(turnId), phase, data });
  } catch (err) {
    logErr('turn lifecycle observer', err);
  } finally {
    if (phase === 'done' || phase === 'error') turnSeqCounters.delete(turnId);
  }
}

/**
 * Attribute LLM usage (tokens + cost) to the *currently running* step and
 * its trace from OUTSIDE the step body — for helpers that run several layers
 * below the `step()` call and don't hold the `StepHandle`. `runVisionWorker`
 * is the motivating case: it's the single chokepoint for every vision adapter
 * call, but the call sites wrap it in a step they own. Tokens + cost bubble to
 * the trace total; per-step `meta` (model + cost) is set only when a step is
 * active, so `/debug`'s spend-by-model picks the vision call up. No-op outside
 * a trace.
 */
export function recordStepUsage(usage: {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  costMicroUsd: number;
}): void {
  const trace = currentTrace();
  if (!trace) return;
  trace.tokens.in += usage.input;
  trace.tokens.out += usage.output;
  trace.tokens.cacheRead += usage.cacheRead ?? 0;
  trace.costMicroUsd += usage.costMicroUsd;
  const active = currentStep();
  if (active) {
    active.meta = {
      ...active.meta,
      model: usage.model,
      tokens_in: usage.input,
      tokens_out: usage.output,
      cost_micro_usd: usage.costMicroUsd,
    };
  }
}

function genId(): string {
  // Random UUID v4 — same shape Postgres uses for gen_random_uuid().
  return crypto.randomUUID();
}

function logErr(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[tracing] ${scope}: ${msg}`);
}

/**
 * Open a new trace, run `fn` inside it, finish on success/failure.
 * Errors thrown by `fn` are recorded on the trace and re-thrown.
 */
export async function startTrace<T>(init: StartTraceInit, fn: () => Promise<T>): Promise<T> {
  const id = genId();
  // Inherit the live-stream identity from a parent trace (a delegated sub-agent
  // opens its own trace but should stream into the SAME turn). A trace is the
  // stream ROOT only when it introduces the turnId itself.
  const parentTurnId = currentTrace()?.turnId ?? null;
  const turnId = init.turnId ?? parentTurnId;
  const isStreamRoot = !!init.turnId && !parentTurnId;
  const ctx: TraceContext = {
    id,
    ownerId: init.ownerId,
    turnId,
    isStreamRoot,
    startedAtMs: Date.now(),
    ordinalCounter: 0,
    childOrdinals: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0 },
    costMicroUsd: 0,
    stepCount: 0,
    status: 'running',
    failedError: null,
  };

  // INSERT the row and AWAIT it before yielding to `fn`. Previously this
  // was fire-and-forget; under any concurrent load the first step's
  // INSERT could reach Postgres before the trace row committed (the two
  // queries can land on different pool connections), tripping the
  // `trace_steps_trace_id_fkey` constraint and crashing whatever work
  // the step wrapped. Symptom was Saskia-goes-silent: handleMessage's
  // first `step()` call threw, the trace was marked running forever,
  // the message stayed `processed=true`, no reply went out.
  //
  // The cost is one round-trip of added latency per trace. On local
  // Postgres that's sub-millisecond; on a remote DB it's a few ms.
  // Worth it for guaranteed step inserts.
  //
  // Failure here is still soft: we log and continue. `fn` runs without
  // a parent row, every subsequent `step()` insert will also fail, but
  // the user-visible behaviour (reply gets sent, business logic works)
  // is preserved.
  try {
    await db.insert(traces).values({
      id,
      ownerId: init.ownerId,
      kind: init.kind,
      subjectId: init.subjectId ?? null,
      subjectKind: init.subjectKind ?? null,
      agentId: init.agentId ?? null,
      status: 'running',
      // `turn_id` rides in data (no schema change): it lets the Journey UI
      // offer "Stop" on a running streamed turn (POST /turn/:id/cancel needs
      // the id, which otherwise lives only in this process's abort registry).
      // Inherited turnIds are stamped too, so a delegated child's journey can
      // stop the ROOT turn.
      data: truncateJson({
        ...(init.data ?? {}),
        ...(turnId ? { turn_id: turnId } : {}),
      }) as Record<string, unknown>,
    });
  } catch (err) {
    logErr('open trace', err);
  }

  return traceStore.run(ctx, async () => {
    try {
      const result = await fn();
      ctx.status = 'success';
      return result;
    } catch (err) {
      ctx.status = 'error';
      ctx.failedError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // The root turn owns the per-turn seq cursor. When a lifecycle observer is
      // installed (the runner), the terminal `done`/`error` event — which fires
      // AFTER this trace closes, once the outbound row is finalized — retires the
      // cursor instead, so its seq stays monotonic past the trace boundary. Only
      // clean up here when nothing downstream will (no runner wired).
      if (isStreamRoot && turnId && turnLifecycleObserver === null) {
        turnSeqCounters.delete(turnId);
      }
      const duration = Date.now() - ctx.startedAtMs;
      db.update(traces)
        .set({
          status: ctx.status,
          finishedAt: new Date(),
          durationMs: duration,
          tokensIn: ctx.tokens.in,
          tokensOut: ctx.tokens.out,
          tokensCacheRead: ctx.tokens.cacheRead,
          costMicroUsd: ctx.costMicroUsd,
          stepCount: ctx.stepCount,
          error: ctx.failedError,
        })
        .where(eq(traces.id, ctx.id))
        .catch((err) => logErr('finish trace', err));
    }
  });
}

/**
 * Run `fn` as a step inside the current trace. Captures timing + status.
 * If no trace is active, just runs `fn` without overhead.
 */
export async function step<T>(
  init: StartStepInit,
  fn: (handle: StepHandle) => Promise<T>,
): Promise<T> {
  const trace = currentTrace();
  if (!trace) {
    // No trace: bypass entirely. Caller's body runs without instrumentation.
    return fn(noopHandle());
  }
  const parent = currentStep();
  const parentStepId = parent?.id ?? null;

  let ordinal: number;
  if (parentStepId) {
    ordinal = trace.childOrdinals.get(parentStepId) ?? 0;
    trace.childOrdinals.set(parentStepId, ordinal + 1);
  } else {
    ordinal = trace.ordinalCounter++;
  }

  const id = genId();
  trace.stepCount++;

  const stepInfo: ActiveStep = {
    id,
    traceId: trace.id,
    parentStepId,
    ordinal,
    startedAtMs: Date.now(),
    output: {},
    meta: {},
    skippedReason: null,
    failedReason: null,
  };

  // INSERT the row and AWAIT it before yielding to `fn`. Same reason
  // as the trace-level await above: if `fn` opens a CHILD step (e.g.
  // tool-loop wrapping individual LLM calls + tool dispatch inside one
  // `compute` step), the child's INSERT carries `parent_step_id = id`,
  // and Postgres will trip `trace_steps_parent_step_id_fkey` if the
  // parent row hasn't committed yet. Symptom is the same Saskia-goes-
  // silent: the step throws inside its own open, which bubbles up and
  // kills the surrounding work.
  try {
    await db.insert(traceSteps).values({
      id,
      traceId: trace.id,
      parentStepId: parentStepId,
      ordinal,
      name: init.name,
      kind: init.kind,
      status: 'running',
      input: truncateJson(init.input ?? {}) as Record<string, unknown>,
    });
  } catch (err) {
    logErr('open step', err);
  }

  // Live turn streaming tap: announce the step's start (no-op unless this trace
  // carries a turnId and an observer is installed). Input rides along for label
  // enrichment ("Searching your brain for …").
  notifyStepObserver(trace, {
    name: init.name,
    kind: init.kind,
    phase: 'start',
    ok: true,
    input: init.input,
  });

  const handle: StepHandle = {
    id,
    traceId: trace.id,
    setOutput(o) {
      stepInfo.output = { ...stepInfo.output, ...o };
    },
    setMeta(m) {
      stepInfo.meta = { ...stepInfo.meta, ...m };
    },
    addTokens(delta) {
      trace.tokens.in += delta.input ?? 0;
      trace.tokens.out += delta.output ?? 0;
      trace.tokens.cacheRead += delta.cacheRead ?? 0;
    },
    addCost(microUsd) {
      trace.costMicroUsd += microUsd;
    },
    setSkipped(reason) {
      stepInfo.skippedReason = reason ?? 'skipped';
    },
    setError(message) {
      stepInfo.failedReason = message;
    },
  };

  return stepStore.run(stepInfo, async () => {
    let status: StepStatus = 'success';
    let errMsg: string | null = null;
    try {
      // Route the actual work through the durable executor when a workflow has
      // one active (apps/api): this exact boundary becomes a journaled step, so
      // a crash-resume returns the recorded result instead of re-running the
      // LLM call / tool dispatch. Inert (pure passthrough) otherwise. The trace
      // bookkeeping around it stays best-effort and engine-agnostic.
      const result = await runDurableStep(init.name, () => fn(handle));
      if (stepInfo.skippedReason) {
        status = 'skipped';
        stepInfo.meta = { ...stepInfo.meta, skipped: stepInfo.skippedReason };
      } else if (stepInfo.failedReason) {
        // Soft failure: the operation reported `{ ok: false }` without throwing.
        // Record it as a real error so traces don't show it as a clean success.
        status = 'error';
        errMsg = stepInfo.failedReason;
      }
      return result;
    } catch (err) {
      status = 'error';
      errMsg = err instanceof Error ? err.message : String(err);
      stepInfo.meta = {
        ...stepInfo.meta,
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined,
      };
      throw err;
    } finally {
      const duration = Date.now() - stepInfo.startedAtMs;
      db.update(traceSteps)
        .set({
          status,
          finishedAt: new Date(),
          durationMs: duration,
          output: truncateJson(stepInfo.output) as Record<string, unknown>,
          meta: truncateJson(stepInfo.meta) as Record<string, unknown>,
          error: errMsg,
        })
        .where(eq(traceSteps.id, id))
        .catch((e) => logErr('finish step', e));
      // Announce the step's end (Step-1 status ignores this; tool-end/token
      // phases consume it later). Carries no input.
      notifyStepObserver(trace, {
        name: init.name,
        kind: init.kind,
        phase: 'end',
        ok: status === 'success' || status === 'skipped',
      });
    }
  });
}

function noopHandle(): StepHandle {
  return {
    id: '',
    traceId: '',
    setOutput() {},
    setMeta() {},
    addTokens() {},
    addCost() {},
    setSkipped() {},
    setError() {},
  };
}

/**
 * Record a trace that consciously DID NOT run. Used by pipelines
 * that decide-then-decline (extractor: "already extracted";
 * summarizer: "threshold not met"; reflector: "no new activity").
 *
 * The result is a single trace row with status='skipped', a
 * `disposition` string in `data` that names the reason, and an
 * optional `details` payload for debugging context. No steps are
 * created — the whole story is "the system considered this but
 * chose to skip."
 *
 * Why a separate helper from `startTrace`: starting a trace and
 * then immediately marking it skipped is a fine pattern but reads
 * awkwardly at call sites (you need a try/finally just to set the
 * status). This is one async call, fire-and-forget; it doesn't
 * change the AsyncLocalStorage context, so call sites can stay flat.
 *
 * Returns the inserted trace id (or null if the insert failed —
 * we never throw from this; trace bookkeeping is soft).
 */
export async function recordSkippedTrace(init: {
  kind: TraceKind;
  ownerId: string;
  subjectId?: string;
  subjectKind?: string;
  agentId?: string | null;
  disposition: string;
  details?: Record<string, unknown>;
}): Promise<string | null> {
  const id = genId();
  const now = new Date();
  try {
    await db.insert(traces).values({
      id,
      ownerId: init.ownerId,
      kind: init.kind,
      subjectId: init.subjectId ?? null,
      subjectKind: init.subjectKind ?? null,
      agentId: init.agentId ?? null,
      status: 'skipped',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      data: truncateJson({
        disposition: init.disposition,
        ...(init.details ?? {}),
      }) as Record<string, unknown>,
    });
    return id;
  } catch (err) {
    logErr('record skipped trace', err);
    return null;
  }
}

/**
 * Record an "X just entered the system" event as a content_ingest
 * trace. Wired into every data entry point — upsertFile,
 * createNote, Telegram inbound sync, web upload, etc. — so the
 * node-biography view can answer "where did this come from?"
 * without parsing source-specific tables.
 *
 * The trace is opened with status='success' immediately on insert;
 * the ingest event itself is the work, not a multi-step process.
 * The optional `step` field lets callers attach one trace_step
 * carrying a content snippet (the file body truncated, the
 * message text truncated) so the biography page has rich preview
 * data without having to re-read the source.
 *
 * Fire-and-forget. We never block the hot path on ingest tracing
 * (a file save shouldn't fail because tracing is down).
 */
export async function recordIngest(init: {
  source: string;
  ownerId: string;
  /** The resulting node id. Optional because some ingest paths
   *  (a Telegram message arriving for an unallowlisted chat)
   *  produce no persistent node. */
  nodeId?: string;
  /** The subject_kind that goes on the trace row. Defaults to
   *  'node' when nodeId is set. */
  subjectKind?: string;
  /** One-line "what came in" — shows in biography timelines. */
  summary: string;
  /** Structured details (size, mime, source URL, sender, etc.). */
  payload?: Record<string, unknown>;
  /** Optional content snippet to attach as a step's input field.
   *  Useful for the body of a file/note — visible in the biography
   *  page's expanded step view. */
  snippet?: string;
}): Promise<string | null> {
  const id = genId();
  const now = new Date();
  try {
    await db.insert(traces).values({
      id,
      ownerId: init.ownerId,
      kind: 'content_ingest',
      subjectId: init.nodeId ?? null,
      subjectKind: init.subjectKind ?? (init.nodeId ? 'node' : null),
      status: 'success',
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      stepCount: init.snippet ? 1 : 0,
      data: truncateJson({
        source: init.source,
        summary: init.summary,
        ...(init.payload ?? {}),
      }) as Record<string, unknown>,
    });
    // Attach the content snippet as a single step so it shows up
    // in the biography's "what came in" detail. Truncated by the
    // standard truncateJson budget — full content lives on the
    // node itself.
    if (init.snippet && init.snippet.trim().length > 0) {
      await db.insert(traceSteps).values({
        traceId: id,
        parentStepId: null,
        ordinal: 0,
        name: 'received',
        kind: 'compute',
        status: 'success',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        input: truncateJson({
          source: init.source,
          summary: init.summary,
          content: init.snippet,
        }) as Record<string, unknown>,
        output: truncateJson({
          ...(init.payload ?? {}),
          ...(init.nodeId ? { nodeId: init.nodeId } : {}),
        }) as Record<string, unknown>,
      });
    }
    return id;
  } catch (err) {
    logErr('record ingest', err);
    return null;
  }
}

/** Use sql import for type-only side; some bundlers strip-unused. */
export const _sql = sql;
