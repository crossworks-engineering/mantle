import {
  and,
  db,
  desc,
  eq,
  gte,
  isNull,
  sql,
  emailAccounts,
  emailAttachments,
  emails,
  embeddingCache,
  entities,
  entityEdges,
  facts,
  heartbeatFires,
  heartbeats,
  nodes,
  pendingToolCalls,
  telegramChats,
  telegramMessages,
} from '@mantle/db';

/**
 * Brain + operations metrics for the dashboard at `/`. All owner-scoped,
 * mirroring lib/metrics.ts conventions (userId first, plain serializable
 * returns, `count(*)::int`). Several tables have no `owner_id` and are scoped
 * through a join (emails→email_accounts, telegram_messages→telegram_chats,
 * heartbeat_fires→heartbeats); `embedding_cache` is a global content-addressed
 * cache with no owner at all.
 */

const COUNT = sql<number>`count(*)::int`;

type Bucket = { key: string; count: number };

function buckets(rows: { key: string | null; count: number }[]): Bucket[] {
  return rows.map((r) => ({ key: r.key ?? '(none)', count: r.count }));
}
function sum(rows: { count: number }[]): number {
  return rows.reduce((a, r) => a + r.count, 0);
}

// ─── Brain counts (memory graph shape) ───────────────────────────────────────

export type BrainCounts = {
  nodesTotal: number;
  nodesByType: Bucket[];
  factsTotal: number;
  factsByKind: Bucket[];
  entitiesTotal: number;
  entitiesByKind: Bucket[];
  edgesTotal: number;
  edgesByRelation: Bucket[];
};

export async function brainCounts(userId: string): Promise<BrainCounts> {
  const [nodesByType, factsByKind, entitiesByKind, edgesByRelation] = await Promise.all([
    db
      .select({ key: nodes.type, count: COUNT })
      .from(nodes)
      .where(eq(nodes.ownerId, userId))
      .groupBy(nodes.type)
      .orderBy(desc(COUNT)),
    db
      .select({ key: facts.kind, count: COUNT })
      .from(facts)
      .where(and(eq(facts.ownerId, userId), isNull(facts.validTo)))
      .groupBy(facts.kind)
      .orderBy(desc(COUNT)),
    db
      .select({ key: entities.kind, count: COUNT })
      .from(entities)
      .where(eq(entities.ownerId, userId))
      .groupBy(entities.kind)
      .orderBy(desc(COUNT)),
    db
      .select({ key: entityEdges.relation, count: COUNT })
      .from(entityEdges)
      .where(and(eq(entityEdges.ownerId, userId), isNull(entityEdges.validTo)))
      .groupBy(entityEdges.relation)
      .orderBy(desc(COUNT)),
  ]);

  return {
    nodesTotal: sum(nodesByType),
    nodesByType: buckets(nodesByType as { key: string | null; count: number }[]),
    factsTotal: sum(factsByKind),
    factsByKind: buckets(factsByKind as { key: string | null; count: number }[]),
    entitiesTotal: sum(entitiesByKind),
    entitiesByKind: buckets(entitiesByKind as { key: string | null; count: number }[]),
    edgesTotal: sum(edgesByRelation),
    edgesByRelation: buckets(edgesByRelation as { key: string | null; count: number }[]),
  };
}

// ─── Graph integrity (duplicate-edge guard) ──────────────────────────────────

/** A health check, not a fixer. Counts active edges that share the same
 *  (source, target, relation) — i.e. duplicates. The extractor's
 *  delete-then-rebuild discipline (see architecture §9k) means this should
 *  stay 0; a non-zero value flags a regression in edge writing. The remedy is
 *  the one-shot `pnpm dedupe:edges --apply`, NOT a recurring auto-clean (which
 *  would mask the regression). */
export type GraphIntegrity = {
  /** Distinct (source, target, relation) groups with more than one row. */
  duplicateEdgeGroups: number;
  /** Total redundant rows across those groups (Σ count-1) — how many
   *  `dedupe:edges --apply` would remove. */
  redundantEdgeRows: number;
};

