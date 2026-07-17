/**
 * Shared forum-turn enqueue — used by both topic-create and post-create
 * routes. Mints the turn id in the SAME `team-<contactId>.<nonce>` namespace
 * as Team Chat (the member's credential sets the contact half, so the id can
 * never address another member's turn) — which also means the existing
 * /api/team/turn/[turnId]/stream route serves forum turns untouched.
 */
import { getDbosClient } from '@/lib/dbos-client';
import { isTurnStreamingEnabled } from '@/lib/turn-streaming';
import { mintTeamTurnId } from '@/lib/team-chat-gate';
import {
  FORUM_TURN_WORKFLOW,
  FORUM_QUEUE,
  type ForumTurnInput,
  type ForumTurnRunResult,
} from '@mantle/assistant-runtime';
import type { TeamChannel } from '@mantle/db';

export type EnqueueForumTurnArgs = {
  ownerId: string;
  contactId: string;
  contactName?: string;
  topicId: string;
  inboundPostId: string;
  channel: Extract<TeamChannel, 'web' | 'api'>;
  /** Client Idempotency-Key (nonce half only — see mintTeamTurnId). */
  idempotencyKey?: string;
};

export type EnqueueForumTurnResult =
  | { streaming: true; turnId: string }
  | { streaming: false; result: ForumTurnRunResult };

/** Enqueue the durable forum turn. Streaming on ⇒ returns the turn id for the
 *  SSE stream (202 path); off ⇒ awaits the agent's answer (blocking path). */
export async function enqueueForumTurn(
  args: EnqueueForumTurnArgs,
): Promise<EnqueueForumTurnResult> {
  const turnId = mintTeamTurnId(args.contactId, args.idempotencyKey);
  const streaming = isTurnStreamingEnabled();

  const input: ForumTurnInput = {
    ownerId: args.ownerId,
    options: {
      contactId: args.contactId,
      contactName: args.contactName,
      topicId: args.topicId,
      inboundPostId: args.inboundPostId,
      channel: args.channel,
      ...(streaming ? { streamId: turnId } : {}),
    },
  };

  const client = await getDbosClient();
  const handle = await client.enqueue<(i: ForumTurnInput) => Promise<ForumTurnRunResult>>(
    {
      workflowName: FORUM_TURN_WORKFLOW,
      queueName: FORUM_QUEUE,
      // Partition by topic ⇒ turns in the same topic serialize (concurrency 1
      // per partition); different topics run in parallel. This is the forum
      // turn serializer — no in-workflow spin-lock.
      queuePartitionKey: args.topicId,
      workflowID: turnId,
    },
    input,
  );

  if (streaming) return { streaming: true, turnId };
  return { streaming: false, result: await handle.getResult() };
}
