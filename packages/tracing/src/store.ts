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
import { systemDb, traces, traceSteps } from '@mantle/db';
// Infrastructure writes: systemDb (the admin pool) whatever the viewer, so a
// turn under a limited role (member logins Phase 0b) still records them.
import { truncateJson } from './truncate';
import { runDurableStep } from './durable';
import { errorMessage } from '@mantle/std';

export type TraceKind =
  | 'responder_turn'
  | 'extractor_run'
  | 'summarizer_run'
  | 'reflector_run'
  | 'photo_ingest'
  | 'content_ingest'
  | 'heartbeat_fire'
  | 'federation_request'
  // One per dispatched run-item execution (runner queues, migration 0130).
  | 'run_item'
  | 'manual';

export type TraceStepKind =
  'db_read' | 'db_write' | 'llm_call' | 'embed' | 'http' | 'notify' | 'compute' | 'send';

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
  /** Display name stamped onto this trace's live step events ("Pages"), so a
   *  delegated child's status lines carry WHO is working. Streamed turns only;
   *  omit for the root turn — the responder's own steps stay unprefixed. */
  streamLabel?: string;
  data?: Record<string, unknown>;
  /** The login the turn serves (workspaces R3): stamped on the trace row, and
   *  inherited by nested traces. Unset: the parent's, else none (a row of a
   *  non-Admin workspace with no login is read in the Admin workspace only). */
  loginId?: string | null;
  /** Steps that ran before this trace opened (see createTracePrelude). They are
   *  written first, and their tokens + cost count toward this trace. Consumed:
   *  a second trace given the same prelude (an image-fallback retry) gets none. */
  prelude?: TracePrelude;
  /** Handed the trace's model tokens (in, out) when it closes, success or
   *  failure: what the close writes to the row. For a caller that must
   *  keep the count where the trace row's writers cannot change it (the
   *  member turn ledger's tokens, migration 0327). Late usage after the
   *  close is not in it. `delegated`: the model tokens of the traces opened
   *  inside this one that closed before it (a delegated child's, and its
   *  children's), which the row does not count (no double count in the
   *  aggregates) but a per-turn budget must. */
  onClose?: (tokens: { in: number; out: number }, delegated: { in: number; out: number }) => void;
};

export type StartStepInit = {
  name: string;
  kind: TraceStepKind;
  input?: Record<string, unknown>;
  /** false: never route this step through the durable executor, so its
   *  result is not journaled. For a read whose result must not be kept (a
   *  member's private item); a resume simply runs it again. */
  durable?: false;
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
  /** Display name of the DELEGATED agent this step belongs to ("Pages"), when
   *  the step ran inside a child trace opened with a `streamLabel`. Absent for
   *  the root turn's own steps — the consumer prefixes only labelled ones. */
  agentLabel?: string;
};

export type StepObserver = (e: StepObserverEvent) => void;

/** Mutable context for a single open trace. */
export type TraceContext = {
  readonly id: string;
  readonly ownerId: string;
  /** The login the turn serves (StartTraceInit.loginId), inherited. */
  readonly loginId: string | null;
  /** Live-streaming correlation id; null for un-streamed (background) traces.
   *  A delegated child inherits the parent's `turnId` (see startTrace) so its
   *  steps surface in the SAME live stream. */
  readonly turnId: string | null;
  /** True only for the trace that INTRODUCED the turnId (the top-level turn);
   *  false for delegated children that inherited it. The token-delta (reply text)
   *  stream is gated to the root so a sub-agent's output never pollutes the
   *  visible reply — children still surface their STATUS in the trail. */
  readonly isStreamRoot: boolean;
  /** Who this trace's streamed steps should be attributed to (the delegated
   *  agent's display name), or null for the root turn's own steps. */
  readonly streamLabel: string | null;
  startedAtMs: number;
  ordinalCounter: number; // next root-step ordinal
  childOrdinals: Map<string, number>; // parent step id -> next child ordinal
  /** Completion tokens (in, out, cache read) and embedding tokens (embed),
   *  kept apart: the member token budget reads the completion tokens only
   *  (docs/spend-recording.md). */
  tokens: { in: number; out: number; cacheRead: number; embed: number };
  /** Completion tokens of the traces opened inside this one (a delegated
   *  child's, with its own nested ones), added when each closes. Never
   *  written to this trace's row; handed to onClose for a per-turn budget. */
  delegatedTokens?: { in: number; out: number };
  costMicroUsd: number;
  stepCount: number;
  status: 'running' | 'success' | 'error';
  failedError: string | null;
  /** Set when the trace has closed: its close write. Usage that lands later
   *  (a call that was still running when the trace ended) is added to the
   *  row after this write, by an increment (attributeUsage). */
  closed: Promise<void> | null;
};

