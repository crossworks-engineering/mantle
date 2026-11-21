# The knowledge graph

How Mantle turns ingested content into a **traversable graph of relationships
between the things in your life**, Sarah `employed_by` Cross-Works, Cross-Works
`banks_with` Nedbank, Pivotal `provides_services_to` Cross-Works, and how that
graph stays clean (one entity per real thing, a consistent verb vocabulary)
without a dedicated graph database.

Companion to [`memory.md`](./memory.md) (the six memory layers; the graph is
the *graph axis* of L4/L5), [`observability.md`](./observability.md) (every
extraction step is traced), and [`data-flow-tracing.md`](./data-flow-tracing.md)
(verify one node by hand). Shipped 2026-05-29.

> **No graph database.** The whole graph is Postgres: `entities` +
> `entity_edges` tables, `ltree` for the tree, two plpgsql functions for
> multi-hop traversal (`mantle_graph_walk`, `mantle_graph_path`, §6).
> This was re-confirmed with evidence at 2,200-edge / 1,365-document scale,
> Postgres traverses your whole life instantly. The remaining hard problems
> (entity resolution, verb consistency) are *modelling*, not engine, problems,
> which a graph DB wouldn't solve. See [`memory.md` §4](./memory.md#4-two-retrieval-axes-vector-and-graph)
> and the parked fork note in [`docs/future/`](./future/industrial-fork-and-graph.md).

---

## 1. The data model

Two tables, both owner-scoped:

- **`entities`** (`packages/db/src/schema/entities.ts`): the distinct things in
  your world: people, orgs, places, projects, events. Columns: `kind` (free
  text, lowercase convention), `name`, `aliases text[]`, `embedding`, `data`.
- **`entity_edges`** (`entity-edges.ts`): typed, **directional**, polymorphic,
  **temporal** relationships. `source_id`/`source_kind` → `target_id`/
  `target_kind` (kind ∈ `entity | fact | node`), a free-text `relation` verb,
  `data` jsonb, and `valid_from`/`valid_to` for "was true between these dates".

Two edge shapes live in that one table:

| Edge | Shape | Meaning | Written by |
|---|---|---|---|
| `mentioned_in` | entity → **node** | "this entity appears in this email/file/note" (co-occurrence) | `reconcile_entities` |
| **a relation** (`employed_by`, `banks_with`, …) | entity → **entity** | "this is how two things relate" (the *knowledge* graph) | `process_relations` |
| `references` | node → node | a page/note @-links another | page extractor |

A **relation edge** is the only kind stamped with `data.source_node_id` (the
document it came from) + `data.confidence`, so every relationship is **citable
and auditable**, and the rebuild can key off it (below).

---

## 2. Relation extraction (the cheap way)

Relations are produced in the **same `llm_extract` call** that already emits the
summary, facts, and entities, marginal extra tokens, no second LLM pass. The
prompt (`DEFAULT_EXTRACTOR_PROMPT` in `server/api/src/agent/extractor.ts`) asks for a
third output:

```json
"relations": [
  { "subject": "<entity name>", "relation": "<verb>", "object": "<entity name>", "confidence": 0.0-1.0 }
]
```

`subject`/`object` must be names already in the `entities` list; `relation` is a
short lowercase snake_case verb. Parsing + validation lives in
`extractor-parse.ts` (`ExtractedRelation`, `isValidRelation`, `sanitiseRelation`)
, self-loops and vacuous verbs dropped, verbs snake_cased.

The **`process_relations`** step (`extractor.ts`) then:

1. **Rebuild-keyed-by-node:** deletes this node's prior relation edges (the ones
   carrying its `source_node_id`) so a re-extract *replaces* rather than appends.
2. Resolves `subject`/`object` to entity ids via the reconcile map, **skips
   endpoints that don't resolve** (never invents entities from a relation).
3. Inserts entity→entity edges stamped with `source_node_id` + `confidence`,
   deduped within the pass.
4. Records an `ADD / NOOP / skipped` tally on the trace step.

It runs whenever the deep-extraction tier is on, **independent of whether any
facts were found**; a document can establish relationships without a fact worth
storing.

---

## 3. Verb consistency

