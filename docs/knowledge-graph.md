# The knowledge graph

How Mantle turns ingested content into a **traversable graph of relationships
between the things in your life** — Sarah `employed_by` Cross-Works, Cross-Works
`banks_with` Nedbank, Pivotal `provides_services_to` Cross-Works — and how that
graph stays clean (one entity per real thing, a consistent verb vocabulary)
without a dedicated graph database.

Companion to [`memory.md`](./memory.md) (the six memory layers — the graph is
the *graph axis* of L4/L5), [`observability.md`](./observability.md) (every
extraction step is traced), and [`data-flow-tracing.md`](./data-flow-tracing.md)
(verify one node by hand). Shipped 2026-05-29.

> **No graph database.** The whole graph is Postgres: `entities` +
> `entity_edges` tables, `ltree` for the tree, recursive CTEs for traversal.
> This was re-confirmed with evidence at 2,200-edge / 1,365-document scale —
> Postgres traverses your whole life instantly. The remaining hard problems
> (entity resolution, verb consistency) are *modelling*, not engine, problems —
> which a graph DB wouldn't solve. See [`memory.md` §4](./memory.md#4-two-retrieval-axes-vector-and-graph)
> and the parked fork note in [`docs/future/`](./future/industrial-fork-and-graph.md).

---

## 1. The data model

Two tables, both owner-scoped:

- **`entities`** (`packages/db/src/schema/entities.ts`) — the distinct things in
  your world: people, orgs, places, projects, events. Columns: `kind` (free
  text, lowercase convention), `name`, `aliases text[]`, `embedding`, `data`.
- **`entity_edges`** (`entity-edges.ts`) — typed, **directional**, polymorphic,
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
document it came from) + `data.confidence` — so every relationship is **citable
and auditable**, and the rebuild can key off it (below).

---

## 2. Relation extraction (the cheap way)

Relations are produced in the **same `llm_extract` call** that already emits the
summary, facts, and entities — marginal extra tokens, no second LLM pass. The
prompt (`DEFAULT_EXTRACTOR_PROMPT` in `apps/agent/src/extractor.ts`) asks for a
third output:

```json
"relations": [
  { "subject": "<entity name>", "relation": "<verb>", "object": "<entity name>", "confidence": 0.0-1.0 }
]
```

`subject`/`object` must be names already in the `entities` list; `relation` is a
short lowercase snake_case verb. Parsing + validation lives in
`extractor-parse.ts` (`ExtractedRelation`, `isValidRelation`, `sanitiseRelation`)
— self-loops and vacuous verbs dropped, verbs snake_cased.

The **`process_relations`** step (`extractor.ts`) then:

1. **Rebuild-keyed-by-node:** deletes this node's prior relation edges (the ones
   carrying its `source_node_id`) so a re-extract *replaces* rather than appends.
2. Resolves `subject`/`object` to entity ids via the reconcile map — **skips
   endpoints that don't resolve** (never invents entities from a relation).
3. Inserts entity→entity edges stamped with `source_node_id` + `confidence`,
   deduped within the pass.
4. Records an `ADD / NOOP / skipped` tally on the trace step.

It runs whenever the deep-extraction tier is on, **independent of whether any
facts were found** — a document can establish relationships without a fact worth
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
  none fits — the taxonomy stays emergent.
- **Canonicalization (the backstop):** `canonicaliseRelation` in
  `extractor-parse.ts` maps known synonyms to a canonical form
  (`works_at`/`receives_salary_from` → `employed_by`; `holds_account_at` →
  `banks_with`) and drops vacuous verbs (`is`, `has`, `related_to`, …). The map
  is deliberately **tight** — only unambiguous synonyms; genuinely distinct
  senses (`provides` vs `provides_services_to`) are left alone.

At 1,365-document scale this held: `employed_by` (356) with **zero** `works_at`
fragments; `banks_with` with **zero** `holds_account_at`.

---

## 4. Entity resolution — the integrity spine

A graph is only as good as its node identity: a relation to "GitHub" and a
mention of "GitHub, Inc." must land on the *same* entity or the graph silently
fragments. Resolution happens in `reconcileEntity` (`extractor.ts`), in order:

1. **Exact** (case-insensitive name or alias).
2. **Trigram** ≥ 0.7, same kind (with a same-surname-different-given guard so
   "Don Carter" ≠ "Alex Carter").
3. **Embedding** within `ENTITY_DEDUP_THRESHOLD` (same guard).
4. **Org legal-suffix match** — "Acme (Pty) Ltd" ↔ existing "Acme" (orgs only;
   `normaliseOrgName` strips legal forms).
5. **Insert** — and if a concurrent extraction won the race, catch the
   unique-violation and re-select.

The **structural guarantee** (migration 0055): a UNIQUE index on
`(owner_id, lower(name), kind)`. Before it, the SELECT-then-INSERT raced under
concurrent extraction and spawned duplicate entity rows (GitHub×2, iStore×3 — 75
total). 0055 merged those to a canonical row (re-pointing every edge + fact) and
the index now makes recurrence impossible — confirmed: **0 exact dups across
1,365 documents**.

---

## 5. Near-duplicate consolidation

Exact dups are impossible; **near**-dups still happen — the same real thing
across spelling/identifier variants (`Alex` / `Alex Carter` /
`alex@…`; `Pivotal Accounting` / `Pivotal Accounting Solutions`). These are
*judgement calls*, so consolidation is **conservative + tiered** and never
blind-merges (`packages/content/src/entity-dedup.ts`):

