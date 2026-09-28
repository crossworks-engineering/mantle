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
 * instead and returns, so the workflow ends in SUCCESS and never comes back.
 *
 * It reads and writes nothing: the forum's tables were dropped (migration
 * 0177) after every topic was exported into the Forum archive pages.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { RETIRED_FORUM_TURN_WORKFLOW } from '@mantle/runtime/assistant';

/** The old input, as the forum routes enqueued it. Read defensively: it comes
 *  from a journal written by an older release. */
type RetiredForumTurnInput = { options?: { topicId?: unknown } };

export type RetiredForumTurnResult = { retired: true };

export async function retiredForumTurn(input: unknown): Promise<RetiredForumTurnResult> {
  const topicId = ((input ?? {}) as RetiredForumTurnInput).options?.topicId;
  DBOS.logger.info(
    `[forum_turn] retired: a queued forum turn ended without running (topic=${String(topicId)})`,
  );
  return { retired: true };
}

export const retiredForumTurnWorkflow = DBOS.registerWorkflow(retiredForumTurn, {
  name: RETIRED_FORUM_TURN_WORKFLOW,
});