Free-text verbs are expressive but drift: the model paraphrases the same
relation differently across documents (`banks_with` / `holds_account_at` /
`maintains_account_at`). Two layers keep the vocabulary queryable without a
rigid ontology:

- **Prompt nudge (at the source):** the extractor prompt lists preferred common
  verbs by domain (work / family / place / money / tech) and tells the model to
  *reuse* them rather than coin a near-synonym. New verbs are still allowed when
  none fits; the taxonomy stays emergent.
- **Canonicalization (the backstop):** `canonicaliseRelation` in
  `extractor-parse.ts` maps known synonyms to a canonical form
  (`works_at`/`receives_salary_from` → `employed_by`; `holds_account_at` →
  `banks_with`) and drops vacuous verbs (`is`, `has`, `related_to`, …). The map
  is deliberately **tight**: only unambiguous synonyms; genuinely distinct
  senses (`provides` vs `provides_services_to`) are left alone.

At 1,365-document scale this held: `employed_by` (356) with **zero** `works_at`
fragments; `banks_with` with **zero** `holds_account_at`.

---

## 4. Entity resolution: the integrity spine

A graph is only as good as its node identity: a relation to "GitHub" and a
mention of "GitHub, Inc." must land on the *same* entity or the graph silently
fragments. Resolution happens in `reconcileEntity` (`extractor.ts`), in order:

1. **Exact** (case-insensitive name or alias).
2. **Trigram** ≥ 0.7, same kind (with a same-surname-different-given guard so
   "Don Carter" ≠ "Alex Carter").
3. **Embedding** within `ENTITY_DEDUP_THRESHOLD` (same guard).
4. **Org legal-suffix match**: "Acme (Pty) Ltd" ↔ existing "Acme" (orgs only;
   `normaliseOrgName` strips legal forms).
5. **Insert**: and if a concurrent extraction won the race, catch the
   unique-violation and re-select.

The **structural guarantee** (migration 0055): a UNIQUE index on
`(owner_id, lower(name), kind)`. Before it, the SELECT-then-INSERT raced under
concurrent extraction and spawned duplicate entity rows (GitHub×2, iStore×3, 75
total). 0055 merged those to a canonical row (re-pointing every edge + fact) and
the index now makes recurrence impossible, confirmed: **0 exact dups across
1,365 documents**.

---

## 5. Near-duplicate consolidation

Exact dups are impossible; **near**-dups still happen, the same real thing
across spelling/identifier variants (`Alex` / `Alex Carter` /
`alex@…`; `Pivotal Accounting` / `Pivotal Accounting Solutions`). These are
*judgement calls*, so consolidation is **conservative + tiered** and never
blind-merges (`packages/content/src/entity-dedup.ts`):

- **`mergeEntities(canonical, dup)`**: the safe primitive: transactional
  re-point of every edge + fact, fold the dup's name/aliases into the canonical
  (so the variant resolves there forever, prevents recurrence), delete the dup.
- **`findDuplicateCandidates`**: scores pairs into tiers:
  - **`auto`**: evidence-backed, safe: org legal-suffix collapse; an
    email/phone-named entity matched to a person via the **contacts** table.
  - **`review`**: plausible but needs a human eye: person *given-name* subset
    (`Alex` ⊂ `Alex Carter`). The subset rule **requires the first name to
    match**; it rejects the dangerous surname-only collision (`C. Botha` →
    `Alex Carter`).
- **`dismissMergeCandidate`**: records "not a duplicate" (migration 0056,
  `entity_merge_dismissals`) so a rejected pair is never suggested again.

**Surfaces:**
- **`/settings/entities`**: the review UI: tiered candidate list, one-click
  **Merge** / **Dismiss** per row. The home for ongoing graph hygiene.
- **`pnpm -C server/web entities:dedupe`**: the script: dry-run by default;
  `--go` applies the auto tier; `--include-review` the rest; `--merge=a,b` one
  pair. Free (no LLM).

---

## 6. Traversal: querying the graph

Two read primitives in `packages/search/src/entities.ts`, both exposed as
builtin tools (Saskia) and MCP tools (Claude Desktop/Code):

- **`entity_neighbors`**: one hop, both directions, optional relation filter.
  The cheap "what's directly connected to X?".