- **`mergeEntities(canonical, dup)`** — the safe primitive: transactional
  re-point of every edge + fact, fold the dup's name/aliases into the canonical
  (so the variant resolves there forever — prevents recurrence), delete the dup.
- **`findDuplicateCandidates`** — scores pairs into tiers:
  - **`auto`** — evidence-backed, safe: org legal-suffix collapse; an
    email/phone-named entity matched to a person via the **contacts** table.
  - **`review`** — plausible but needs a human eye: person *given-name* subset
    (`Alex` ⊂ `Alex Carter`). The subset rule **requires the first name to
    match** — it rejects the dangerous surname-only collision (`C. Schoeman` →
    `Alex Carter`).
- **`dismissMergeCandidate`** — records "not a duplicate" (migration 0056,
  `entity_merge_dismissals`) so a rejected pair is never suggested again.

**Surfaces:**
- **`/settings/entities`** — the review UI: tiered candidate list, one-click
  **Merge** / **Dismiss** per row. The home for ongoing graph hygiene.
- **`pnpm -C apps/web entities:dedupe`** — the script: dry-run by default;
  `--go` applies the auto tier; `--include-review` the rest; `--merge=a,b` one
  pair. Free (no LLM).

---

## 6. Traversal — querying the graph

Two read primitives in `packages/search/src/entities.ts`, both exposed as
builtin tools (Saskia) and MCP tools (Claude Desktop/Code):

- **`entity_neighbors`** — one hop, both directions, optional relation filter.
  The cheap "what's directly connected to X?".
- **`graph_path`** — multi-hop via a recursive CTE. `from_id` only → everything
  reachable within `max_depth`; `from_id` + `to_id` → shortest path(s) between
  two entities ("how is Ashley connected to Nedbank?" →
  `Ashley → employed_by → Cross-Works → banks_with → Nedbank`). Cycle-safe,
  relation-filterable, undirected by default for connectivity.

> **Driver note (so the next person doesn't lose an hour):** the recursive CTE
> runs via the postgres-js **simple** query protocol
> (`db.$client.unsafe(sql).simple()`), not drizzle's `db.execute` — under the
> extended protocol an array-column's type isn't pinned at parse time and the
> cycle guard `= any(path_ids)` fails. Values are inlined + validated (UUID
> regex, clamped ints, `[a-z0-9_]` verbs), so there are no bind params. And
> resolving ids back to names uses drizzle's `inArray()`, not
> `sql\`= any(${jsArray})\`` (which drizzle mis-binds).

### 6a. The graph in retrieval — auto-expansion (June 2026)

Until June 2026 the graph was only reachable when an agent *explicitly* called
`entity_neighbors` / `graph_path`. Now it rides into every responder turn
automatically — the read-path realisation of the "filter by graph, rank by
vector" pattern ([`memory.md` §4.3](./memory.md#43-why-both-together)).

`entityRelationsFor(ownerId, entityIds)` (`packages/search/src/entities.ts`) is a
batched, name-resolved fetch of the 1-hop relation triples touching a set of
entities (excludes `mentioned_in` + retired edges, capped). In
[`loadConversationContext`](../packages/agent-runtime/src/conversation.ts) the
entities of the **top matching facts** become anchors, and their relations are
rendered into the prompt as a "Known relationships" block:

```
who does Cross-Works work with and bank with
→ Cross-Works banks_with ABSA
  Nedbank banks_with South African Reserve Bank
  ACM Technology supplier_of Cross-Works
```

This is knowledge vector search structurally cannot return — a relation is an
*edge*, not a similar fact. It also makes graph hygiene **consequential**: clean
entities ⇒ clean relations in the prompt (which is what surfaced the
fragmentation that motivated the §5 dedup improvements below).

### 5a. Smarter dedup (June 2026)

The auto tier gained `orgCompactKey` (legal-suffix-stripped **and**
alphanumeric-only), grouped across org-LIKE kinds (org/project/company) — so
spacing/hyphen/punctuation variants *and* mislabelled kinds collapse:
`CrossWorksEngineering` = `Cross-Works Engineering`. `'sa'`/`'s.a.'` were dropped
from the legal-suffix list (in a South African corpus "SA" means South Africa,
not the legal form — it had merged "3D Printing SA" into generic "3D printing").

---

## 7. Backfilling history

Relations were added after most content was ingested, so old nodes have entities
but no relations. **`pnpm -C apps/web relations:backfill`** re-fires
`node_ingested` for nodes with mentions but no relations — running them back
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
| Relation parse + verb canonicalization | `apps/agent/src/extractor-parse.ts` |
| Relation extraction + entity reconcile | `apps/agent/src/extractor.ts` (`process_relations`, `reconcileEntity`) |
| Edge / entity schema | `packages/db/src/schema/{entities,entity-edges}.ts` |
| Traversal (`entity_neighbors`, `graph_path`) | `packages/search/src/entities.ts` |
| **Read-path expansion (`entityRelationsFor`)** | `packages/search/src/entities.ts` → `packages/agent-runtime/src/conversation.ts` |
| Near-dup consolidation (`orgCompactKey`) | `packages/content/src/entity-dedup.ts` |
| Review UI | `apps/web/app/(app)/settings/entities/*` |
| Backfill / dedupe scripts | `apps/web/scripts/{relations-backfill,entities-dedupe}.ts` |
| Migrations | 0055 (exact-dup merge + unique index), 0056 (dismissals) |
