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
 *                     (the mantle_graph_walk / mantle_graph_path functions):
 *                     reachable neighbourhood within N hops, or the shortest
 *                     path between two entities.
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
  readOnlyTransaction,
  type Entity,
  type Fact,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { pgArrayLiteral } from './pg';

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
 * 'alex' mean?"-style lookups. Add later if recall is missing.
 */
export async function searchEntities(opts: EntitySearchOptions): Promise<EntityHit[]> {
  const trimmed = opts.q.trim();
  if (!trimmed) return [];
  const minSim = opts.minSimilarity ?? 0.3;
  const limit = opts.limit ?? 25;

  // Exact match first — covers "Sarah" -> the Sarah entity even when
  // there are similar names in the store.
  // The alias branch uses the containment form `aliases @> array[q]` so the
  // array GIN (entities_aliases_gin_idx) serves it — the scalar `q = any(...)`
  // form is not indexable by that opclass (verified via EXPLAIN). lower(name) is
  // covered by entities_owner_lname_kind_uq.
  const exactConds: SQL[] = [
    eq(entities.ownerId, opts.ownerId),
    sql`(lower(${entities.name}) = lower(${trimmed}) or ${entities.aliases} @> array[${trimmed}]::text[])`,
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
  // Let the trigram GIN (entities_name_trgm_idx) prefilter with the `%`
  // operator instead of computing similarity() over every same-owner row. `%`
  // uses pg_trgm's default 0.3 threshold, so it's only a safe superset of the
  // `>= minSim` filter when minSim is at least 0.3 — below that we keep the
  // pure (unindexed) predicate so recall isn't silently clipped.
  const PG_TRGM_DEFAULT_THRESHOLD = 0.3;
  if (minSim >= PG_TRGM_DEFAULT_THRESHOLD) {
    fuzzyConds.push(sql`${entities.name} % ${trimmed}`);
  }
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
  /** Node types the caller may not see (a team surface). When set, a fact is
   *  kept only when its source node exists and is not of these types: a fact
   *  with no source came from the owner's own chats, so it stays hidden too. */
  excludeSourceTypes?: readonly string[];
};

export async function entityFacts(opts: FactsOptions): Promise<Fact[]> {
  const conds: SQL[] = [eq(facts.ownerId, opts.ownerId), eq(facts.entityId, opts.entityId)];
  if (!opts.includeRetired) conds.push(isNull(facts.validTo));
  if (opts.excludeSourceTypes) conds.push(visibleFactSource(opts.excludeSourceTypes));
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
  /** Node types to leave out (a team surface's hidden types). */
  excludeTypes?: readonly string[];
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
        opts.excludeTypes?.length
          ? sql`${nodes.type}::text <> all(${pgArrayLiteral([...opts.excludeTypes])}::text[])`
          : undefined,
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
  /** Max hops to walk. Default 3, clamped to 1..6. */
  maxDepth?: number;
  /** Only traverse edges with these relation verbs (any, when omitted). */
  relations?: string[];
  /** Follow edge direction (subject→object only) vs. treat the graph as
   *  undirected for connectivity. Default false (undirected) — best for
   *  "how are these connected?". */
  directed?: boolean;
  /** Max result rows, nearest first. Default 50, capped 200. */
  limit?: number;
  /** Walk only edges still true (valid_to is null). Default true. */
  currentOnly?: boolean;
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

function assertUuid(v: string, field: string): string {
  if (!UUID_RE.test(v)) throw new Error(`graphPath: ${field} is not a uuid`);
  return v;
}

/**
 * Multi-hop traversal over the entity<->entity edge graph: the database's
 * mantle_graph_walk / mantle_graph_path (migration 0394), breadth first,
 * each entity visited once, so the cost grows with the entities and edges
 * touched, not with the number of paths. Only walks edges where BOTH
 * endpoints are entities (source_kind = target_kind = 'entity'), so
 * `mentioned_in` (entity->node) and `references` (node->node) never leak
 * in: this is the *knowledge* graph, not the mention graph. A retired edge
 * (valid_to set) is not walked unless currentOnly is false.
 *
 * Undirected by default so "Sarah -- employed_by --> Lister <-- supplies --
 * Acme" connects Sarah and Acme. Of two shortest paths the function keeps
 * the one first when the hops are compared from the start (verb, then
 * entity id). Rows come nearest first, so `limit` keeps the nearest
 * entities. The walk runs in a READ ONLY transaction with bound
 * parameters; entity names are resolved in one follow-up query and
 * assembled into readable hop chains.
 */
export async function graphPath(opts: GraphPathOptions): Promise<GraphPathResult[]> {
  const ownerId = assertUuid(opts.ownerId, 'ownerId');
  const fromId = assertUuid(opts.fromId, 'fromId');
  const toId = opts.toId ? assertUuid(opts.toId, 'toId') : null;
  const relations = opts.relations && opts.relations.length > 0 ? opts.relations : null;
  const rels = relations ? sql`${pgArrayLiteral(relations)}::text[]` : sql`null::text[]`;
  const depth = Math.floor(opts.maxDepth ?? 3);
  const limit = Math.floor(opts.limit ?? 50);
  const directed = opts.directed ?? false;
  const currentOnly = opts.currentOnly ?? true;
  const call = toId
    ? sql`public.mantle_graph_path(${ownerId}::uuid, ${fromId}::uuid, ${toId}::uuid,
        ${depth}::int, ${rels}, ${directed}::boolean, ${currentOnly}::boolean)`
    : sql`public.mantle_graph_walk(${ownerId}::uuid, ${fromId}::uuid, ${depth}::int,
        ${rels}, ${directed}::boolean, ${currentOnly}::boolean, ${limit}::int)`;
  const rows = (await readOnlyTransaction((tx) =>
    tx.execute(sql`select w.entity_id::text as node_id, w.path_ids::text[] as path_ids,
        w.relations as rels, w.depth from ${call} w`),
  )) as unknown as Array<{
    node_id: string;
    path_ids: string[];
    rels: string[];
    depth: number;
  }>;
  const raw = Array.from(rows);
  if (raw.length === 0) return [];

  // Resolve every entity id that appears in any path, in one query.
  const allIds = new Set<string>();
  for (const r of raw) for (const id of r.path_ids) allIds.add(id);
  const entityRows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.ownerId, ownerId), inArray(entities.id, Array.from(allIds))));
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
    out.push({
      subjectId: e.sourceId,
      subject,
      relation: e.relation,
      objectId: e.targetId,
      object,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The fact-visibility predicate for a caller that may not see some node types:
 * the fact must have a source node, and that node must not be of a hidden
 * type. One place, so the tools and the context loader cannot drift.
 */
export function visibleFactSource(excludeSourceTypes: readonly string[]): SQL {
  if (excludeSourceTypes.length === 0) return sql`${facts.sourceNodeId} is not null`;
  return sql`exists (select 1 from ${nodes} src
    where src.id = ${facts.sourceNodeId}
      and src.type::text <> all(${pgArrayLiteral([...excludeSourceTypes])}::text[]))`;
}
