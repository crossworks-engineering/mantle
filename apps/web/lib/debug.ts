import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  agents,
  entities,
  facts,
  nodes,
  telegramChats,
  telegramMessages,
  type PersonaNote,
} from '@mantle/db';

/**
 * Read-only helpers for the /debug page. All owner-scoped — pass the user's
 * id explicitly; the page never accepts a user id from the client.
 */

export type DigestRow = {
  id: string;
  title: string;
  createdAt: string;
  /** All fields below are pulled out of nodes.data (jsonb). */
  chatId: string;
  telegramChatId: string | null;
  periodStart: string;
  periodEnd: string;
  sourceTurnCount: number;
  model: string;
  agent: string;
  summary: string;
  topic: string | null;
  topicSlug: string | null;
};

export type TopicRow = {
  topic: string;
  topicSlug: string;
  digestCount: number;
  turnCount: number;
  firstSeen: string;
  lastSeen: string;
};

export async function listDigests(userId: string, limit = 25): Promise<DigestRow[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, userId),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
      ),
    )
    .orderBy(desc(nodes.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
      chatId: String(d.chat_id ?? ''),
      telegramChatId: d.telegram_chat_id ? String(d.telegram_chat_id) : null,
      periodStart: String(d.period_start ?? ''),
      periodEnd: String(d.period_end ?? ''),
      sourceTurnCount: Number(d.source_turn_count ?? 0),
      model: String(d.model ?? ''),
      agent: String(d.agent ?? ''),
      summary: String(d.summary ?? ''),
      topic: typeof d.topic === 'string' && d.topic.trim() ? String(d.topic) : null,
      topicSlug:
        typeof d.topic_slug === 'string' && d.topic_slug.trim()
          ? String(d.topic_slug)
          : null,
    };
  });
}

/**
 * Roll up emergent topics across all conversation_digest nodes:
 * count of digests, summed source turn count, first / last seen.
 * Useful for spotting the threads that recur in conversation over time.
 */
export async function listTopics(userId: string, limit = 25): Promise<TopicRow[]> {
  const rows = await db
    .select({
      topic: sql<string>`${nodes.data}->>'topic'`,
      topicSlug: sql<string>`${nodes.data}->>'topic_slug'`,
      digestCount: sql<number>`count(*)::int`,
      turnCount: sql<number>`coalesce(sum((${nodes.data}->>'source_turn_count')::int), 0)::int`,
      firstSeen: sql<Date>`min(${nodes.createdAt})`,
      lastSeen: sql<Date>`max(${nodes.createdAt})`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, userId),
        eq(nodes.type, 'note'),
        sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
        sql`${nodes.data} ? 'topic'`,
      ),
    )
    .groupBy(sql`${nodes.data}->>'topic'`, sql`${nodes.data}->>'topic_slug'`)
    .orderBy(sql`max(${nodes.createdAt}) desc`)
    .limit(limit);

  return rows
    .filter((r) => r.topic && r.topic.length > 0)
    .map((r) => ({
      topic: r.topic,
      topicSlug: r.topicSlug ?? '',
      digestCount: r.digestCount ?? 0,
      turnCount: r.turnCount ?? 0,
      // postgres-js returns aggregate timestamps (min/max of a
      // timestamptz column) as ISO strings, not Date objects, even
      // though Drizzle's `sql<Date>` type hint claims otherwise. The
      // `new Date(...)` coercion handles both shapes — string OR
      // Date — so this stays robust if the driver ever flips.
      firstSeen: new Date(r.firstSeen as unknown as string | Date).toISOString(),
      lastSeen: new Date(r.lastSeen as unknown as string | Date).toISOString(),
    }));
}

export type ChatRow = {
  id: string;
  title: string | null;
  username: string | null;
  telegramChatId: string;
  allowlistStatus: string;
  totalTurns: number;
  digested: number;
  undigested: number;
  lastActivity: string | null;
  responderAgentId: string | null;
};

