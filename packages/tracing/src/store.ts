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
};

const traceStore = new AsyncLocalStorage<TraceContext>();
const stepStore = new AsyncLocalStorage<ActiveStep>();

export function currentTrace(): TraceContext | null {
  return traceStore.getStore() ?? null;
}

export function currentStep(): ActiveStep | null {
  return stepStore.getStore() ?? null;
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
  };

  return stepStore.run(stepInfo, async () => {
    let status: StepStatus = 'success';
    let errMsg: string | null = null;
    try {
      const result = await fn(handle);
      if (stepInfo.skippedReason) {
        status = 'skipped';
        stepInfo.meta = { ...stepInfo.meta, skipped: stepInfo.skippedReason };
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
  };
}

/** Use sql import for type-only side; some bundlers strip-unused. */
export const _sql = sql;
