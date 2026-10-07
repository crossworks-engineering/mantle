/**
 * Chat archive thread reads (migration 0231, docs/conversation.md §6c). A
 * thread is a time range over one agent's `assistant_messages`; these helpers
 * answer "where does the open chat start" and "which range is closed". The
 * write side (archive, continue) lives in @mantle/runtime, next to the model
 * call that names and summarises the archived thread.
 *
 * Admin pool only: the viewer roles have no grant on `chat_threads`, so a
 * caller inside a limited viewer scope must not call these (the history arm
 * is already skipped below admin).
 */
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from './client';
import { chatThreads, type ChatThread } from './schema/chat-threads';

/** The open thread of an agent's chat, or null when the chat was never
 *  archived (a forever-thread with no lower bound). */
export async function openChatThread(ownerId: string, agentId: string): Promise<ChatThread | null> {
  const [row] = await db
    .select()
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.ownerId, ownerId),
        eq(chatThreads.agentId, agentId),
        eq(chatThreads.status, 'open'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** All threads of an agent's chat, newest first (the open one on top). */
export async function listChatThreads(ownerId: string, agentId: string): Promise<ChatThread[]> {
  return db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.agentId, agentId)))
    .orderBy(desc(chatThreads.startedAt), sql`${chatThreads.status} = 'open' desc`);
}

/** One thread by id, scoped to the owner. */
export async function getChatThread(ownerId: string, id: string): Promise<ChatThread | null> {
  const [row] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.ownerId, ownerId), eq(chatThreads.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * The end of the first CLOSED range after `at`: the earliest `archived_at`
 * later than `at`, or null when `at` sits in the open range. The summarizer
 * uses it so one digest never holds turns from both sides of a "New chat".
 */
export async function closedRangeEndAfter(
  ownerId: string,
  agentId: string,
  at: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ archivedAt: chatThreads.archivedAt })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.ownerId, ownerId),
        eq(chatThreads.agentId, agentId),
        eq(chatThreads.status, 'archived'),
        gt(chatThreads.archivedAt, at),
      ),
    )
    .orderBy(asc(chatThreads.archivedAt))
    .limit(1);
  return row?.archivedAt ?? null;
}
