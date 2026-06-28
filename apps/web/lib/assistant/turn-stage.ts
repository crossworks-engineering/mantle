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
import { db, traces, traceSteps, and, eq, gt, desc } from '@mantle/db';
import { stageLabelForStep as sharedStageLabel } from '@mantle/assistant-runtime';

/** Only surface stages for turns started recently — guards against a zombie
 *  trace left `status='running'` (a past failure mode) showing a stale stage. */
const FRESH_WINDOW_MS = 2 * 60 * 1000;

/** Poll-facing wrapper over the shared labeler (`@mantle/assistant-runtime`),
 *  reduced to the display string — the poll has no use for the `kind` bucket.
 *  Passes the step's input so the poll enriches with args ("…for “Pinnacle
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
      .select({ name: traceSteps.name, input: traceSteps.input })
      .from(traceSteps)
      .where(eq(traceSteps.traceId, trace.id))
      .orderBy(desc(traceSteps.startedAt))
      .limit(1);
    if (!stepRow) return null;
    return stageLabelForStep(stepRow.name, (stepRow.input ?? undefined) as Record<string, unknown> | undefined);
  } catch {
    return null;
  }
}
