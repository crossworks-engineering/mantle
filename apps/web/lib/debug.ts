import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  db,
  agents,
  entities,
  entityEdges,
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

/** Pagination + free-text search options for the debug list helpers. */
export type ListOpts = { limit?: number; offset?: number; query?: string };

/** Shared WHERE for conversation-digest note queries. */
function digestConds(userId: string, query?: string) {
  const conds = [
    eq(nodes.ownerId, userId),
    eq(nodes.type, 'note'),
    sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
  ];
  if (query?.trim()) {
    const q = `%${query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'summary' ilike ${q}`,
      sql`${nodes.data}->>'topic' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  return conds;
}

export async function listDigests(userId: string, opts: ListOpts = {}): Promise<DigestRow[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .where(and(...digestConds(userId, opts.query)))
    .orderBy(desc(nodes.createdAt))
    .limit(opts.limit ?? 25)
    .offset(opts.offset ?? 0);

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

export async function countDigests(userId: string, opts: { query?: string } = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...digestConds(userId, opts.query)));
  return row?.n ?? 0;
}

/**
 * Roll up emergent topics across all conversation_digest nodes:
 * count of digests, summed source turn count, first / last seen.
 * Useful for spotting the threads that recur in conversation over time.
 */
/** Shared WHERE for topic aggregation queries. */
function topicConds(userId: string, query?: string) {
  const conds = [
    eq(nodes.ownerId, userId),
    eq(nodes.type, 'note'),
    sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
    sql`${nodes.data} ? 'topic'`,
  ];
  if (query?.trim()) {
    conds.push(sql`${nodes.data}->>'topic' ilike ${`%${query.trim()}%`}`);
  }
  return conds;
}

export async function listTopics(userId: string, opts: ListOpts = {}): Promise<TopicRow[]> {
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
    .where(and(...topicConds(userId, opts.query)))
    .groupBy(sql`${nodes.data}->>'topic'`, sql`${nodes.data}->>'topic_slug'`)
    .orderBy(sql`max(${nodes.createdAt}) desc`)
    .limit(opts.limit ?? 25)
    .offset(opts.offset ?? 0);

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

export async function countTopics(userId: string, opts: { query?: string } = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${nodes.data}->>'topic')::int` })
    .from(nodes)
    .where(and(...topicConds(userId, opts.query)));
  return row?.n ?? 0;
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

/** Shared WHERE for telegram chat queries. */
function chatConds(userId: string, query?: string) {
  const conds = [eq(telegramChats.userId, userId)];
  if (query?.trim()) {
    const q = `%${query.trim()}%`;
    const c = or(
      ilike(telegramChats.title, q),
      ilike(telegramChats.username, q),
      ilike(telegramChats.telegramChatId, q),
    );
    if (c) conds.push(c);
  }
  return conds;
}