export async function graphIntegrity(userId: string): Promise<GraphIntegrity> {
  const result = await db.execute<{ dup_groups: number; redundant_rows: number }>(sql`
    SELECT count(*)::int AS dup_groups,
           coalesce(sum(c - 1), 0)::int AS redundant_rows
    FROM (
      SELECT count(*) AS c
      FROM ${entityEdges}
      WHERE ${entityEdges.ownerId} = ${userId} AND ${entityEdges.validTo} IS NULL
      GROUP BY ${entityEdges.sourceId}, ${entityEdges.targetId}, ${entityEdges.relation}
      HAVING count(*) > 1
    ) d
  `);
  const rows = (
    Array.isArray(result)
      ? result
      : (result as { rows?: Array<{ dup_groups: number; redundant_rows: number }> }).rows ?? []
  ) as Array<{ dup_groups: number; redundant_rows: number }>;
  const row = rows[0] ?? { dup_groups: 0, redundant_rows: 0 };
  return {
    duplicateEdgeGroups: Number(row.dup_groups ?? 0),
    redundantEdgeRows: Number(row.redundant_rows ?? 0),
  };
}

// ─── Vector / index coverage ─────────────────────────────────────────────────

export type VectorCounts = {
  nodesIndexed: number;
  nodesTotal: number;
  factsIndexed: number;
  factsTotal: number;
  entitiesIndexed: number;
  entitiesTotal: number;
  /** The headline: total embedded vectors across nodes + facts + entities. */
  vectorsTotal: number;
  /** Global content-addressed embedding cache (not owner-scoped). */
  embeddingCacheRows: number;
};

export async function vectorCounts(userId: string): Promise<VectorCounts> {
  const indexed = sql<number>`count(*) filter (where embedding is not null)::int`;
  const [nodeRow, factRow, entityRow, cacheRow] = await Promise.all([
    db
      .select({ total: COUNT, indexed })
      .from(nodes)
      .where(eq(nodes.ownerId, userId)),
    db
      .select({ total: COUNT, indexed })
      .from(facts)
      .where(and(eq(facts.ownerId, userId), isNull(facts.validTo))),
    db
      .select({ total: COUNT, indexed })
      .from(entities)
      .where(eq(entities.ownerId, userId)),
    db.select({ total: COUNT }).from(embeddingCache),
  ]);

  const nodesIndexed = nodeRow[0]?.indexed ?? 0;
  const factsIndexed = factRow[0]?.indexed ?? 0;
  const entitiesIndexed = entityRow[0]?.indexed ?? 0;
  return {
    nodesIndexed,
    nodesTotal: nodeRow[0]?.total ?? 0,
    factsIndexed,
    factsTotal: factRow[0]?.total ?? 0,
    entitiesIndexed,
    entitiesTotal: entityRow[0]?.total ?? 0,
    vectorsTotal: nodesIndexed + factsIndexed + entitiesIndexed,
    embeddingCacheRows: cacheRow[0]?.total ?? 0,
  };
}

// ─── Ingest time series (zero-filled, mirrors metrics.spendByDay) ────────────

export type IngestDay = {
  day: string; // YYYY-MM-DD
  total: number;
  byType: Record<string, number>;
};

export async function nodesCreatedByDay(userId: string, daysBack: number): Promise<IngestDay[]> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${nodes.createdAt}), 'YYYY-MM-DD')`,
      type: nodes.type,
      count: COUNT,
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, userId), gte(nodes.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${nodes.createdAt})`, nodes.type);

  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const m = byDay.get(r.day) ?? {};
    m[r.type as string] = r.count;
    byDay.set(r.day, m);
  }

  const out: IngestDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const m = byDay.get(key) ?? {};
    out.push({ day: key, total: Object.values(m).reduce((a, b) => a + b, 0), byType: m });
  }
  return out;
}

// ─── Email ops ───────────────────────────────────────────────────────────────

export type EmailStats = {
  total: number;
  unread: number;
  withAttachments: number;
  byAccount: { accountId: string; address: string; total: number; unread: number }[];
  latestSync: {
    accountId: string;
    address: string;
    status: string;
    finishedAt: string | null;
    ingested: number;
    scanned: number;
    error: string | null;
  }[];
};

type SyncRow = {
  account_id: string;
  address: string;
  status: string;
  finished_at: string | null;
  ingested: number;
  scanned: number;
  error: string | null;
};