export async function listTelegramChats(userId: string): Promise<ChatRow[]> {
  const rows = await db
    .select({
      id: telegramChats.id,
      title: telegramChats.title,
      username: telegramChats.username,
      telegramChatId: telegramChats.telegramChatId,
      allowlistStatus: telegramChats.allowlistStatus,
      lastMessageAt: telegramChats.lastMessageAt,
      responderAgentId: telegramChats.responderAgentId,
      totalTurns: sql<number>`count(${telegramMessages.id})::int`,
      digested: sql<number>`count(${telegramMessages.id}) filter (where ${telegramMessages.digestNodeId} is not null)::int`,
      undigested: sql<number>`count(${telegramMessages.id}) filter (where ${telegramMessages.digestNodeId} is null)::int`,
    })
    .from(telegramChats)
    .leftJoin(telegramMessages, eq(telegramMessages.chatId, telegramChats.id))
    .where(eq(telegramChats.userId, userId))
    .groupBy(telegramChats.id)
    .orderBy(desc(telegramChats.lastMessageAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    username: r.username,
    telegramChatId: r.telegramChatId,
    allowlistStatus: r.allowlistStatus,
    totalTurns: r.totalTurns ?? 0,
    digested: r.digested ?? 0,
    undigested: r.undigested ?? 0,
    lastActivity: r.lastMessageAt?.toISOString() ?? null,
    responderAgentId: r.responderAgentId,
  }));
}

export type AgentActivityRow = {
  id: string;
  slug: string;
  name: string;
  role: string;
  model: string;
  priority: number;
  enabled: boolean;
  lastUsedAt: string | null;
  usageCount: number;
};

export async function listAgentActivity(userId: string): Promise<AgentActivityRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      role: agents.role,
      model: agents.model,
      priority: agents.priority,
      enabled: agents.enabled,
      lastUsedAt: agents.lastUsedAt,
      usageCount: agents.usageCount,
    })
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(desc(agents.lastUsedAt));

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    role: r.role,
    model: r.model,
    priority: r.priority,
    enabled: r.enabled,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    usageCount: r.usageCount ?? 0,
  }));
}

export type FactRow = {
  id: string;
  content: string;
  kind: string;
  confidence: number;
  entityName: string | null;
  entityKind: string | null;
  sourceNodeId: string | null;
  sourceTitle: string | null;
  createdAt: string;
};

export async function listFacts(userId: string, limit = 25): Promise<FactRow[]> {
  const rows = await db
    .select({
      id: facts.id,
      content: facts.content,
      kind: facts.kind,
      confidence: facts.confidence,
      entityId: facts.entityId,
      entityName: entities.name,
      entityKind: entities.kind,
      sourceNodeId: facts.sourceNodeId,
      sourceTitle: nodes.title,
      createdAt: facts.createdAt,
    })
    .from(facts)
    .leftJoin(entities, eq(facts.entityId, entities.id))
    .leftJoin(nodes, eq(facts.sourceNodeId, nodes.id))
    .where(and(eq(facts.ownerId, userId), isNull(facts.validTo)))
    .orderBy(desc(facts.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    kind: r.kind as string,
    confidence: r.confidence,
    entityName: r.entityName,
    entityKind: r.entityKind,
    sourceNodeId: r.sourceNodeId,
    sourceTitle: r.sourceTitle,
    createdAt: r.createdAt.toISOString(),
  }));
}

export type ContentIndexCoverage = {
  total: number;
  indexed: number;
  byType: Array<{ type: string; total: number; indexed: number }>;
};

export async function contentIndexCoverage(userId: string): Promise<ContentIndexCoverage> {
  const rows = await db
    .select({
      type: nodes.type,
      total: sql<number>`count(*)::int`,
      indexed: sql<number>`count(*) filter (where ${nodes.embedding} is not null and ${nodes.data}->>'summary' is not null)::int`,
    })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, userId),
        sql`${nodes.type} <> 'branch'`,
        sql`${nodes.type} <> 'secret'`,
        // Exclude conversation-digest notes (they're derived, not source content).
        sql`not (${nodes.tags} @> ARRAY['conversation-digest']::text[])`,
      ),
    )
    .groupBy(nodes.type);

  let total = 0;
  let indexed = 0;
  const byType: ContentIndexCoverage['byType'] = [];
  for (const r of rows) {
    total += r.total ?? 0;
    indexed += r.indexed ?? 0;
    byType.push({ type: r.type as string, total: r.total ?? 0, indexed: r.indexed ?? 0 });
  }
  byType.sort((a, b) => b.total - a.total);
  return { total, indexed, byType };
}

export type PersonaNotesRow = {
  agentId: string;
  agentName: string;
  agentSlug: string;
  notes: PersonaNote[];
};

export async function listPersonaNotes(userId: string): Promise<PersonaNotesRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      personaNotes: agents.personaNotes,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, userId), eq(agents.enabled, true)))
    .orderBy(desc(agents.priority));

  return rows
    .map((r) => ({
      agentId: r.id,
      agentName: r.name,
      agentSlug: r.slug,
      notes: (r.personaNotes ?? []) as PersonaNote[],
    }))
    .filter((r) => r.notes.length > 0);
}

