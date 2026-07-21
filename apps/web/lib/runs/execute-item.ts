/**
 * Run-item execution — the dispatcher's second entry point into the ONE tool
 * executor (`dispatchTool`), mirroring the inline loop's wrapping: central
 * coerce-then-validate, a trace around the call, structured failures, cost
 * attribution. Never fork this into a parallel executor.
 *
 * Slice 1 executes `tool_call` and `note` leaves. `worker_invoke` / `audit` /
 * `ask_human` items fail with a structured `unsupported_kind` record until
 * their slices land — visible in the run view, never silently dropped.
 *
 * Idempotency: `claimItem` (ready→running CAS) makes duplicate wake-ups
 * no-op; `completeItem`'s CAS makes racing the sweep harmless.
 */
import { eq } from 'drizzle-orm';
import { db, runItems, runs as runsTable, type RunItemFailure, type RunItemRow } from '@mantle/db';
import { claimItem, completeItem, requeueForRetry, type PostCommitAction } from '@mantle/runs';
import { dispatchTool, resolveTool, validateToolArgs } from '@mantle/tools';
import { currentTrace, startTrace, step } from '@mantle/tracing';

import { executeWorkerInvoke } from './execute-worker';

/** Tools that must never execute as queue items even if a plan sneaks one
 *  past the plan-time ban (defense in depth with builtins-runs.ts). */
const BANNED_ITEM_TOOLS = new Set([
  'run_plan',
  'run_append',
  'run_state',
  'run_cancel',
  'invoke_agent',
]);

/** Cap what lands in `run_items.result.output` — the compiled state wants
 *  one-liners; the full output lives on the item's trace step. */
const RESULT_OUTPUT_MAX_CHARS = 2_000;

function capOutput(output: unknown): { output: unknown; truncated?: boolean } {
  const s = typeof output === 'string' ? output : JSON.stringify(output ?? null);
  if (s == null) return { output: null };
  if (s.length <= RESULT_OUTPUT_MAX_CHARS) return { output };
  return { output: `${s.slice(0, RESULT_OUTPUT_MAX_CHARS)}…`, truncated: true };
}

export type ExecuteItemOutcome = {
  /** false → the wake-up was stale/duplicate (item not ready) — just ack. */
  claimed: boolean;
  /** Worker items only: the per-run concurrency cap deferred this wake-up. */
  capped?: boolean;
  actions: PostCommitAction[];
};

/**
 * Claim and execute one run item, drive it terminal (or requeue a semantic
 * retry), and return the engine's post-commit actions for the caller to
 * enqueue.
 */
export async function executeRunItem(itemId: string): Promise<ExecuteItemOutcome> {
  // Peek the kind BEFORE claiming: worker items claim under the per-run
  // concurrency cap (claimWorkerItem), everything else claims directly.
  const [peek] = await db
    .select({ kind: runItems.kind })
    .from(runItems)
    .where(eq(runItems.id, itemId));
  if (peek?.kind === 'worker_invoke') {
    return executeWorkerInvoke(itemId);
  }
  if (peek?.kind === 'audit' || peek?.kind === 'ask_human') {
    // Resume-driven (audit) / slice-3 (ask_human) — never claim these here; a
    // stray dispatch job must not steal an audit that's waiting on its
    // resume turn.
    return { claimed: false, actions: [] };
  }

  const item = await claimItem(db, itemId);
  if (!item) return { claimed: false, actions: [] };

  try {
    if (item.kind === 'note') {
      const { actions } = await completeItem(db, { itemId: item.id, state: 'done' });
      return { claimed: true, actions };
    }
    if (item.kind !== 'tool_call') {
      const { actions } = await completeItem(db, {
        itemId: item.id,
        state: 'failed',
        failure: {
          type: 'unsupported_kind',
          message: `item kind '${item.kind}' is not executable yet (slice 2/3)`,
          itemId: item.id,
        },
      });
      return { claimed: true, actions };
    }
    return await executeToolCall(item);
  } catch (err) {
    // Backstop: an unexpected throw must still drive the counter — a wedged
    // 'running' item would otherwise wait for the deadline sweep.
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'failed',
      failure: {
        type: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
        itemId: item.id,
      },
    });
    return { claimed: true, actions };
  }
}

