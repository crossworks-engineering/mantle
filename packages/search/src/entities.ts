/**
 * Entity-anchored retrieval helpers — the graph axis of the profile layer.
 *
 * Three primitives:
 *   searchEntities  — resolve a name/alias to entity row(s) by exact /
 *                     trigram / vector fallback.
 *   entityNeighbors — first-hop neighbour walk over entity_edges (both
 *                     directions), optionally filtered by relation.
 *   entityFacts     — facts attached to an entity (current by default,
 *                     opt-in to include superseded history).
 *   entityMentions  — content_store nodes that mention this entity.
 *
 *   graphPath       — multi-hop traversal over the entity↔entity graph
 *                     (recursive CTE): reachable neighbourhood within N hops,
 *                     or the shortest path(s) between two entities.
 *
 * entityNeighbors stays the simple one-hop primitive; graphPath is the
 * variable-depth walker for "how is X connected to Y?" / "what's within 2
 * hops of Lister?". Both read the same entity_edges table.
 */

import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  db,
  entities,
  entityEdges,
  facts,
  nodes,
  type Entity,
  type Fact,
} from '@mantle/db';

export type EntitySearchOptions = {
  ownerId: string;
  q: string;
  kind?: string;
  /** Min similarity for trigram match (0-1). Default 0.3. */
  minSimilarity?: number;
  limit?: number;
};

export type EntityHit = Entity & {
  /** Trigram similarity score, 0-1. Higher = closer name match. */
  similarity: number;
};

/**
 * Resolve a name/alias to entities. Strategy:
 *   1. Exact (case-insensitive) name OR alias hit — `similarity=1`.
 *   2. Trigram fuzzy on `name`, filtered to `>= minSimilarity`.
 *
 * Embedding fallback isn't here — the extractor already uses it during
 * ingest; at query time, a fuzzy text match is plenty for "who does
 * 'jason' mean?"-style lookups. Add later if recall is missing.
 */
export async function searchEntities(opts: EntitySearchOptions): Promise<EntityHit[]> {
  const trimmed = opts.q.trim();
  if (!trimmed) return [];
  const minSim = opts.minSimilarity ?? 0.3;
  const limit = opts.limit ?? 25;

  // Exact match first — covers "Sarah" -> the Sarah entity even when
  // there are similar names in the store.
  const exactConds: SQL[] = [
    eq(entities.ownerId, opts.ownerId),
    sql`(lower(${entities.name}) = lower(${trimmed}) or ${trimmed} = any(${entities.aliases}))`,
  ];
  if (opts.kind) exactConds.push(eq(entities.kind, opts.kind));
  const exacts = await db
    .select()
    .from(entities)
    .where(and(...exactConds))
    .limit(limit);
  if (exacts.length >= limit) {
    return exacts.map((e) => ({ ...e, similarity: 1 }));
  }

  // Trigram fuzzy fill the rest.
  const seen = new Set(exacts.map((e) => e.id));
  const fuzzyConds: SQL[] = [
    eq(entities.ownerId, opts.ownerId),
    sql`similarity(${entities.name}, ${trimmed}) >= ${minSim}`,
  ];
  if (opts.kind) fuzzyConds.push(eq(entities.kind, opts.kind));
  const fuzzy = await db
    .select({ row: entities, sim: sql<number>`similarity(${entities.name}, ${trimmed})` })
    .from(entities)
    .where(and(...fuzzyConds))
    .orderBy(sql`similarity(${entities.name}, ${trimmed}) desc`)
    .limit(limit - exacts.length + seen.size);

  const hits: EntityHit[] = exacts.map((e) => ({ ...e, similarity: 1 }));
  for (const { row, sim } of fuzzy) {
    if (seen.has(row.id)) continue;
    hits.push({ ...row, similarity: sim ?? 0 });
    if (hits.length >= limit) break;
  }
  return hits;
}

export type NeighborOptions = {
  ownerId: string;
  entityId: string;
  /** Only follow edges with this relation. Default = all. */
  relation?: string;
  /** Include outbound, inbound, or both. Default = both. */
  direction?: 'in' | 'out' | 'both';
  /** Include currently-true edges only (valid_to IS NULL) when true. */
  currentOnly?: boolean;
  limit?: number;
};

export type Neighbor = {
  entity: Entity;
  relation: string;
  direction: 'in' | 'out';
  validFrom: Date | null;
  validTo: Date | null;
  edgeId: string;
};

/**
 * First-hop entity↔entity neighbours. Returns at most `limit` rows across
 * both directions (outbound + inbound), capped each at limit/2 so an entity
 * with thousands of inbound edges doesn't crowd out outbound ones.
 */
