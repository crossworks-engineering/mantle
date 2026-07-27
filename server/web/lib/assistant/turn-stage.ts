/**
 * Live "what is the assistant doing right now" stage label.
 *
 * The assistant turn is a single synchronous POST (no streaming), but the
 * tracing layer writes the trace row (status='running') and each step row
 * (with a descriptive `name`) to the DB *at the start* of the work — before it
 * runs (see packages/tracing/src/store.ts). So the current stage is already
 * queryable mid-turn: find the owner's latest still-running responder_turn,
 * read its most-recently-started step, and map the step name to a friendly
 * label. The chat UI polls this (~1×/s) so no streaming refactor is needed.
 *
 * Granularity is deliberately coarse (~5 buckets): the fast CRUD tools flash
 * by under the poll interval, so we only name the stages a user actually waits
 * on — thinking, searching, delegating — and fall back to plain dots otherwise.
 */
import { db, traces, traceSteps, agents, and, eq, gt, desc, sql } from '@mantle/db';
import { stageLabelForStep as sharedStageLabel } from '@mantle/assistant-runtime';

/** Only surface stages for turns started recently — guards against a zombie
 *  trace left `status='running'` (a past failure mode) showing a stale stage. */
const FRESH_WINDOW_MS = 2 * 60 * 1000;

/** Poll-facing wrapper over the shared labeler (`@mantle/assistant-runtime`),
 *  reduced to the display string — the poll has no use for the `kind` bucket.
 *  Passes the step's input so the poll enriches with args ("…for “Acme
 *  SLA”") exactly like the live stream pushes. Returns null for names we don't
 *  surface (caller shows plain dots). */
export function stageLabelForStep(name: string, input?: Record<string, unknown>): string | null {
  return sharedStageLabel(name, input)?.label ?? null;
}

/** The owner's current in-flight assistant stage, or null when idle. Two tiny
 *  single-row reads on indexed columns; safe to poll. Soft-fails to null so a
 *  tracing hiccup never breaks the chat UI. */
export async function currentTurnStageLabel(ownerId: string): Promise<string | null> {
  try {
    const fresh = new Date(Date.now() - FRESH_WINDOW_MS);
    const [trace] = await db
      .select({ id: traces.id })
      .from(traces)
      .where(
        and(
          eq(traces.ownerId, ownerId),
          eq(traces.kind, 'responder_turn'),
          eq(traces.status, 'running'),
          gt(traces.startedAt, fresh),
        ),
      )
      .orderBy(desc(traces.startedAt))
      .limit(1);
    if (!trace) return null;

    // The most-recently-started step is the activity in flight. Ordinals reset
    // per parent (nested steps), so order by startedAt, not ordinal.
    const [stepRow] = await db
      .select({ name: traceSteps.name, status: traceSteps.status, input: traceSteps.input })
      .from(traceSteps)
      .where(eq(traceSteps.traceId, trace.id))
      .orderBy(desc(traceSteps.startedAt))
      .limit(1);
    if (!stepRow) return null;

    // Delegation is where the poll used to freeze: a delegated child runs for
    // minutes under ONE parent step (`tool: invoke_agent`), so this label sat
    // on "Delegating to pages…" for the whole 400s while the child worked
    // unseen — the streaming trail follows the child (inherited turnId), but
    // this poll is the streaming-off fallback and only read the parent trace.
    // While that step is still RUNNING, follow into the newest running child
    // trace and name its current activity, attributed like the stream does
    // ("Pages · Editing the page…"). Any miss (child not inserted yet, child
    // just finished, no labelable step) falls back to the parent's own label.
    if (stepRow.status === 'running' && stepRow.name === 'tool: invoke_agent') {
      const delegated = await currentDelegatedStageLabel(ownerId, trace.id);
      if (delegated) return delegated;
    }
    return stageLabelForStep(
      stepRow.name,
      (stepRow.input ?? undefined) as Record<string, unknown> | undefined,
    );
  } catch {
    return null;
  }
}

/** The delegated child's current stage, attributed to the specialist by name —
 *  or null when there's no running child / nothing labelable (caller falls
 *  back to the parent's "Delegating to …" label). The child trace is found by
 *  the `parent_trace_id` its opener stamps into `data` (invoke-agent.ts). */
async function currentDelegatedStageLabel(
  ownerId: string,
  parentTraceId: string,
): Promise<string | null> {
  // owner + kind lead the WHERE so traces_owner_kind_started_idx narrows the
  // scan before the un-indexed status / jsonb predicates run (invoke-agent
  // opens children as kind='manual'; the poll runs ~1×/s while a turn is live).
  const [child] = await db
    .select({ id: traces.id, agentName: agents.name })
    .from(traces)
    .leftJoin(agents, eq(agents.id, traces.agentId))
    .where(
      and(
        eq(traces.ownerId, ownerId),
        eq(traces.kind, 'manual'),
        eq(traces.status, 'running'),
        eq(sql`${traces.data}->>'parent_trace_id'`, parentTraceId),
      ),
    )
    .orderBy(desc(traces.startedAt))
    .limit(1);
  if (!child) return null;
  const [childStep] = await db
    .select({ name: traceSteps.name, input: traceSteps.input })
    .from(traceSteps)
    .where(eq(traceSteps.traceId, child.id))
    .orderBy(desc(traceSteps.startedAt))
    .limit(1);
  if (!childStep) return null;
  const label = stageLabelForStep(
    childStep.name,
    (childStep.input ?? undefined) as Record<string, unknown> | undefined,
  );
  if (!label) return null;
  return child.agentName ? `${child.agentName} · ${label}` : label;
}