/** Handle a caller passes around inside a step body to enrich it. */
export type StepHandle = {
  readonly id: string;
  readonly traceId: string;
  setOutput(o: Record<string, unknown>): void;
  setMeta(m: Record<string, unknown>): void;
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

// ─── Prelude: steps that run before their trace opens ───────────────────────
//
// A responder turn loads its context (and makes the decider's pruning + hint
// calls) BEFORE its trace opens: the trace's subject is the inbound row, which
// is written only after the context load so the history block cannot contain
// the new message. Without a home, those steps ran untraced and their cost
// went unrecorded. A prelude holds them in memory; startTrace writes them.

/** One step captured by a prelude. */
export type PreludeStep = {
  name: string;
  kind: TraceStepKind;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  meta: Record<string, unknown>;
  status: StepStatus;
  error: string | null;
  startedAtMs: number;
  durationMs: number | null;
  tokens: { in: number; out: number; cacheRead: number; embed: number };
  /** Completion tokens of the traces opened inside this one (a delegated
   *  child's, with its own nested ones), added when each closes. Never
   *  written to this trace's row; handed to onClose for a per-turn budget. */
  delegatedTokens?: { in: number; out: number };
  costMicroUsd: number;
  /** Index of the enclosing prelude step, or null for a root step. */
  parentIndex: number | null;
};

export type TracePrelude = { steps: PreludeStep[] };

const preludeStore = new AsyncLocalStorage<TracePrelude>();
const preludeStepStore = new AsyncLocalStorage<number>();

export function createTracePrelude(): TracePrelude {
  return { steps: [] };
}

/**
 * Run `fn` so that any `step()` it makes with no trace open is captured into
 * `prelude` instead of being dropped. Inside an open trace this is a plain
 * call: steps go to that trace as usual. Several calls may share one prelude.
 */
export function withTracePrelude<T>(prelude: TracePrelude, fn: () => Promise<T>): Promise<T> {
  if (currentTrace()) return fn();
  return preludeStore.run(prelude, fn);
}

async function preludeStep<T>(
  prelude: TracePrelude,
  init: StartStepInit,
  fn: (handle: StepHandle) => Promise<T>,
): Promise<T> {
  const entry: PreludeStep = {
    name: init.name,
    kind: init.kind,
    input: init.input ?? {},
    output: {},
    meta: {},
    status: 'running',
    error: null,
    startedAtMs: Date.now(),
    durationMs: null,
    tokens: { in: 0, out: 0, cacheRead: 0, embed: 0 },
    costMicroUsd: 0,
    parentIndex: preludeStepStore.getStore() ?? null,
  };
  const index = prelude.steps.push(entry) - 1;
  let skippedReason: string | null = null;
  let failedReason: string | null = null;
  const handle: StepHandle = {
    id: '',
    traceId: '',
    setOutput(o) {
      entry.output = { ...entry.output, ...o };
    },
    setMeta(m) {
      entry.meta = { ...entry.meta, ...m };
    },
    setSkipped(reason) {
      skippedReason = reason ?? 'skipped';
    },
    setError(message) {
      failedReason = message;
    },
  };
  return preludeStepStore.run(index, async () => {
    try {
      const result = await fn(handle);
      if (skippedReason) {
        entry.status = 'skipped';
        entry.meta = { ...entry.meta, skipped: skippedReason };
      } else if (failedReason) {
        entry.status = 'error';
        entry.error = failedReason;
      } else {
        entry.status = 'success';
      }
      return result;
    } catch (err) {
      entry.status = 'error';
      entry.error = errorMessage(err);
      throw err;
    } finally {
      entry.durationMs = Date.now() - entry.startedAtMs;
      entry.meta = { ...entry.meta, prelude: true };
    }
  });
}

/** Write a prelude's steps as the trace's first steps and add their usage. */
async function writePrelude(ctx: TraceContext, steps: PreludeStep[]): Promise<void> {
  if (steps.length === 0) return;
  const ids = steps.map(() => genId());
  const rows = steps.map((s, i) => {
    const parentStepId = s.parentIndex === null ? null : ids[s.parentIndex]!;
    let ordinal: number;
    if (parentStepId) {
      ordinal = ctx.childOrdinals.get(parentStepId) ?? 0;
      ctx.childOrdinals.set(parentStepId, ordinal + 1);
    } else {
      ordinal = ctx.ordinalCounter++;
    }
    ctx.tokens.in += s.tokens.in;
    ctx.tokens.out += s.tokens.out;
    ctx.tokens.cacheRead += s.tokens.cacheRead;
    ctx.tokens.embed += s.tokens.embed;
    ctx.costMicroUsd += s.costMicroUsd;
    ctx.stepCount++;
    return {
      id: ids[i]!,
      traceId: ctx.id,
      parentStepId,
      ordinal,
      name: s.name,
      kind: s.kind,
      // A step still running when the trace opens (should not happen: callers
      // await their prelude work) is recorded as what it is.
      status: s.status,
      startedAt: new Date(s.startedAtMs),
      finishedAt: s.durationMs === null ? null : new Date(s.startedAtMs + s.durationMs),
      durationMs: s.durationMs,
      input: truncateJson(s.input) as Record<string, unknown>,
      output: truncateJson(s.output) as Record<string, unknown>,
      meta: truncateJson(s.meta) as Record<string, unknown>,
      error: s.error,
    };
  });
  try {
    // One statement: a child row may reference a parent in the same batch
    // (Postgres checks the FK at the end of the statement).
    await systemDb.insert(traceSteps).values(rows);
  } catch (err) {
    logErr('write prelude', err);
  }
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

/** Mint a fresh seq for a LATE, out-of-band publish on `turnId`'s stream — e.g.
 *  the narrated status upgrade, which resolves an LLM call after its step's own
 *  seq has long been emitted. The SSE replay merger dedupes on a monotonic seq
 *  and the replay buffer keys on `(turn_id, seq)`, so re-publishing under an
 *  already-emitted seq is silently dropped at BOTH layers: a late event must
 *  mint its seq at publish time, not reuse its trigger's. After the root trace
 *  ends the cursor is gone and this restarts at 0 — callers should not publish
 *  after the turn's terminal event anyway (the client has unsubscribed). */
export function allocateTurnSeq(turnId: string): number {
  return nextTurnSeq(turnId);
}

// ─── Per-turn abort registry (stop a streamed turn mid-flight) ───────────────
//
// A turn's LLM streaming call needs to be cancellable across the process
// boundary: the user hits Stop in `server/web`, which NOTIFYs `server/api`, which
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
 * (server/api) installs one to publish live turn events; every other process
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
      ...(trace.streamLabel ? { agentLabel: trace.streamLabel } : {}),
    });
  } catch (err) {
    logErr('step observer', err);
  }
}

