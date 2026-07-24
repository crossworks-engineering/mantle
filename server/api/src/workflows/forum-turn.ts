/**
 * Forum-turn runner — wraps runForumTurn (@mantle/assistant-runtime) as a
 * durable DBOS workflow on the shared `mantle` queue, exactly like
 * team-turn.ts does for the 1:1 chat surface. The member's post is already
 * persisted by the route; this workflow owns the agent's answer — it survives
 * navigation and process restarts, and every LLM call + tool dispatch
 * journals as its own step.
 */

import { DBOS } from '@dbos-inc/dbos-sdk';
import { withDurableSteps } from '@mantle/tracing';
import {
  runForumTurn,
  FORUM_TURN_WORKFLOW,
  type ForumTurnInput,
  type ForumTurnRunResult,
} from '@mantle/assistant-runtime';

export type { ForumTurnInput, ForumTurnRunResult };

async function forumTurnImpl(input: ForumTurnInput): Promise<ForumTurnRunResult> {
  const { ownerId, options } = input;

  DBOS.span?.setAttribute('mantle.runner', 'forum_turn');
  DBOS.span?.setAttribute('mantle.owner_id', ownerId);
  DBOS.span?.setAttribute('mantle.surface', 'forum');
  DBOS.span?.setAttribute('mantle.contact_id', options.contactId);
  DBOS.span?.setAttribute('mantle.topic_id', options.topicId);
  DBOS.logger.info(
    `[forum_turn] start (owner=${ownerId}, contact=${options.contactId}, topic=${options.topicId})`,
  );

  let dto: ForumTurnRunResult;
  try {
    dto = await withDurableSteps(
      (name, fn) => DBOS.runStep(fn, { name }),
      async (): Promise<ForumTurnRunResult> => {
        // The workflow id is the idempotency key for the agent pending row —
        // a recovery replay adopts its own prior pending instead of conflicting.
        const r = await runForumTurn(ownerId, { ...options, workflowId: DBOS.workflowID });
        return {
          outbound: {
            id: r.outbound.id,
            body: r.outbound.body,
            model: r.outbound.model,
            traceId: r.outbound.traceId ?? null,
            createdAt: new Date(r.outbound.createdAt).toISOString(),
          },
          reply: r.reply,
        };
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    DBOS.span?.setAttribute('mantle.error', msg);
    DBOS.logger.error(`[forum_turn] FAILED (owner=${ownerId}, topic=${options.topicId}): ${msg}`);
    throw err;
  }

  DBOS.logger.info(
    `[forum_turn] done (outbound=${dto.outbound.id}, reply_chars=${dto.reply.length})`,
  );
  return dto;
}

export const forumTurnWorkflow = DBOS.registerWorkflow(forumTurnImpl, {
  name: FORUM_TURN_WORKFLOW,
});
