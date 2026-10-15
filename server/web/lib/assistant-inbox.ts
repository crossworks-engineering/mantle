import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, agents, assistantMessages, assistantReadCursors, type AgentAvatar } from '@mantle/db';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';

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

/** This login's read cursors, keyed by agentId (per login since 0269). */
export async function getReadCursors(ownerId: string, loginId: string): Promise<Map<string, Date>> {
  // The cursors are the login's own rows, which this query names; the
  // workspace role has no grant on them.
  const rows = await inRuleInQuery(() =>
    db
      .select({
        agentId: assistantReadCursors.agentId,
        lastReadAt: assistantReadCursors.lastReadAt,
      })
      .from(assistantReadCursors)
      .where(
        and(eq(assistantReadCursors.ownerId, ownerId), eq(assistantReadCursors.loginId, loginId)),
      ),
  );
  return new Map(rows.map((r) => [r.agentId, r.lastReadAt]));
}

/** Mark a login's thread with an agent read up to [at] (default now). Upsert. */
export async function markAssistantRead(
  ownerId: string,
  agentId: string,
  loginId: string,
  at: Date = new Date(),
): Promise<Date> {
  // The login's own cursor row, named here; the system pool writes it.
  await inRuleInQuery(() =>
    db
      .insert(assistantReadCursors)
      .values({ ownerId, agentId, loginId, lastReadAt: at })
      .onConflictDoUpdate({
        target: [
          assistantReadCursors.ownerId,
          assistantReadCursors.agentId,
          assistantReadCursors.loginId,
        ],
        set: { lastReadAt: at },
      }),
  );
  return at;
}

/**
 * The conversations inbox of ONE login: one row per agent it may chat with
 * (`agentIds`; every chat-capable agent when omitted, the Admin user's
 * inbox) with its own thread's latest message preview and unread count
 * (outbound messages newer than its read cursor). Sorted by most-recent
 * activity. Never another login's thread (0269, W7c).
 */
export async function assistantConversations(
  ownerId: string,
  loginId: string,
  agentIds?: readonly string[],
): Promise<ConversationSummary[]> {
  if (agentIds && agentIds.length === 0) return [];
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
        agentIds ? inArray(agents.id, [...agentIds]) : inArray(agents.role, [...CHATTABLE_ROLES]),
      ),
    )
    .orderBy(desc(agents.priority));

  const cursors = await getReadCursors(ownerId, loginId);

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
            eq(assistantMessages.loginId, loginId),
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
            eq(assistantMessages.loginId, loginId),
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