async function executeToolCall(item: RunItemRow): Promise<ExecuteItemOutcome> {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const slug = typeof payload.tool === 'string' ? payload.tool : '';
  const rawArgs =
    payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? (payload.args as Record<string, unknown>)
      : {};

  const fail = async (failure: RunItemFailure) => {
    const { actions } = await completeItem(db, { itemId: item.id, state: 'failed', failure });
    return { claimed: true, actions };
  };

  if (!slug) {
    return fail({ type: 'bad_payload', message: 'tool_call payload has no tool slug' });
  }
  if (BANNED_ITEM_TOOLS.has(slug)) {
    return fail({ type: 'banned_tool', message: `'${slug}' may not run as a queue item` });
  }
  // run_items has no owner column — owner scoping comes from the run row,
  // loaded in runResolved.
  return runResolved(item, slug, rawArgs);
}

async function runResolved(
  item: RunItemRow,
  slug: string,
  rawArgs: Record<string, unknown>,
): Promise<ExecuteItemOutcome> {
  const fail = async (failure: RunItemFailure) => {
    const { actions } = await completeItem(db, { itemId: item.id, state: 'failed', failure });
    return { claimed: true, actions };
  };

  const [run] = await db.select().from(runsTable).where(eq(runsTable.id, item.runId));
  if (!run) return fail({ type: 'internal_error', message: 'run row vanished' });

  const tool = await resolveTool(run.ownerId, slug);
  if (!tool) {
    return fail({
      type: 'tool_missing',
      message: `tool '${slug}' is missing or disabled for this brain`,
    });
  }
  if (tool.requiresConfirm) {
    // ask_human items (slice 3) are the queue's approval mechanism; until
    // then a confirm-gated tool cannot run headless.
    return fail({
      type: 'requires_confirm',
      message: `tool '${slug}' requires operator approval and cannot run as a queue item yet`,
    });
  }

  // Central coerce (repair mode): safe repairs applied, violations recorded
  // but not blocking — matching the inline loop's default telemetry posture.
  const validation = validateToolArgs(
    (tool.inputSchema as Record<string, unknown> | null) ?? null,
    rawArgs,
    slug,
  );
  const input = validation.input;

  // Local usage accumulation so the ITEM row gets its own cost, while the
  // same numbers flow into the trace step (one source, two sinks).
  let costMicroUsd = 0;
  const usage = { input: 0, output: 0, cacheRead: 0 };

  let traceId: string | undefined;
  const result = await startTrace(
    {
      ownerId: run.ownerId,
      kind: 'run_item',
      subjectKind: 'run_item',
      subjectId: item.id,
    },
    async () => {
      traceId = currentTrace()?.id;
      return step(
        { name: `tool: ${slug}`, kind: 'compute', input: { slug, args: input, run_id: run.id } },
        async (handle) => {
          const res = await dispatchTool(tool, input, {
            ownerId: run.ownerId,
            step: {
              setMeta: (m) => handle.setMeta(m),
              setOutput: (o) => handle.setOutput(o),
              addTokens: (d) => {
                usage.input += d.input ?? 0;
                usage.output += d.output ?? 0;
                usage.cacheRead += d.cacheRead ?? 0;
                handle.addTokens(d);
              },
              addCost: (mu) => {
                costMicroUsd += mu;
                handle.addCost(mu);
              },
            },
            // No ctx.agent (a queue item is headless — invoke_agent refuses)
            // and no ctx.surface (send-to-user tools refuse cleanly).
          });
          if (!res.ok) handle.setError(res.error);
          else handle.setOutput({ result: capOutput(res.output).output });
          return res;
        },
      );
    },
  ).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));

  const accounting = {
    ...(usage.input || usage.output || usage.cacheRead ? { usage } : {}),
    ...(costMicroUsd > 0 ? { costMicroUsd } : {}),
    ...(traceId ? { traceRef: traceId } : {}),
  };

  if (result.ok) {
    const { actions } = await completeItem(db, {
      itemId: item.id,
      state: 'done',
      result: capOutput(result.output),
      ...accounting,
    });
    return { claimed: true, actions };
  }

  // Semantic retry: policy-driven, never for side-effecting items.
  const maxAttempts = item.retryPolicy?.maxAttempts ?? 1;
  if (!item.sideEffecting && item.attempt + 1 < maxAttempts) {
    const retry = await requeueForRetry(db, item.id);
    if (retry) return { claimed: true, actions: [retry] };
  }
  const { actions } = await completeItem(db, {
    itemId: item.id,
    state: 'failed',
    failure: { type: 'tool_error', message: result.error, itemId: item.id },
    ...accounting,
  });
  return { claimed: true, actions };
}