// ─── Turn token-delta observer (token streaming) ─────────────────────────────

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
 *  one monotonic cursor. NEVER throws — a publish fault must not break the turn.
 *
 *  Returns whether the delta actually REACHED a client. The tool loop needs that
 *  answer to decide whether a failed round may be replayed on the backup route:
 *  once the user has seen tokens, re-running the round appends a second answer
 *  to the first. The suppressed cases (no observer, a delegated sub-agent) are
 *  exactly the ones where a replay is invisible and therefore safe. */
export function emitTurnDelta(round: number, kind: 'text' | 'reasoning', text: string): boolean {
  const obs = turnDeltaObserver;
  const trace = currentTrace();
  // Only the ROOT turn streams reply text — a delegated sub-agent's tokens are
  // intermediate (its result is folded back into the persona's own reply), so
  // they must not append to the visible reply buffer. Sub-agent STATUS still
  // surfaces via the step observer above.
  if (!obs || !trace?.turnId || !trace.isStreamRoot) return false;
  try {
    obs({
      turnId: trace.turnId,
      ownerId: trace.ownerId,
      seq: nextTurnSeq(trace.turnId),
      round,
      kind,
      text,
    });
    return true;
  } catch (err) {
    logErr('turn delta observer', err);
    // The observer threw, so nothing was published: report it as not emitted
    // rather than blocking a failover the user would never see double.
    return false;
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

// ─── Spend attribution ───────────────────────────────────────────────────────
//
// Provider usage is recorded in ONE place, the adapter registry of
// @mantle/voice (docs/spend-recording.md), through recordUsage (spend.ts),
// which lands here. The call's trace, step and prelude come from context:
// no caller passes numbers by hand.

/** One provider call's usage, as it adds to a trace and a step. */
export type UsageAttribution = {
  /** Trace totals: `in` already holds the cache-write tokens. `in`, `out`
   *  and `cacheRead` are completion tokens; `embed` the embedding input
   *  tokens, kept apart (the member token budget reads `in + out` only). */
  tokens: { in: number; out: number; cacheRead: number; embed: number };
  /** Completion tokens of the traces opened inside this one (a delegated
   *  child's, with its own nested ones), added when each closes. Never
   *  written to this trace's row; handed to onClose for a per-turn budget. */
  delegatedTokens?: { in: number; out: number };
  costMicroUsd: number;
  /** The step meta keys this call adds (numbers are summed into the step's,
   *  `model` and `provider` replace). */
  meta: Record<string, string | number>;
};

// null: no target here. startTrace runs its work with null, so a trace opened
// inside a chargeTo scope takes its own usage.
const chargeStore = new AsyncLocalStorage<TraceContext | null>();

/** A trace that spend can be charged to (see chargeTo). */
export type SpendTarget = TraceContext;

/** The trace provider usage made now would count toward, as a handle a caller
 *  can carry past the trace's end (a follow-up made after the turn). */
export function spendTarget(): SpendTarget | null {
  return chargeStore.getStore() ?? currentTrace();
}

/**
 * Run `fn` so the provider usage it makes counts toward `target`'s totals
 * only: never a step's meta, whichever step is running around it. For work
 * kicked off beside a step rather than inside it (a narrated status line), or
 * after the trace closed (a follow-up suggestion). A null target: `fn` as is.
 */
export function chargeTo<T>(target: SpendTarget | null, fn: () => Promise<T>): Promise<T> {
  return target ? chargeStore.run(target, fn) : fn();
}

function mergeUsageMeta(
  meta: Record<string, unknown>,
  add: Record<string, string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta };
  for (const [k, v] of Object.entries(add)) {
    if (typeof v === 'number') {
      const was = out[k];
      out[k] = (typeof was === 'number' && Number.isFinite(was) ? was : 0) + v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function addToTotals(ctx: TraceContext, u: UsageAttribution): void {
  if (!ctx.closed) {
    ctx.tokens.in += u.tokens.in;
    ctx.tokens.out += u.tokens.out;
    ctx.tokens.cacheRead += u.tokens.cacheRead;
    ctx.tokens.embed += u.tokens.embed;
    ctx.costMicroUsd += u.costMicroUsd;
    return;
  }
  // The trace closed while the call ran (or before a follow-up made it): add
  // to the row after its close write, so the absolute close values cannot
  // land on top of the increment.
  if (u.tokens.in + u.tokens.out + u.tokens.cacheRead + u.tokens.embed + u.costMicroUsd === 0) {
    return;
  }
  void ctx.closed.then(() =>
    Promise.resolve(
      systemDb
        .update(traces)
        .set({
          tokensIn: sql`${traces.tokensIn} + ${u.tokens.in}`,
          tokensOut: sql`${traces.tokensOut} + ${u.tokens.out}`,
          tokensCacheRead: sql`${traces.tokensCacheRead} + ${u.tokens.cacheRead}`,
          tokensEmbed: sql`${traces.tokensEmbed} + ${u.tokens.embed}`,
          costMicroUsd: sql`${traces.costMicroUsd} + ${u.costMicroUsd}`,
        })
        .where(eq(traces.id, ctx.id)),
    ).catch((err: unknown) => logErr('late usage', err)),
  );
}

/**
 * Attribute one provider call's usage from context: the trace's totals, and
 * the running step's meta (summed over the step's calls). Inside a prelude
 * (no trace yet) it goes to the prelude step. A `chargeTo` target takes the
 * totals only. No trace, no prelude, no target: nowhere (it is not kept).
 */
export function attributeUsage(u: UsageAttribution): void {
  const charged = chargeStore.getStore();
  if (charged) {
    addToTotals(charged, u);
    return;
  }
  const trace = currentTrace();
  if (!trace) {
    const prelude = preludeStore.getStore();
    const index = preludeStepStore.getStore();
    const entry = prelude && index !== undefined ? prelude.steps[index] : undefined;
    if (!entry) return;
    entry.tokens.in += u.tokens.in;
    entry.tokens.out += u.tokens.out;
    entry.tokens.cacheRead += u.tokens.cacheRead;
    entry.tokens.embed += u.tokens.embed;
    entry.costMicroUsd += u.costMicroUsd;
    entry.meta = mergeUsageMeta(entry.meta, u.meta);
    return;
  }
  addToTotals(trace, u);
  // The step must be this trace's: a child trace opened inside a parent's
  // step (a delegated agent) still sees that step in context until it opens
  // one of its own.
  const active = currentStep();
  if (active && active.traceId === trace.id && !trace.closed) {
    active.meta = mergeUsageMeta(active.meta, u.meta);
  }
}

function genId(): string {
  // Random UUID v4 — same shape Postgres uses for gen_random_uuid().
  return crypto.randomUUID();
}

function logErr(scope: string, err: unknown): void {
  const msg = errorMessage(err);
  console.error(`[tracing] ${scope}: ${msg}`);
}

/**
 * Merge `patch` into the current trace's `data` (a no-op outside a trace):
 * a fact known only once the trace's work is under way (the tools a loop
 * lists in its scope). Fire-and-forget, like every
 * trace write; startTrace awaited the row's insert before its work began,
 * so the row is there.
 */
export function setTraceData(patch: Record<string, unknown>): void {
  const ctx = currentTrace();
  if (!ctx) return;
  const json = JSON.stringify(truncateJson(patch));
  systemDb
    .update(traces)
    .set({ data: sql`coalesce(${traces.data}, '{}'::jsonb) || ${json}::jsonb` })
    .where(eq(traces.id, ctx.id))
    .catch((err) => logErr('set trace data', err));
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
  const parent = currentTrace();
  const parentTurnId = parent?.turnId ?? null;
  const turnId = init.turnId ?? parentTurnId;
  const isStreamRoot = !!init.turnId && !parentTurnId;
  // Attribution inherits exactly like the turnId does: a nested trace that
  // streams into the turn keeps the nearest labelled ancestor's name unless it
  // brings its own (invoke-agent always does). Without this, any un-labelled
  // trace opened INSIDE a delegated child would stream its steps bare —
  // silently misattributed to the responder.
  const streamLabel = init.streamLabel ?? parent?.streamLabel ?? null;
  const loginId = init.loginId ?? parent?.loginId ?? null;
  const ctx: TraceContext = {
    id,
    ownerId: init.ownerId,
    loginId,
    turnId,
    isStreamRoot,
    streamLabel,
    startedAtMs: Date.now(),
    ordinalCounter: 0,
    childOrdinals: new Map(),
    tokens: { in: 0, out: 0, cacheRead: 0, embed: 0 },
    costMicroUsd: 0,
    stepCount: 0,
    status: 'running',
    failedError: null,
    closed: null,
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
    await systemDb.insert(traces).values({
      id,
      ownerId: init.ownerId,
      kind: init.kind,
      subjectId: init.subjectId ?? null,
      subjectKind: init.subjectKind ?? null,
      agentId: init.agentId ?? null,
      loginId,
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
  // splice(0) consumes the prelude so a retry trace cannot double-count it.
  if (init.prelude) await writePrelude(ctx, init.prelude.steps.splice(0));

  // A trace opened inside a chargeTo scope is its own: its work's usage lands
  // on it and its steps, not on the charged target (the target is cleared).
  return chargeStore.run(null, () =>
    traceStore.run(ctx, async () => {
      try {
        const result = await fn();
        ctx.status = 'success';
        return result;
      } catch (err) {
        ctx.status = 'error';
        ctx.failedError = errorMessage(err);
        throw err;
      } finally {
        // The root turn owns the per-turn seq cursor. When a lifecycle observer is
        // installed (the runner), the terminal `done`/`error` event (which fires
        // AFTER this trace closes, once the outbound row is finalized) retires the
        // cursor instead, so its seq stays monotonic past the trace boundary. Only
        // clean up here when nothing downstream will (no runner wired).
        if (isStreamRoot && turnId && turnLifecycleObserver === null) {
          turnSeqCounters.delete(turnId);
        }
        const duration = Date.now() - ctx.startedAtMs;
        const delegated = ctx.delegatedTokens ?? { in: 0, out: 0 };
        // A nested trace's tokens (its own and its children's) count on the
        // trace it ran in, for that trace's onClose only.
        if (parent) {
          const up = (parent.delegatedTokens ??= { in: 0, out: 0 });
          up.in += ctx.tokens.in + delegated.in;
          up.out += ctx.tokens.out + delegated.out;
        }
        if (init.onClose) {
          try {
            init.onClose({ in: ctx.tokens.in, out: ctx.tokens.out }, { ...delegated });
          } catch (err) {
            logErr('close hook', err);
          }
        }
        const write = systemDb
          .update(traces)
          .set({
            status: ctx.status,
            finishedAt: new Date(),
            durationMs: duration,
            tokensIn: ctx.tokens.in,
            tokensOut: ctx.tokens.out,
            tokensCacheRead: ctx.tokens.cacheRead,
            tokensEmbed: ctx.tokens.embed,
            costMicroUsd: ctx.costMicroUsd,
            stepCount: ctx.stepCount,
            error: ctx.failedError,
          })
          .where(eq(traces.id, ctx.id));
        ctx.closed = Promise.resolve(write).then(
          () => undefined,
          (err: unknown) => logErr('finish trace', err),
        );
      }
    }),
  );
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
    // No trace, but a prelude is collecting: hold the step for the trace that
    // is about to open. Otherwise bypass entirely.
    const prelude = preludeStore.getStore();
    if (prelude) return preludeStep(prelude, init, fn);
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
    await systemDb.insert(traceSteps).values({
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
      // one active (server/api): this exact boundary becomes a journaled step, so
      // a crash-resume returns the recorded result instead of re-running the
      // LLM call / tool dispatch. Inert (pure passthrough) otherwise. The trace
      // bookkeeping around it stays best-effort and engine-agnostic.
      const result =
        init.durable === false
          ? await fn(handle)
          : await runDurableStep(init.name, () => fn(handle));
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
      errMsg = errorMessage(err);
      stepInfo.meta = {
        ...stepInfo.meta,
        stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined,
      };
      throw err;
    } finally {
      const duration = Date.now() - stepInfo.startedAtMs;
      systemDb
        .update(traceSteps)
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
  /** The login the skipped work answered (traces.login_id, as startTrace's
   *  loginId): its trace is listed to that login only; null the anchor's. */
  loginId?: string | null;
  disposition: string;
  details?: Record<string, unknown>;
}): Promise<string | null> {
  const id = genId();
  const now = new Date();
  try {
    await systemDb.insert(traces).values({
      id,
      ownerId: init.ownerId,
      kind: init.kind,
      subjectId: init.subjectId ?? null,
      subjectKind: init.subjectKind ?? null,
      agentId: init.agentId ?? null,
      loginId: init.loginId ?? null,
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
    await systemDb.insert(traces).values({
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
      await systemDb.insert(traceSteps).values({
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
