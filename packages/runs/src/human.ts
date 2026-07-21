/**
 * `ask_human` answer path (slice 3 WP3, docs/runs-slice-3-plan.md §4 + audit
 * amendments). An ask_human item is the audit-item pattern with a human in
 * the LLM's place: promote parks it `ready` (never dispatched) and creates a
 * `pending_tool_calls` row as the approval surface; the human's decision —
 * via `pending_approve` / `pending_reject` — lands here and completes the
 * item, which drives the completion counter like any other terminal
 * transition (the group advances; nothing special downstream).
 *
 * The answer rides `result.answer` into the compiled run state, so later
 * steps and the resume prompt see it verbatim.
 *
 * Owner scoping is enforced HERE against the run row (final audit F2): the
 * pending row is owner-scoped by `approvePendingCall`/`rejectPendingCall`,
 * but the row's ARGS are only trustworthy when the runs engine wrote them —
 * a slug-squatted `ask_human` tool could mint a row whose `item_id` points
 * at someone else's run. The item's run must belong to `ownerId` or the
 * decision refuses.
 */
import { eq } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import { completeItem, type PostCommitAction } from './engine';

export type HumanAnswerResult =
  | { ok: true; state: 'done' | 'failed'; actions: PostCommitAction[] }
  | {
      ok: false;
      /** 'moved_on': the item is already terminal (cancelled, timed out, or
       *  the run died) — the caller expires the pending row and tells the
       *  operator the run moved on. 'not_ask_human': bad ref. 'forbidden':
       *  the item's run belongs to a different owner — never applied. */
      reason: 'moved_on' | 'not_ask_human' | 'forbidden';
      error: string;
    };

/**
 * Apply a human decision to an ask_human item. 'answered' completes it
 * `done` with the answer (optional for yes/no-shaped questions — approval
 * itself is the answer); 'rejected' completes it `failed({type:'rejected'})`
 * so join policies treat it like any failed step (a fail_fast group stops,
 * wait_all records and continues).
 *
 * CAS-safe: if the item went terminal meanwhile (run cancelled, dated
 * question swept as timeout), returns `moved_on` — the caller must NOT
 * pretend the answer took effect.
 */
export async function applyHumanAnswer(
  db: Db,
  opts: { itemId: string; ownerId: string; decision: 'answered' | 'rejected'; answer?: string },
): Promise<HumanAnswerResult> {
  const [item] = await db.select().from(runItems).where(eq(runItems.id, opts.itemId));
  if (!item || item.kind !== 'ask_human') {
    return {
      ok: false,
      reason: 'not_ask_human',
      error: `item ${opts.itemId} is not an ask_human item`,
    };
  }
  const [run] = await db
    .select({ ownerId: runs.ownerId })
    .from(runs)
    .where(eq(runs.id, item.runId));
  if (!run || run.ownerId !== opts.ownerId) {
    return {
      ok: false,
      reason: 'forbidden',
      error: `ask_human item ${opts.itemId} does not belong to a run of this owner — decision not applied`,
    };
  }

  const state = opts.decision === 'answered' ? 'done' : 'failed';
  const { completed, actions } = await completeItem(db, {
    itemId: item.id,
    state,
    ...(opts.decision === 'answered'
      ? {
          result: {
            ...(opts.answer?.trim() ? { answer: opts.answer.trim() } : { answer: 'approved' }),
          },
        }
      : {
          failure: {
            type: 'rejected',
            message: opts.answer?.trim()
              ? `rejected by the operator: ${opts.answer.trim()}`
              : 'rejected by the operator',
            itemId: item.id,
          },
        }),
  });
  if (!completed) {
    return {
      ok: false,
      reason: 'moved_on',
      error:
        `ask_human item ${item.id} is already '${item.state}' — the run moved on ` +
        `(cancelled, timed out, or completed) before this answer; it was not applied`,
    };
  }
  return { ok: true, state, actions };
}