export async function entityNeighbors(opts: NeighborOptions): Promise<Neighbor[]> {
  const dir = opts.direction ?? 'both';
  const limit = opts.limit ?? 50;
  const half = dir === 'both' ? Math.max(1, Math.ceil(limit / 2)) : limit;

  const baseConds = [eq(entityEdges.ownerId, opts.ownerId)];
  if (opts.relation) baseConds.push(eq(entityEdges.relation, opts.relation));
  if (opts.currentOnly) baseConds.push(isNull(entityEdges.validTo));

  const out: Neighbor[] = [];

  if (dir === 'out' || dir === 'both') {
    const rows = await db
      .select({
        edgeId: entityEdges.id,
        relation: entityEdges.relation,
        validFrom: entityEdges.validFrom,
        validTo: entityEdges.validTo,
        entity: entities,
      })
      .from(entityEdges)
      .innerJoin(
        entities,
        and(eq(entityEdges.targetId, entities.id), eq(entityEdges.targetKind, sql`'entity'`)),
      )
      .where(
        and(
          ...baseConds,
          eq(entityEdges.sourceId, opts.entityId),
          eq(entityEdges.sourceKind, 'entity'),
        ),
      )
      .limit(half);
    for (const r of rows) {
      out.push({
        entity: r.entity,
        relation: r.relation,
        direction: 'out',
        validFrom: r.validFrom,
        validTo: r.validTo,
        edgeId: r.edgeId,
      });
    }
  }

  if (dir === 'in' || dir === 'both') {
    const rows = await db
      .select({
        edgeId: entityEdges.id,
        relation: entityEdges.relation,
        validFrom: entityEdges.validFrom,
        validTo: entityEdges.validTo,
        entity: entities,
      })
      .from(entityEdges)
      .innerJoin(
        entities,
        and(eq(entityEdges.sourceId, entities.id), eq(entityEdges.sourceKind, sql`'entity'`)),
      )
      .where(
        and(
          ...baseConds,
          eq(entityEdges.targetId, opts.entityId),
          eq(entityEdges.targetKind, 'entity'),
        ),
      )
      .limit(half);
    for (const r of rows) {
      out.push({
        entity: r.entity,
        relation: r.relation,
        direction: 'in',
        validFrom: r.validFrom,
        validTo: r.validTo,
        edgeId: r.edgeId,
      });
    }
  }

  return out;
}

export type FactsOptions = {
  ownerId: string;
  entityId: string;
  /** Include facts whose validTo is set (history). Default false = current only. */
  includeRetired?: boolean;
  limit?: number;
};

export async function entityFacts(opts: FactsOptions): Promise<Fact[]> {
  const conds: SQL[] = [eq(facts.ownerId, opts.ownerId), eq(facts.entityId, opts.entityId)];
  if (!opts.includeRetired) conds.push(isNull(facts.validTo));
  const rows = await db
    .select()
    .from(facts)
    .where(and(...conds))
    .orderBy(sql`coalesce(${facts.validFrom}, ${facts.createdAt}) desc`)
    .limit(opts.limit ?? 50);
  return rows;
}

export type MentionsOptions = {
  ownerId: string;
  entityId: string;
  limit?: number;
};

export type EntityMention = {
  nodeId: string;
  title: string;
  type: string;
  edgeAt: Date;
  summary: string | null;
};

/**
 * Content_store nodes the entity has been mentioned in. Joins via
 * `entity_edges WHERE source_kind='entity' AND target_kind='node' AND
 * relation='mentioned_in'` (the shape the extractor writes).
 */
export async function entityMentions(opts: MentionsOptions): Promise<EntityMention[]> {
  const rows = await db
    .select({
      nodeId: nodes.id,
      title: nodes.title,
      type: nodes.type,
      data: nodes.data,
      edgeAt: entityEdges.validFrom,
      edgeCreated: entityEdges.createdAt,
    })
    .from(entityEdges)
    .innerJoin(nodes, eq(entityEdges.targetId, nodes.id))
    .where(
      and(
        eq(entityEdges.ownerId, opts.ownerId),
        eq(entityEdges.sourceId, opts.entityId),
        eq(entityEdges.sourceKind, 'entity'),
        eq(entityEdges.targetKind, 'node'),
        or(eq(entityEdges.relation, 'mentioned_in'), eq(entityEdges.relation, 'mentions'))!,
      ),
    )
    .orderBy(sql`coalesce(${entityEdges.validFrom}, ${entityEdges.createdAt}) desc`)
    .limit(opts.limit ?? 50);

  return rows.map((r) => ({
    nodeId: r.nodeId,
    title: r.title,
    type: r.type,
    edgeAt: r.edgeAt ?? r.edgeCreated,
    summary:
      typeof (r.data as Record<string, unknown> | null)?.summary === 'string'
        ? ((r.data as Record<string, unknown>).summary as string)
        : null,
  }));
}

