/**
 * The retired Team Forum turn, kept as a no-op under its old workflow name
 * (member logins Phase 6).
 *
 * The forum's turn runner is gone, but a box can hold forum turns in its DBOS
 * system database when it upgrades: ENQUEUED on the `mantle_forum` queue (that
 * queue's row persists, so the queue runner still dispatches it), or PENDING
 * when the process stopped mid-turn (recovery re-dispatches it). With no
 * function under the name, DBOS logs "Cannot find workflow function" and the
 * turn stays PENDING, to be retried on every boot. This stub takes it
 * instead: it fails the topic's pending agent reply (the post the real turn
 * would have finished), lets the Forum archive export pick the topic up, and
 * returns, so the workflow ends in SUCCESS and never comes back.
 *
 * It calls no model and writes nothing but that one status.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { failPendingForumReplies } from '@mantle/content';
import { RETIRED_FORUM_TURN_WORKFLOW } from '@mantle/runtime/assistant';
import { errorMessage } from '@mantle/std';
import { runForumArchiveBootTask } from '../forum-archive-boot';

/** The old input, as the forum routes enqueued it. Read defensively: it comes
 *  from a journal written by an older release. */
type RetiredForumTurnInput = { ownerId?: unknown; options?: { topicId?: unknown } };

export type RetiredForumTurnResult = { retired: true; failedReplies: number };

export async function retiredForumTurn(input: unknown): Promise<RetiredForumTurnResult> {
  const { ownerId, options } = (input ?? {}) as RetiredForumTurnInput;
  const topicId = options?.topicId;
  let failedReplies = 0;
  if (typeof ownerId === 'string' && typeof topicId === 'string') {
    try {
      failedReplies = await failPendingForumReplies(ownerId, { topicId });
    } catch (err) {
      console.error('[forum_turn] retired: could not fail the pending reply:', errorMessage(err));
    }
    if (failedReplies > 0) await runForumArchiveBootTask((line) => DBOS.logger.info(line));
  }
  DBOS.logger.info(
    `[forum_turn] retired: a queued forum turn ended without running (topic=${String(topicId)}, ` +
      `failed replies=${failedReplies})`,
  );
  return { retired: true, failedReplies };
}

export const retiredForumTurnWorkflow = DBOS.registerWorkflow(retiredForumTurn, {
  name: RETIRED_FORUM_TURN_WORKFLOW,
});
