import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  db,
  agents,
  assistantMessages,
  assistantReadCursors,
  type AgentAvatar,
} from '@mantle/db';

/** Roles that hold a back-and-forth chat (mirrors listAssistantAgents). */
const CHATTABLE_ROLES = ['assistant', 'responder', 'custom'] as const;

const EPOCH = new Date(0);

export type ConversationSummary = {
  agentId: string;
  slug: string;
  name: string;
  avatar: AgentAvatar | null;
  lastMessage: {
    text: string;
    direction: 'inbound' | 'outbound';
    createdAt: Date;
  } | null;
  unreadCount: number;
};

/** Read cursors for this owner, keyed by agentId. */
export async function getReadCursors(ownerId: string): Promise<Map<string, Date>> {
  const rows = await db
    .select({ agentId: assistantReadCursors.agentId, lastReadAt: assistantReadCursors.lastReadAt })
    .from(assistantReadCursors)
    .where(eq(assistantReadCursors.ownerId, ownerId));
  return new Map(rows.map((r) => [r.agentId, r.lastReadAt]));
}

/** Mark an agent's thread read up to [at] (default now). Upsert. */
export async function markAssistantRead(
  ownerId: string,
  agentId: string,
  at: Date = new Date(),
): Promise<Date> {
  await db
    .insert(assistantReadCursors)
    .values({ ownerId, agentId, lastReadAt: at })
    .onConflictDoUpdate({
      target: [assistantReadCursors.ownerId, assistantReadCursors.agentId],
      set: { lastReadAt: at },
    });
  return at;
}

/**
 * The conversations inbox: one row per chat-capable agent with its latest
 * message preview and unread count (outbound messages newer than the read
 * cursor). Sorted by most-recent activity.
 */
export async function assistantConversations(
  ownerId: string,
): Promise<ConversationSummary[]> {
  const agentRows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      avatar: agents.avatar,
    })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, [...CHATTABLE_ROLES]),
      ),
    )
    .orderBy(desc(agents.priority));

  const cursors = await getReadCursors(ownerId);

  const summaries = await Promise.all(
    agentRows.map(async (a): Promise<ConversationSummary> => {
      const [last] = await db
        .select({
          text: assistantMessages.text,
          direction: assistantMessages.direction,
          createdAt: assistantMessages.createdAt,
        })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.ownerId, ownerId),
            eq(assistantMessages.agentId, a.id),
          ),
        )
        .orderBy(desc(assistantMessages.createdAt))
        .limit(1);

      const cursor = cursors.get(a.id) ?? EPOCH;
      const [unreadRow] = await db
        .select({ unread: sql<number>`count(*)::int` })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.ownerId, ownerId),
            eq(assistantMessages.agentId, a.id),
            eq(assistantMessages.direction, 'outbound'),
            gt(assistantMessages.createdAt, cursor),
          ),
        );
      const unread = unreadRow?.unread;

      return {
        agentId: a.id,
        slug: a.slug,
        name: a.name,
        avatar: a.avatar ?? null,
        lastMessage: last
          ? {
              text: last.text,
              direction: last.direction as 'inbound' | 'outbound',
              createdAt: last.createdAt,
            }
          : null,
        unreadCount: unread ?? 0,
      };
    }),
  );

  summaries.sort((x, y) => {
    const xt = x.lastMessage?.createdAt.getTime() ?? 0;
    const yt = y.lastMessage?.createdAt.getTime() ?? 0;
    return yt - xt;
  });
  return summaries;
}