- **`graph_path`**: multi-hop. `from_id` only → every entity reachable
  within `max_depth`, nearest first; `from_id` + `to_id` → the shortest path
  between two entities ("how is Alice connected to Nedbank?" →
  `Alice → employed_by → Cross-Works → banks_with → Nedbank`). Cycle-safe,
  relation-filterable, undirected by default for connectivity.

### 6.1 The walk is two database functions (migration 0396)

`graphPath` calls `public.mantle_graph_walk` (`from_id` only) or
`public.mantle_graph_path` (`from_id` + `to_id`) with bound parameters,
inside a READ ONLY transaction (`readOnlyTransaction`), then resolves the
ids to names in one query.

```sql
mantle_graph_walk(p_owner uuid, p_from uuid, p_max_depth int = 3,
                  p_relations text[] = null, p_directed boolean = false,
                  p_current_only boolean = true, p_limit int = 50,
                  p_target uuid = null)
mantle_graph_path(p_owner uuid, p_from uuid, p_to uuid, p_max_depth int = 3,
                  p_relations text[] = null, p_directed boolean = false,
                  p_current_only boolean = true)
  -- both: returns table (entity_id uuid, depth int, path_ids uuid[], relations text[])
```

- **Level by level.** The walk is breadth first: one set query per level
  finds the next level from the edges of the current one and leaves out
  every entity already visited. Each entity is visited once and keeps a
  parent pointer; the path is rebuilt from the pointers at the end. So the
  cost grows with the entities and edges touched, not with the number of
  paths. The text query before 0396 built every simple path and then kept
  the shortest per entity: on a client brain (3,526 entities, 4,636
  entity-to-entity edges, one entity with 816 links) three steps from the
  busiest entity made 898,858 paths (2.1 s) and four steps did not end in
  8 s. On a synthetic graph of that shape the functions answer in about
  5 ms at any depth (the walk stops once a level fills the limit), and
  about 27 ms for a six-step walk that must visit every level in full.
- **What is walked.** Only edges with `source_kind` and `target_kind`
  `'entity'`, only of `p_owner`. A retired edge (`valid_to` set) is skipped
  unless `p_current_only` is false. `p_relations` null or empty means every
  verb. Undirected (the default) walks an edge both ways. The skip changed
  in 0396: the old walk also walked retired edges. The `graph_path` tool has
  no switch for it (`entity_neighbors` still shows a retired edge unless
  `current_only` is set), and no code retires an edge today.
- **Clamps.** Depth 1..6 (default 3), rows 1..200 (default 50). Rows come
  nearest first, so the limit keeps the nearest entities. This changed in
  0396: the old walk kept the first N entities by entity id and only then
  sorted them by depth, so a limit could drop a near entity and keep a far
  one.
- **Verbs.** `graphPath` reduces each verb in `relations` to the form the
  extractor stores (lower case, `[a-z0-9_]` only), so `Works_At` matches
  `works_at`, as before 0396. A verb that reduces to nothing is dropped;
  none left means no filter.
- **Tie-break.** Of two shortest paths to one entity, the one kept is the
  first when the hops are compared from the start, each hop by its relation
  verb, then by the entity's id. The rows come in that order too.
- **Rights.** Both are `SECURITY INVOKER`, `STABLE`, with `search_path`
  pinned: they read as their caller, so the caller's grants and row rules on
  `entity_edges` apply. They make no temporary table, so they run inside a
  READ ONLY transaction. Open to PUBLIC, as the other invoker reads.
- **Tests.** `packages/search/src/graph-functions.db.test.ts` (cycles,
  retired edges, direction, filters, clamps, tie-break, owners, read only,
  and a random graph checked against the old walk as the oracle) and
  `graph-path-read-only.db.test.ts` (the walk is sent inside the read-only
  transaction, in a turn scope and on the narrow system route).

### 6.2 Later: the same tables as an SQL/PGQ property graph

A later Postgres release with SQL/PGQ (`CREATE PROPERTY GRAPH`,
`GRAPH_TABLE (... MATCH ...)`) can read these tables as a graph with no
data change:

- **Vertices:** `entities`, key `id`, one label (`entity`) with `kind`,
  `name` and `owner_id` as properties (`kind` stays a property, not a
  label: kinds are open text).
