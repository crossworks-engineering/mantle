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

export type TokenDelta = {
  input?: number;
  output?: number;
  cacheRead?: number;
};

/** Mutable context for a single open trace. */
export type TraceContext = {
  readonly id: string;
  readonly ownerId: string;
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
export async function startTrace<T>(
  init: StartTraceInit,
  fn: () => Promise<T>,
): Promise<T> {
  const id = genId();
  const ctx: TraceContext = {
    id,
    ownerId: init.ownerId,
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
      data: truncateJson(init.data ?? {}) as Record<string, unknown>,
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
      const result = await fn(handle);
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
