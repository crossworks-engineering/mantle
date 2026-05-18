# Mantle Memory Architecture

How Mantle holds and retrieves what it knows. This file is the durable
reference for the memory layer; companion to
[`architecture.md`](./architecture.md) which covers the system as a whole.

Status: **partially implemented.** Tier-1 (recent turns) and Tier-2
(conversation digests) are live for Telegram (migrations 0012, 0013).
The full user-memory layer (Tier-3) — facts extracted from content,
dedup'd, contradicted, updated — is designed below but not yet built.

---

## 1. Why memory is its own layer

Mantle stores two fundamentally different things, and they want different
shapes:

- **Source content** — the *receipts*. Emails, files, telegram messages,
  contacts, attachments, raw documents. Append-only, immutable, citable.
  This is what lives in `nodes` and its specialised tables today.
- **Memory** — the *brain*. Derived knowledge about the user and their
  world: facts, preferences, relationships, summaries. Mutable, dedup'd,
  contradicted, decayed.

A human analogy: the filing cabinet vs the head. You don't store "Sarah
is my wife" by remembering every email she sent you and re-deriving it
each morning — your brain compresses, indexes, and updates that fact
directly. Mantle works the same way: the filing cabinet (Mantle's `nodes`)
is the source of truth; the brain (a memory layer) sits on top with
extracted, queryable knowledge.

The split lets each side optimise for its own job:
- Source content: immutable, citable, audit-friendly.
- Memory: small, dense, fast to retrieve, easy to update.

---

## 2. The taxonomy

Mantle's memory model borrows Mem0's four-layer framing
([core-concepts/memory-types](https://docs.mem0.ai/core-concepts/memory-types))
but maps it to a self-hosted, single-user system:

| Layer | Lifetime | Scope | Mantle implementation |
|---|---|---|---|
| **Conversation memory** | Single turn | The `messages[]` we send to the model | `buildChatMessages` in `apps/agent/src/messages.ts` |
| **Session memory** | Minutes–hours | One task / thread / chat | Implicit per Telegram chat today; explicit `conversations` when the web assistant lands |
| **User memory** | Indefinite | One person (this user) | `memories` table — **planned**, not yet built |
| **Organizational memory** | Indefinite | Many users / teams | N/A (single-user system; revisit only if Mantle ever becomes multi-tenant) |

Inside **user memory**, three subtypes worth distinguishing:

- **Factual**: a verifiable claim about a specific thing. *"Sarah's
  passport expires 2030-06-12."* Has a value; can be wrong; can be
  updated.
- **Episodic**: a record of something that happened. *"On 2026-05-17 Jason
  said he was preaching Romans 8."* Anchored in time. Doesn't get
  "updated" — superseded by newer episodes.
- **Semantic**: an abstraction inferred from many episodes. *"Jason is a
  pastor."* Stable identity; rarely changes; can be contradicted but only
  by a lot of evidence.

Each subtype wants slightly different storage and retrieval semantics
(weights, decay, contradiction handling). The schema below carries `kind`
on every memory row so the responder can weight them differently.

---

## 3. Two retrieval axes: vector and graph

Memory retrieval needs to answer two different *shapes* of question. They
demand different indexing strategies.

### 3.1 Vector retrieval — "what's like this?"

A **vector database** stores high-dimensional numeric representations
(*embeddings*) of text. An embedding model converts a piece of text into
a fixed-length array of floats:

```
"Jason is preaching Romans 8 this Sunday"  →  [0.234, -0.018, 0.091, …, 0.412]   (length 1536)
"I'm giving the sermon this weekend"        →  [0.221, -0.030, 0.085, …, 0.398]   (length 1536)
```

Two texts with similar *meaning* produce vectors that are close to each
other in the 1536-dimensional space, even with zero shared words. The
core query a vector DB answers:

> Given this query vector, return the N stored items whose vectors are
> closest (usually cosine similarity).

**Use cases:** "fuzzy" semantic recall. *"What do I know about church
work?"* hits memories that don't say "church" if they're
semantically related (sermon, congregation, pastoral, preaching).

**Examples:** Pinecone, Weaviate, Qdrant, Chroma, Milvus — and, the one
that matters for us, **pgvector**, a Postgres extension that adds a
`vector` column type and similarity operators (`<=>` for cosine,
`<->` for L2).

**Mantle's situation:** pgvector is already loaded
([`infra/postgres/init/01-extensions.sql`](../infra/postgres/init/01-extensions.sql))
and `nodes.embedding` is declared as `vector(1536)`
([`packages/db/src/schema/nodes.ts:45`](../packages/db/src/schema/nodes.ts:45)).
The column is currently always NULL because no ingestion path embeds
content yet. When the memory layer lands, every `memories` row gets
embedded at write time and similarity-searched at read time — in the
same Postgres, no second service.

Query shape:

```sql
SELECT content, kind, entity
FROM memories
WHERE owner_id = $user
ORDER BY embedding <=> $query_embedding   -- cosine distance, lower = closer
LIMIT 10;
```

### 3.2 Graph retrieval — "what's connected to what?"

A **graph database** stores **entities** (nodes) and the named
**relationships** between them (edges). Two primitives:

- **Entity**: a discrete thing in the world. A Person named Sarah, a
  Place called Cape Town, a Project called "kitchen renovation", an
  Event called "Sunday service 2026-05-17".
- **Edge**: a typed, directional relationship. `MARRIED_TO`, `WORKS_AT`,
  `MENTIONED_IN`, `LOCATED_IN`, `PRECEDED_BY`.

Visually:

```
  (Jason)──MARRIED_TO──▶(Sarah)
     │                     │
     │WORKS_AT             │HAS_PASSPORT──▶(Passport: expires 2030-06-12)
     ▼                     │
  (Church X)               └─BIRTHDAY──▶(June 12)
     │
     PREACHES_AT_ON──▶(Sunday 2026-05-17)──TOPIC──▶(Romans 8)
```

**Use cases:** "precise" relational traversal. *"Who is Sarah related
to?"* — start at Sarah, follow edges. *"What did Jason and Sarah do
together this month?"* — find paths between them, filter by date.
*"When was Sarah's passport last mentioned?"* — start at Sarah, follow
`HAS_PASSPORT`, then `MENTIONED_IN`.

Vector search can't answer these. It returns *similar* things, not
*connected* things. A vector query for "Sarah's passport" might return
facts mentioning "Sarah" or facts mentioning "passport"; it cannot tell
you they refer to the same object — only an explicit relationship can.

**Examples of graph DBs:** Neo4j, ArangoDB, AWS Neptune, Memgraph,
JanusGraph. Mem0 uses Neo4j when graph features are enabled.

**Mantle does NOT need a separate graph DB.** At personal scale (millions
of edges or less), graphs are just tables — Postgres handles them fine
with foreign keys and **recursive CTEs**. You only need a dedicated graph
engine when traversal becomes the bottleneck of a high-throughput
production system: social graphs, fraud detection, recommendations at
internet scale. None of those apply here.

The schema (planned):

```sql
-- Distinct entities (people, projects, places, events, etc.)
CREATE TABLE entities (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES auth.users(id),
  kind        text NOT NULL,        -- 'person' | 'project' | 'place' | 'event' | …
  name        text NOT NULL,        -- 'Sarah', 'kitchen renovation'
  aliases     text[] NOT NULL DEFAULT '{}',  -- ['Sarah Schoeman', 'wife']
  data        jsonb NOT NULL DEFAULT '{}',
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Typed relationships, between entities OR between entities and other things.
CREATE TABLE entity_edges (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES auth.users(id),
  source_id    uuid NOT NULL,
  source_kind  text NOT NULL,   -- 'entity' | 'memory' | 'node'
  target_id    uuid NOT NULL,
  target_kind  text NOT NULL,
  relation     text NOT NULL,   -- 'married_to' | 'works_at' | 'mentioned_in' | …
  data         jsonb NOT NULL DEFAULT '{}',
  valid_from   timestamptz,     -- Zep-style temporal: when did this become true?
  valid_to     timestamptz,     -- and when did it stop being true?
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_edges_source_idx ON entity_edges(source_id, relation);
CREATE INDEX entity_edges_target_idx ON entity_edges(target_id, relation);
```

Traversal uses recursive CTE:

```sql
-- Everything reachable from Sarah within 2 hops, any relation:
WITH RECURSIVE neighbours AS (
  SELECT target_id AS id, target_kind AS kind, 1 AS depth
  FROM entity_edges
  WHERE source_id = $sarah_id

  UNION

  SELECT e.target_id, e.target_kind, n.depth + 1
  FROM entity_edges e
  JOIN neighbours n ON e.source_id = n.id
  WHERE n.depth < 2
)
SELECT * FROM neighbours;
```

Temporal edges (`valid_from`, `valid_to`) borrow from Zep's Graphiti
design and let memory reason about facts that change over time —
"Jason worked at X from 2023 to 2025, now works at Y" stays
queryable as "where does Jason work *currently*?" via
`WHERE valid_to IS NULL`.

### 3.3 Why both together

Vector and graph are **complementary, not competing.** They solve
different query shapes, and a good memory system uses both depending on
the question.

| Query shape | Best tool | Example |
|---|---|---|
| Fuzzy, theme-based | Vector | "What do I know about church work?" |
| Entity-anchored | Graph | "What did Sarah and I discuss this month?" |
| Both | Hybrid | "Recent things related to Sarah about travel" |

The killer pattern is **filter, then rank**: use the graph to restrict
the candidate set ("memories that mention Sarah"), then use vectors to
rank within it ("…by relevance to 'travel plans'"). Or the reverse —
vector-rank first, then expand each result's entity neighbourhood for
context.

---

## 4. The Mantle implementation

All in one Postgres. Three planned tables:

| Table | Purpose | Status |
|---|---|---|
| `memories` | The facts. One row per durable extracted statement. | Planned (Tier-3) |
| `entities` | Distinct things in the world (people, projects, places). | Planned |
| `entity_edges` | Typed relationships between entities, memories, or `nodes`. | Planned |

Existing infrastructure already in place:

- pgvector extension loaded.
- `nodes.embedding` column ready (currently unused).
- `agents` table has `role='extractor'` already in the enum — the agent
  that will populate memories on ingest.
- `agents` table has `role='summarizer'` driving Tier-2 (live).

The full memories table sketch (planned for migration 0014):

```sql
CREATE TABLE memories (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL REFERENCES auth.users(id),
  content       text NOT NULL,           -- the fact as a sentence
  kind          memory_kind NOT NULL,    -- 'factual' | 'episodic' | 'semantic' | 'preference'
  entity_id     uuid REFERENCES entities(id),  -- the primary "about" entity, optional
  confidence    real DEFAULT 1.0,        -- 0..1; lower for inferences
  valid_from    timestamptz,             -- when the fact became true
  valid_to      timestamptz,             -- when it stopped (NULL = still current)
  source_node_id uuid REFERENCES nodes(id) ON DELETE SET NULL,  -- citation
  embedding     vector(1536),
  superseded_by uuid REFERENCES memories(id),  -- when an UPDATE replaces a prior fact
  data          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

**Citation is first-class.** Every memory has `source_node_id` pointing
back at the original `nodes` row it was extracted from. This means:

- You can always trace a fact to its receipt.
- If the source node is edited (e.g. an email re-parsed), we can mark
  derived memories `dirty=true` and re-extract — much cleaner than
  syncing across two stores.
- If the source is deleted, `ON DELETE SET NULL` makes the memory an
  orphan but doesn't lose it.

---

## 5. The retrieval order in the prompt

Once Tier-3 lands, the responder's prompt assembly extends to:

```
[system persona]                              ← cache_control (stable forever)
[user memories — top K by relevance]          ← cache_control (stable for minutes)
[conversation digests — Tier-2, last N]       ← cache_control (changes every ~20 turns)
[last 20 raw turns — Tier-1]                  ← drifts each turn
[new user message]                            ← always fresh
```

This ordering follows Mem0's recommendation: user memories first, session
notes second, raw history last. The model treats memories as **load-bearing
identity** rather than peripheral trivia — which is what you want when the
agent is answering as your assistant.

Three Anthropic cache breakpoints used (of four allowed), so the prefix
stays cache-eligible turn-to-turn. Only the raw-history tail + new user
message change between calls.

---

## 6. The build sequence

Each step delivers value standalone. No need to do them all at once.

1. **Tier-1: recent turns** — DONE (migration 0012, agent runner).
2. **Tier-2: conversation digests** — DONE (migration 0013, summarizer
   agent).
3. **Tier-3a: memories table + embedding-on-write + vector retrieval.**
   Plain `memories` table, no entities yet. Extractor agent runs on new
   `nodes` rows, produces candidate facts, dedups against existing
   memories using the ADD/UPDATE/DELETE/NOOP classifier pattern (ported
   from Mem0's prompts). Responder retrieves top-K relevant memories
   alongside digests + raw history. **Next planned migration: 0014.**
4. **Tier-3b: entities + entity_edges.** Graph layer for entity-anchored
   queries and richer relationship modeling. Memories get linked to
   entities; the agent's MCP `search` tool gains traversal capabilities.
5. **Tier-3c: hybrid retrieval.** The responder picks between or
   combines vector and graph paths based on query shape. May involve a
   small query-planner agent.
6. **Session memory** — explicit `conversations` when the web assistant
   lands. Distinct from Telegram chats. Lets a multi-step task ("plan
   my trip to Italy") have its own scoped state separate from another
   thread happening in parallel.

Each step is roughly a weekend of work.

---

## 7. What we deliberately don't do

For honest disclosure:

- **No separate vector DB.** Pinecone, Weaviate, Qdrant are great if
  you're sharding billions of vectors across regions. We're not. pgvector
  in a single Postgres handles personal-scale data with room to spare.
- **No separate graph DB.** Neo4j is the right tool when graph traversal
  is the application's bottleneck — social networks at internet scale,
  recommendation engines, fraud detection. For one user's life and work,
  recursive CTEs on a few thousand edges are fast and free.
- **No Mem0 / Letta / Zep as infrastructure.** We borrow the *patterns*
  (taxonomy, retrieval ordering, ADD/UPDATE/DELETE classifier, temporal
  edges) and implement them inside Mantle's Postgres. One store, one
  operational story, full ownership of every prompt and every schema.
  See [`architecture.md`](./architecture.md) for the broader reasoning.
- **No automated background fact mining of all `nodes` from day one.**
  The extractor runs on new ingest, not on a sweep of historical data.
  A one-off backfill script can replay history into the memory layer
  once the pipeline is stable.

---

## 8. Reading the code (once Tier-3 ships)

If you only read four files in the memory layer, read these in order:

1. `packages/db/src/schema/memories.ts` — the shape of a memory.
2. `apps/agent/src/extractor.ts` — what runs at ingest, what prompts get
   used, the dedup classifier.
3. `apps/agent/src/main.ts` `loadContext()` — how memories blend with
   Tier-1 and Tier-2 in the responder's prompt.
4. `packages/search/src/index.ts` — hybrid vector + graph retrieval.

Until those exist, the live code is the Tier-1/Tier-2 path:
[`apps/agent/src/main.ts`](../apps/agent/src/main.ts) (responder +
context assembly) and [`apps/agent/src/summarizer.ts`](../apps/agent/src/summarizer.ts)
(Tier-2 digests).