- **Edges:** the entity-to-entity rows of `entity_edges`, `SOURCE KEY
  (source_id) REFERENCES entities (id)`, `DESTINATION KEY (target_id)
  REFERENCES entities (id)`, with `relation`, `valid_from`, `valid_to` as
  properties. `entity_edges` is polymorphic (an end may be a fact or a
  node), so the edge table is a view (or a table) of the rows where both
  kinds are `'entity'`.
- **Filters** stay in the `MATCH ... WHERE`: `owner_id`, and
  `valid_to IS NULL` for current edges.

Keep these functions for multi-hop until that release can match paths of
variable length with a visited guard as cheaply.

### 6a. The graph in retrieval: auto-expansion (June 2026)

Until June 2026 the graph was only reachable when an agent *explicitly* called
`entity_neighbors` / `graph_path`. Now it rides into every responder turn
automatically, the read-path realisation of the "filter by graph, rank by
vector" pattern ([`memory.md` §4.3](./memory.md#43-why-both-together)).

`entityRelationsFor(ownerId, entityIds)` (`packages/search/src/entities.ts`) is a
batched, name-resolved fetch of the 1-hop relation triples touching a set of
entities (excludes `mentioned_in` + retired edges, capped). In
[`loadConversationContext`](../packages/runtime/src/agent/conversation.ts) the
entities of the **top matching facts** become anchors, and their relations are
rendered into the prompt as a "Known relationships" block:

```
who does Cross-Works work with and bank with
→ Cross-Works banks_with ABSA
  Nedbank banks_with South African Reserve Bank
  ACM Technology supplier_of Cross-Works
```

This is knowledge vector search structurally cannot return; a relation is an
*edge*, not a similar fact. It also makes graph hygiene **consequential**: clean
entities ⇒ clean relations in the prompt (which is what surfaced the
fragmentation that motivated the §5 dedup improvements below).

### 5a. Smarter dedup (June 2026)

The auto tier gained `orgCompactKey` (legal-suffix-stripped **and**
alphanumeric-only), grouped across org-LIKE kinds (org/project/company), so
spacing/hyphen/punctuation variants *and* mislabelled kinds collapse:
`CrossWorksEngineering` = `Cross-Works Engineering`. `'sa'`/`'s.a.'` were dropped
from the legal-suffix list (in a South African corpus "SA" means South Africa,
not the legal form; it had merged "3D Printing SA" into generic "3D printing").

---

## 7. Backfilling history

Relations were added after most content was ingested, so old nodes have entities
but no relations. **`pnpm -C server/web relations:backfill`** re-fires
`node_ingested` for nodes with mentions but no relations, running them back
through the (now relations-aware) extractor, the same production path. Dry-run by
default; `--go` to fire; `--types` / `--limit` / `--rate` to stage and pace.
Full backfill of ~1,365 documents cost ~$2 on `gemini-3.1-flash-lite`.

---

## 8. Observability

Every relation pass is visible (see [`observability.md`](./observability.md)):
the `process_relations` step shows `ADD / NOOP / skipped`; the **Journey** view
(`/debug/journey`) shows a per-node relation count alongside facts + entities,
and the detail page lists the relations drawn (`subject → verb → object`).

---

## 9. Reading the code

| Concern | File |
|---|---|
| Relation parse + verb canonicalization | `server/api/src/agent/extractor-parse.ts` |
| Relation extraction + entity reconcile | `server/api/src/agent/extractor.ts` (`process_relations`, `reconcileEntity`) |
| Edge / entity schema | `packages/db/src/schema/{entities,entity-edges}.ts` |
| Traversal (`entity_neighbors`, `graph_path`) | `packages/search/src/entities.ts` |
| **Read-path expansion (`entityRelationsFor`)** | `packages/search/src/entities.ts` → `packages/runtime/src/agent/conversation.ts` |
| Near-dup consolidation (`orgCompactKey`) | `packages/content/src/entity-dedup.ts` |
| Review UI | `jackdaw/app/(app)/settings/entities/*` |
| Backfill / dedupe scripts | `server/web/scripts/{relations-backfill,entities-dedupe}.ts` |
| Multi-hop walk (`mantle_graph_walk`, `mantle_graph_path`) | `packages/db/migrations/0396_graph_functions.sql` |
| Migrations | 0055 (exact-dup merge + unique index), 0056 (dismissals), 0396 (graph functions) |