export async function emailStats(userId: string): Promise<EmailStats> {
  const [totals, byAccount, syncResult] = await Promise.all([
    db
      .select({
        total: COUNT,
        unread: sql<number>`count(*) filter (where ${emails.isRead} = false)::int`,
        withAttachments: sql<number>`count(*) filter (where ${emails.hasAttachments} = true)::int`,
      })
      .from(emails)
      .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
      .where(eq(emailAccounts.userId, userId)),
    db
      .select({
        accountId: emails.accountId,
        address: emailAccounts.address,
        total: COUNT,
        unread: sql<number>`count(*) filter (where ${emails.isRead} = false)::int`,
      })
      .from(emails)
      .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
      .where(eq(emailAccounts.userId, userId))
      .groupBy(emails.accountId, emailAccounts.address)
      .orderBy(desc(COUNT)),
    db.execute<SyncRow>(sql`
      SELECT DISTINCT ON (sr.account_id)
        sr.account_id, ea.address, sr.status::text AS status,
        sr.finished_at, sr.ingested, sr.scanned, sr.error
      FROM sync_runs sr
      JOIN email_accounts ea ON ea.id = sr.account_id
      WHERE ea.user_id = ${userId}
      ORDER BY sr.account_id, sr.started_at DESC
    `),
  ]);

  const syncRows = (
    Array.isArray(syncResult) ? syncResult : (syncResult as { rows?: SyncRow[] }).rows ?? []
  ) as SyncRow[];

  return {
    total: totals[0]?.total ?? 0,
    unread: totals[0]?.unread ?? 0,
    withAttachments: totals[0]?.withAttachments ?? 0,
    byAccount,
    latestSync: syncRows.map((r) => ({
      accountId: r.account_id,
      address: r.address,
      status: r.status,
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      ingested: Number(r.ingested),
      scanned: Number(r.scanned),
      error: r.error,
    })),
  };
}

// ─── Telegram ops ────────────────────────────────────────────────────────────

export type TelegramStats = {
  messagesTotal: number;
  unprocessed: number;
  chatsByStatus: Bucket[];
};

export async function telegramStats(userId: string): Promise<TelegramStats> {
  const [msgTotals, chatsByStatus] = await Promise.all([
    db
      .select({
        total: COUNT,
        unprocessed: sql<number>`count(*) filter (where ${telegramMessages.processed} = false)::int`,
      })
      .from(telegramMessages)
      .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
      .where(eq(telegramChats.userId, userId)),
    db
      .select({ key: telegramChats.allowlistStatus, count: COUNT })
      .from(telegramChats)
      .where(eq(telegramChats.userId, userId))
      .groupBy(telegramChats.allowlistStatus),
  ]);

  return {
    messagesTotal: msgTotals[0]?.total ?? 0,
    unprocessed: msgTotals[0]?.unprocessed ?? 0,
    chatsByStatus: buckets(chatsByStatus as { key: string | null; count: number }[]),
  };
}

// ─── Heartbeats ──────────────────────────────────────────────────────────────

export type HeartbeatStats = {
  byStatus: Bucket[];
  recentFiresByDisposition: Bucket[];
};

export async function heartbeatStats(userId: string, daysBack = 7): Promise<HeartbeatStats> {
  const since = new Date(Date.now() - daysBack * 86_400_000);
  const [byStatus, fires] = await Promise.all([
    db
      .select({ key: heartbeats.status, count: COUNT })
      .from(heartbeats)
      .where(eq(heartbeats.ownerId, userId))
      .groupBy(heartbeats.status),
    db
      .select({ key: heartbeatFires.disposition, count: COUNT })
      .from(heartbeatFires)
      .innerJoin(heartbeats, eq(heartbeatFires.heartbeatId, heartbeats.id))
      .where(and(eq(heartbeats.ownerId, userId), gte(heartbeatFires.firedAt, since)))
      .groupBy(heartbeatFires.disposition)
      .orderBy(desc(COUNT)),
  ]);

  return {
    byStatus: buckets(byStatus as { key: string | null; count: number }[]),
    recentFiresByDisposition: buckets(fires as { key: string | null; count: number }[]),
  };
}

// ─── Pending tool calls ──────────────────────────────────────────────────────

export async function pendingToolCount(userId: string): Promise<number> {
  const rows = await db
    .select({ count: COUNT })
    .from(pendingToolCalls)
    .where(and(eq(pendingToolCalls.ownerId, userId), eq(pendingToolCalls.status, 'pending')));
  return rows[0]?.count ?? 0;
}

// ─── Storage bytes (attachment content in MinIO; owner-scoped via account) ────

export async function attachmentBytes(userId: string): Promise<number> {
  const rows = await db
    .select({ bytes: sql<number>`coalesce(sum(${emailAttachments.sizeBytes}), 0)::bigint` })
    .from(emailAttachments)
    .innerJoin(emails, eq(emailAttachments.emailId, emails.id))
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(eq(emailAccounts.userId, userId));
  return Number(rows[0]?.bytes ?? 0);
}