export async function listTelegramChats(userId: string, opts: ListOpts = {}): Promise<ChatRow[]> {
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
    .where(and(...chatConds(userId, opts.query)))
    .groupBy(telegramChats.id)
    .orderBy(desc(telegramChats.lastMessageAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

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

export async function countTelegramChats(
  userId: string,
  opts: { query?: string } = {},
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(telegramChats)
    .where(and(...chatConds(userId, opts.query)));
  return row?.n ?? 0;
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

/** Shared WHERE for fact queries. */
function factConds(userId: string, query?: string) {
  const conds = [eq(facts.ownerId, userId), isNull(facts.validTo)];
  if (query?.trim()) {
    const q = `%${query.trim()}%`;
    const c = or(ilike(facts.content, q), ilike(entities.name, q));
    if (c) conds.push(c);
  }
  return conds;
}

export async function listFacts(userId: string, opts: ListOpts = {}): Promise<FactRow[]> {
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
    .where(and(...factConds(userId, opts.query)))
    .orderBy(desc(facts.createdAt))
    .limit(opts.limit ?? 25)
    .offset(opts.offset ?? 0);

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

export async function countFacts(userId: string, opts: { query?: string } = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(facts)
    .leftJoin(entities, eq(facts.entityId, entities.id))
    .where(and(...factConds(userId, opts.query)));
  return row?.n ?? 0;
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

/**
 * Awareness of duplicate graph edges. Going forward the extractor rebuilds
 * edges per node (idempotent), but content re-edited *before* that fix may
 * carry historical duplicate `mentioned_in` / `references` rows. This surfaces
 * the count + a few labelled samples so the operator knows to run
 * `pnpm dedupe:edges`. Read-only — cleaning stays the deliberate CLI tool.
 */
export type DuplicateEdgeStats = {
  groups: number; // logical edges with >1 row
  redundant: number; // rows that could be removed (sum of count-1)
  samples: { relation: string; label: string; count: number }[];
};

const DEDUPE_RELATIONS = ['mentioned_in', 'references'];

export async function duplicateEdgeStats(userId: string): Promise<DuplicateEdgeStats> {
  const dups = db
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(entityEdges)
    .where(and(eq(entityEdges.ownerId, userId), inArray(entityEdges.relation, DEDUPE_RELATIONS)))
    .groupBy(
      entityEdges.relation,
      entityEdges.sourceId,
      entityEdges.sourceKind,
      entityEdges.targetId,
      entityEdges.targetKind,
    )
    .having(sql`count(*) > 1`)
    .as('dups');

  const [agg] = await db
    .select({
      groups: sql<number>`count(*)::int`,
      redundant: sql<number>`coalesce(sum(${dups.n} - 1), 0)::int`,
    })
    .from(dups);

  const groups = agg?.groups ?? 0;
  const redundant = agg?.redundant ?? 0;
  if (groups === 0) return { groups: 0, redundant: 0, samples: [] };

  const sampleRows = await db
    .select({
      relation: entityEdges.relation,
      sourceId: entityEdges.sourceId,
      sourceKind: entityEdges.sourceKind,
      targetId: entityEdges.targetId,
      targetKind: entityEdges.targetKind,
      count: sql<number>`count(*)::int`,
    })
    .from(entityEdges)
    .where(and(eq(entityEdges.ownerId, userId), inArray(entityEdges.relation, DEDUPE_RELATIONS)))
    .groupBy(
      entityEdges.relation,
      entityEdges.sourceId,
      entityEdges.sourceKind,
      entityEdges.targetId,
      entityEdges.targetKind,
    )
    .having(sql`count(*) > 1`)
    .orderBy(desc(sql`count(*)`))
    .limit(8);

  // Resolve ids to human labels (entity name / node title).
  const entityIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const r of sampleRows) {
    (r.sourceKind === 'entity' ? entityIds : nodeIds).add(r.sourceId);
    (r.targetKind === 'entity' ? entityIds : nodeIds).add(r.targetId);
  }
  const [ents, nds] = await Promise.all([
    entityIds.size
      ? db
          .select({ id: entities.id, name: entities.name })
          .from(entities)
          .where(inArray(entities.id, [...entityIds]))
      : Promise.resolve([] as { id: string; name: string }[]),
    nodeIds.size
      ? db
          .select({ id: nodes.id, title: nodes.title })
          .from(nodes)
          .where(inArray(nodes.id, [...nodeIds]))
      : Promise.resolve([] as { id: string; title: string }[]),
  ]);
  const entName = new Map(ents.map((e) => [e.id, e.name]));
  const nodeTitle = new Map(nds.map((n) => [n.id, n.title]));
  const label = (id: string, kind: string) =>
    kind === 'entity' ? (entName.get(id) ?? '(deleted entity)') : (nodeTitle.get(id) ?? '(deleted)');

  const samples = sampleRows.map((r) => ({
    relation: r.relation,
    label: `${label(r.sourceId, r.sourceKind)} → ${label(r.targetId, r.targetKind)}`,
    count: r.count,
  }));

  return { groups, redundant, samples };
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