export type GraphPathOptions = {
  ownerId: string;
  /** Start entity id. */
  fromId: string;
  /** Optional target entity id. Given → return shortest path(s) to it;
   *  omitted → return every entity reachable within maxDepth. */
  toId?: string;
  /** Max hops to walk. Default 3, hard-capped at 6 to bound the CTE. */
  maxDepth?: number;
  /** Only traverse edges with these relation verbs (any, when omitted). */
  relations?: string[];
  /** Follow edge direction (subject→object only) vs. treat the graph as
   *  undirected for connectivity. Default false (undirected) — best for
   *  "how are these connected?". */
  directed?: boolean;
  /** Max result rows. Default 50, capped 200. */
  limit?: number;
};

export type GraphHop = { name: string; kind: string; relation: string };
export type GraphPathResult = {
  /** The reached entity (the path's endpoint). */
  entity: Entity;
  /** Hop count from the start entity. */
  depth: number;
  /** The walk start→end as hops: each carries the relation traversed INTO it
   *  and the entity landed on. Reads as a sentence chain. */
  path: GraphHop[];
};

/**
 * Multi-hop traversal over the entity↔entity edge graph via a recursive CTE.
 * Only walks edges where BOTH endpoints are entities (source_kind = target_kind
 * = 'entity'), so `mentioned_in` (entity→node) and `references` (node→node)
 * never leak in — this is the *knowledge* graph, not the mention graph.
 *
 * Cycle-safe (never revisits a node on a path). Undirected by default so
 * "Sarah ── employed_by ──> Lister <── supplies ── Acme" connects Sarah↔Acme.
 * The walk returns id/relation arrays; entity names are resolved in one
 * follow-up query and assembled into readable hop chains.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new Error(`graphPath: ${field} is not a uuid`);
  return v;
}

export async function graphPath(opts: GraphPathOptions): Promise<GraphPathResult[]> {
  const maxDepth = Math.min(Math.max(1, Math.floor(opts.maxDepth ?? 3)), 6);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const relFilter =
    opts.relations && opts.relations.length > 0 ? opts.relations : null;

  // This runs via postgres.js's SIMPLE query protocol (db.$client.unsafe().
  // simple()), NOT drizzle's db.execute — which uses the extended protocol
  // (Parse/Bind/Execute). Under the extended protocol, a recursive-CTE array
  // column's type isn't pinned at parse time, so the cycle guard
  // `= any(path_ids)` fails with "op ANY/ALL requires array on right side";
  // the simple protocol (what psql uses) resolves it fine. Because the simple
  // protocol takes no bind params, every value is INLINED — injection-safe
  // because all are validated: ids must match a strict UUID regex, depth/limit
  // are clamped ints, and relation verbs are reduced to [a-z0-9_]
  // (sanitiseRelation already guarantees this; re-enforced here).
  const fromId = assertUuid(opts.fromId, 'fromId');
  const ownerId = assertUuid(opts.ownerId, 'ownerId');
  const toId = opts.toId ? assertUuid(opts.toId, 'toId') : null;
  const relList = relFilter
    ? relFilter
        .map((r) => r.toLowerCase().replace(/[^a-z0-9_]/g, ''))
        .filter((r) => r.length > 0)
    : null;
  const relCond =
    relList && relList.length > 0
      ? `and e.relation in (${relList.map((r) => `'${r}'`).join(',')})`
      : '';
  const reverseLeg = opts.directed
    ? ''
    : `union all
       select e.source_id as other, e.relation
       from entity_edges e
       where e.owner_id = '${ownerId}'::uuid
         and e.source_kind = 'entity' and e.target_kind = 'entity'
         and e.target_id = w.node_id ${relCond}`;

  const queryText = `
    with recursive walk as (
      select s.id as node_id, array[s.id] as path_ids, '{}'::text[] as rels, 0 as depth
      from (select '${fromId}'::uuid as id) s
      union all
      select nxt.other, w.path_ids || nxt.other, w.rels || nxt.relation, w.depth + 1
      from walk w
      cross join lateral (
        select e.target_id as other, e.relation
        from entity_edges e
        where e.owner_id = '${ownerId}'::uuid
          and e.source_kind = 'entity' and e.target_kind = 'entity'
          and e.source_id = w.node_id ${relCond}
        ${reverseLeg}
      ) nxt
      where w.depth < ${maxDepth}
        and not (nxt.other = any(w.path_ids))
    )
    select distinct on (node_id) node_id, path_ids, rels, depth
    from walk
    where depth > 0 ${toId ? `and node_id = '${toId}'::uuid` : ''}
    order by node_id, depth asc
    limit ${limit}`;

  // Simple protocol (see note above) — the raw postgres.js client, no params.
  const client = (db as unknown as {
    $client: { unsafe: (q: string) => { simple: () => Promise<unknown[]> } };
  }).$client;
  const rows = await client.unsafe(queryText).simple();

  const raw = (rows as unknown as Array<{
    node_id: string;
    path_ids: string[];
    rels: string[];
    depth: number;
  }>);
  if (raw.length === 0) return [];

  // Resolve every entity id that appears in any path, in one query.
  const allIds = new Set<string>();
  for (const r of raw) for (const id of r.path_ids) allIds.add(id);
  const entityRows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.ownerId, opts.ownerId), inArray(entities.id, Array.from(allIds))));
  const byId = new Map(entityRows.map((e) => [e.id, e]));

  const results: GraphPathResult[] = [];
  for (const r of raw) {
    const endpoint = byId.get(r.node_id);
    if (!endpoint) continue;
    // path_ids[0] is the start; each subsequent id pairs with rels[i-1].
    const path: GraphHop[] = [];
    for (let i = 1; i < r.path_ids.length; i++) {
      const ent = byId.get(r.path_ids[i]!);
      if (!ent) continue;
      path.push({ name: ent.name, kind: ent.kind, relation: r.rels[i - 1] ?? '' });
    }
    results.push({ entity: endpoint, depth: r.depth, path });
  }
  // Shortest paths first.
  results.sort((a, b) => a.depth - b.depth);
  return results;
}

/** A relationship triple, names resolved — "Cross Works Engineering banks_with
 *  Nedbank". The graph axis as a readable line for the prompt. */
