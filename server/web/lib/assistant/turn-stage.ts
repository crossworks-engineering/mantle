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
import { stageLabelForStep as sharedStageLabel } from '@mantle/runtime/assistant';

/** Only surface a turn's OWN stage while it started recently — guards against a
 *  zombie trace left `status='running'` (a past failure mode) showing a stale
 *  stage. Turns older than this can still surface a stage, but only by PROVING
 *  liveness through a delegated child's recent activity (below). */
const FRESH_WINDOW_MS = 2 * 60 * 1000;

/** Hard ceiling on how old a running turn may be and still be considered at
 *  all. Delegation turns average ~7 min on real fleets (428s measured on
 *  NATREF, 2026-07-18) — far past FRESH_WINDOW_MS, which used to black the
 *  poll out for the tail of every long delegation. Generous, because beyond
 *  the window everything still has to prove itself via recent child steps. */
const DELEGATION_WINDOW_MS = 15 * 60 * 1000;

/** How recent the delegated child's newest STEP must be to count as proof the
 *  old turn is alive rather than a zombie. Wider than FRESH_WINDOW_MS because
 *  a specialist's single steps legitimately run long — a batch page edit's one
 *  LLM call can hold for minutes (the 5-min precedent set by the retired
 *  per-surface assist-stage reader). */
const CHILD_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

/** Poll-facing wrapper over the shared labeler (`@mantle/runtime/assistant`),
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
    const now = Date.now();
    const ceiling = new Date(now - DELEGATION_WINDOW_MS);
    const [trace] = await db
      .select({ id: traces.id, startedAt: traces.startedAt })
      .from(traces)
      .where(
        and(
          eq(traces.ownerId, ownerId),
          eq(traces.kind, 'responder_turn'),
          eq(traces.status, 'running'),
          gt(traces.startedAt, ceiling),
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

    // Delegation is where the poll used to freeze — twice over. A delegated
    // child runs for minutes under ONE parent step (`tool: invoke_agent`), so
    // the label sat on "Delegating to pages…"; and past FRESH_WINDOW_MS the
    // old startedAt guard blacked the poll out entirely, for exactly the long
    // delegations where feedback matters most (428s average on NATREF). The
    // streaming trail follows the child (inherited turnId); this poll is the
    // streaming-off fallback. While the invoke_agent step is RUNNING, follow
    // into the newest running child trace and name its current activity,
    // attributed like the stream does ("Pages · Editing the page…").
    if (stepRow.status === 'running' && stepRow.name === 'tool: invoke_agent') {
      const delegated = await currentDelegatedStageLabel(ownerId, trace.id, now);
      if (delegated) return delegated;
    }

    // The turn's OWN label is only trustworthy while the turn is young — an
    // old running trace with no provably-active child is indistinguishable
    // from the zombie the original guard existed for. Suppress, as before.
    if (trace.startedAt.getTime() <= now - FRESH_WINDOW_MS) return null;
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
  nowMs: number,
): Promise<string | null> {
  // ownerId + kind are indexed (traces_owner_kind_started_idx), so the
  // un-indexed status / jsonb predicates only filter that residue
  // (invoke-agent opens children as kind='manual'; the poll runs ~1×/s while
  // a turn is live). No startedAt bound on the child trace — a legitimate
  // child routinely runs past any short window; the zombie discipline lives
  // on its newest STEP instead (below).
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
    .select({ name: traceSteps.name, input: traceSteps.input, startedAt: traceSteps.startedAt })
    .from(traceSteps)
    .where(eq(traceSteps.traceId, child.id))
    .orderBy(desc(traceSteps.startedAt))
    .limit(1);
  if (!childStep) return null;
  // The zombie guard, moved to where the signal actually is: a child that
  // last STARTED a step within the activity window is demonstrably alive; a
  // crashed pair leaves both traces 'running' with an aging newest step, and
  // this is what stops that from showing a stale label forever.
  if (childStep.startedAt.getTime() <= nowMs - CHILD_ACTIVITY_WINDOW_MS) return null;
  const label = stageLabelForStep(
    childStep.name,
    (childStep.input ?? undefined) as Record<string, unknown> | undefined,
  );
  if (!label) return null;
  return child.agentName ? `${child.agentName} · ${label}` : label;
}
