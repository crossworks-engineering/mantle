/**
 * Chat archive threads for the /assistant window (docs/conversation.md §6c,
 * migration 0231): the thread list under an agent, one thread with its
 * summary, and the time range a thread's transcript is read from. The write
 * side (New chat, Continue from this) is archiveAgentChat in
 * @mantle/runtime/agent.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, chatThreads, listChatThreads, nodes, type ChatThread } from '@mantle/db';
import type { ChatThreadRow } from '@mantle/client-types';
import type { ThreadRange } from './assistant';

export type { ChatThreadRow };

/** The rows behind the list: summaries and the "continued from" titles in
 *  two lookups, not one per thread. */
export async function toChatThreadRows(
  ownerId: string,
  threads: ChatThread[],
): Promise<ChatThreadRow[]> {
  if (threads.length === 0) return [];
  const summaryIds = threads.map((t) => t.summaryNodeId).filter((x): x is string => !!x);
  const seedIds = threads.map((t) => t.seedThreadId).filter((x): x is string => !!x);
  const [summaries, seeds] = await Promise.all([
    summaryIds.length
      ? db
          .select({ id: nodes.id, data: nodes.data })
          .from(nodes)
          .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, summaryIds)))
      : [],
    seedIds.length
      ? db
          .select({ id: chatThreads.id, title: chatThreads.title })
          .from(chatThreads)
          .where(and(eq(chatThreads.ownerId, ownerId), inArray(chatThreads.id, seedIds)))
      : [],
  ]);
  const summaryById = new Map(
    summaries.map((n) => {
      const s = (n.data as { summary?: unknown } | null)?.summary;
      return [n.id, typeof s === 'string' ? s : null] as const;
    }),
  );
  const seedById = new Map(seeds.map((t) => [t.id, t.title] as const));
  return threads.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    status: t.status,
    title: t.title,
    startedAt: t.startedAt.toISOString(),
    archivedAt: t.archivedAt ? t.archivedAt.toISOString() : null,
    turnCount: t.turnCount,
    summary: t.summaryNodeId ? (summaryById.get(t.summaryNodeId) ?? null) : null,
    summaryNodeId: t.summaryNodeId,
    continuedFrom: t.seedThreadId
      ? { id: t.seedThreadId, title: seedById.get(t.seedThreadId) ?? null }
      : null,
  }));
}

export async function chatThreadRow(ownerId: string, thread: ChatThread): Promise<ChatThreadRow> {
  const [row] = await toChatThreadRows(ownerId, [thread]);
  return row!;
}

/** Every thread of an agent's chat, newest first, the open one on top. */
export async function chatThreadRows(ownerId: string, agentId: string): Promise<ChatThreadRow[]> {
  return toChatThreadRows(ownerId, await listChatThreads(ownerId, agentId));
}

/** The transcript range of a thread: open = from its start, archived = its
 *  closed range. No thread = the whole forever-thread. */
export function threadRange(thread: ChatThread | null): ThreadRange {
  if (!thread) return {};
  return { since: thread.startedAt, until: thread.archivedAt ?? null };
}
