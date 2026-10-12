/**
 * A user's chat thread with a workspace assistant (workspaces W7c, 0269):
 * the store the workspace turn engine (run-team-turn.ts) writes and reads.
 * Since 0269 a member's thread with the Team assistant is an ordinary
 * per-(agent, login) thread in `assistant_messages`, like the owner's: the
 * turn writes its rows there with the login, row security lets only that
 * login read them, and these helpers always name the login.
 *
 * `team_messages` was frozen in 0269 and dropped in 0274 (workspaces W8d):
 * its member rows are in `assistant_messages` with the same ids, its
 * team-portal contact rows (no login) in `archive_team_messages`, history
 * read by no product code. Admin users no longer read other users' chats
 * (the owner's answer of 2026-10-11): nothing here reads a login's thread
 * for anyone but that login.
 */
import { and, desc, eq, gte, sql as dsql } from 'drizzle-orm';
import {
  assistantMessages,
  db,
  systemDb,
  type AssistantMessage,
  type ConversationAttachment,
  type ConversationChannel,
} from '@mantle/db';

// The turn engine runs in the workspace's turn scope, whose role reads its
// own login's rows but never writes: the writes use systemDb, each naming
// the login and the agent explicitly.

/** A row of a login's thread as the turn engine reads it: the message, plus
 *  the two marks only a workspace turn sets (in `data`). */
export type ThreadMessage = AssistantMessage & {
  /** The turn's trace (data.trace_id), for the deep link from a reply. */
  traceId: string | null;
  /** A reply that may quote the login's PRIVATE items (audit S3). */
  usedPrivate: boolean;
};

function threadMessage(row: AssistantMessage): ThreadMessage {
  const data = (row.data ?? {}) as { trace_id?: unknown; used_private?: unknown };
  return {
    ...row,
    traceId: typeof data.trace_id === 'string' ? data.trace_id : null,
    usedPrivate: data.used_private === true,
  };
}

export type AppendThreadMessageInput = {
  ownerId: string;
  /** The workspace assistant whose thread this is. */
  agentId: string;
  /** The login whose thread this is. */
  loginId: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model?: string | null;
  channel?: ConversationChannel;
  attachments?: ConversationAttachment[];
  error?: string | null;
  /** 'pending' inserts the durable "thinking…" bubble the turn finalizes
   *  later. Ignored when `error` is set (that's always 'failed'). */
  status?: 'pending' | 'complete';
};

/** Persist one turn row of a login's thread. Not fire-and-forget: the
 *  transcript IS the product here, so failures must surface. */
export async function appendThreadMessage(input: AppendThreadMessageInput): Promise<ThreadMessage> {
  const [row] = await systemDb
    .insert(assistantMessages)
    .values({
      ownerId: input.ownerId,
      agentId: input.agentId,
      loginId: input.loginId,
      direction: input.direction,
      text: input.text,
      model: input.model ?? null,
      channel: input.channel ?? 'web',
      attachments: input.attachments ?? [],
      error: input.error ?? null,
      status: input.error ? 'failed' : (input.status ?? 'complete'),
    })
    .returning();
  if (!row) throw new Error('appendThreadMessage: insert returned no row');
  return threadMessage(row);
}

export type UpdateThreadMessageOutcomeInput = {
  ownerId: string;
  /** The login whose row this is: a row of another login is never touched. */
  loginId: string;
  id: string;
  status: 'complete' | 'failed';
  text?: string;
  model?: string | null;
  traceId?: string | null;
  error?: string | null;
  /** Media the turn's tools produced: node references only, never bytes. */
  attachments?: ConversationAttachment[];
  /** The reply may quote the login's private items (audit S3). */
  usedPrivate?: boolean;
};

/** Finalize a pending outbound row (the durable "thinking…" bubble): fill the
 *  reply and flip the status, or mark it failed. Returns the updated row, or
 *  null if it vanished. */
export async function updateThreadMessageOutcome(
  args: UpdateThreadMessageOutcomeInput,
): Promise<ThreadMessage | null> {
  const patch: Record<string, unknown> = {};
  if (args.traceId) patch.trace_id = args.traceId;
  if (args.usedPrivate) patch.used_private = true;
  const [row] = await systemDb
    .update(assistantMessages)
    .set({
      status: args.status,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.attachments !== undefined ? { attachments: args.attachments } : {}),
      ...(Object.keys(patch).length > 0
        ? { data: dsql`${assistantMessages.data} || ${JSON.stringify(patch)}::jsonb` }
        : {}),
    })
    .where(
      and(
        eq(assistantMessages.ownerId, args.ownerId),
        eq(assistantMessages.loginId, args.loginId),
        eq(assistantMessages.id, args.id),
      ),
    )
    .returning();
  return row ? threadMessage(row) : null;
}

/**
 * The most recent `limit` rows of one login's thread with one agent, in
 * ASCENDING order (the context-loader shape). `since` bounds it to the open
 * chat thread ("New chat"). Read on the caller's pool: inside the workspace
 * turn scope, row security also holds it to the login's own rows.
 */
export async function recentThreadMessages(
  ownerId: string,
  agentId: string,
  loginId: string,
  limit = 30,
  since?: Date | null,
): Promise<ThreadMessage[]> {
  const rows = await db
    .select()
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agentId),
        eq(assistantMessages.loginId, loginId),
        ...(since ? [gte(assistantMessages.createdAt, since)] : []),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  rows.reverse();
  return rows.map(threadMessage);
}