export type RelationTriple = {
  subjectId: string;
  subject: string;
  relation: string;
  objectId: string;
  object: string;
};

/**
 * Relation edges touching ANY of `entityIds` — the 1-hop graph neighbourhood of
 * the turn's entities, batched into one query. This is the read-path use of the
 * knowledge graph the design always promised ("expand each result's entity
 * neighbourhood for context", memory.md §4.3): vector search finds the relevant
 * facts, this surfaces how their entities relate — which vectors structurally
 * cannot. Excludes `mentioned_in` (co-occurrence, not a real relationship) and
 * retired edges. Deduped, capped.
 */
export async function entityRelationsFor(
  ownerId: string,
  entityIds: string[],
  opts?: { limit?: number },
): Promise<RelationTriple[]> {
  if (entityIds.length === 0) return [];
  const limit = opts?.limit ?? 12;
  const edges = await db
    .select({
      sourceId: entityEdges.sourceId,
      targetId: entityEdges.targetId,
      relation: entityEdges.relation,
    })
    .from(entityEdges)
    .where(
      and(
        eq(entityEdges.ownerId, ownerId),
        eq(entityEdges.sourceKind, 'entity'),
        eq(entityEdges.targetKind, 'entity'),
        ne(entityEdges.relation, 'mentioned_in'),
        isNull(entityEdges.validTo),
        or(inArray(entityEdges.sourceId, entityIds), inArray(entityEdges.targetId, entityIds)),
      ),
    )
    .limit(limit * 3); // pool — deduped below to `limit`
  if (edges.length === 0) return [];

  const ids = Array.from(new Set(edges.flatMap((e) => [e.sourceId, e.targetId])));
  const ents = await db
    .select({ id: entities.id, name: entities.name })
    .from(entities)
    .where(and(eq(entities.ownerId, ownerId), inArray(entities.id, ids)));
  const nameById = new Map(ents.map((e) => [e.id, e.name]));

  const seen = new Set<string>();
  const out: RelationTriple[] = [];
  for (const e of edges) {
    const subject = nameById.get(e.sourceId);
    const object = nameById.get(e.targetId);
    if (!subject || !object) continue;
    const key = `${e.sourceId}|${e.relation}|${e.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subjectId: e.sourceId, subject, relation: e.relation, objectId: e.targetId, object });
    if (out.length >= limit) break;
  }
  return out;
}
