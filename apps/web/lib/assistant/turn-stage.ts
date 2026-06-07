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

/** Only surface stages for turns started recently — guards against a zombie
 *  trace left `status='running'` (a past failure mode) showing a stale stage. */
const FRESH_WINDOW_MS = 2 * 60 * 1000;

/** Map a trace_step `name` to a coarse, user-facing stage label. Step names
 *  come from the tool loop (packages/agent-runtime/src/tool-loop.ts):
 *    - `<adapter>_chat`, `<adapter>_chat[2]`, `..._chat[force_final]`
 *        → an LLM call            → "Thinking…"
 *    - `tool: <slug>`             → a tool dispatch        → bucketed by slug
 *    - `spill_result: <slug>`     → result paging          → "Working on it…"
 *  Returns null for names we don't surface (caller shows plain dots). */
export function stageLabelForStep(name: string): string | null {
  if (!name) return null;
  // LLM calls: the adapter step name always ends in `_chat` or `_chat[…]`.
  if (/_chat(\[|$)/.test(name)) return 'Thinking…';

  const tool = /^tool:\s*(.+)$/.exec(name);
  if (tool) {
    const slug = tool[1]!.trim();
    if (slug === 'invoke_agent') return 'Delegating to a specialist…';
    if (slug === 'web_search') return 'Searching the web…';
    if (/^(search|find|recall|entity_|graph_|peer_)/.test(slug))
      return 'Searching your brain…';
    return 'Working on it…';
  }
  if (/^spill_result:/.test(name)) return 'Working on it…';
  return null;
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
      .select({ name: traceSteps.name })
      .from(traceSteps)
      .where(eq(traceSteps.traceId, trace.id))
      .orderBy(desc(traceSteps.startedAt))
      .limit(1);
    if (!stepRow) return null;
    return stageLabelForStep(stepRow.name);
  } catch {
    return null;
  }
}
