# Mantle Memory Architecture

How Mantle holds and retrieves what it knows. This file is the durable
reference for the memory layer; companion to
[`architecture.md`](./architecture.md) which covers the system as a whole.

Status: **partially implemented.** `recent_turns` and `conversation_digest`
are live for Telegram (migrations 0012, 0013). `persona`, `profile`,
`content_index`, and `content_store` are partly in place at the schema
level but their full retrieval pipelines aren't built yet — sequencing is
in [§7](#7-build-sequence).

---

## 1. The vision behind the design

Mantle's communication agents (Sarah being the first) are designed as
**continuous-relationship assistants**, not chatbots. There are no
"sessions" the user is aware of. You don't open a thread, ask a question,
close the thread. You speak to Sarah; she remembers everything she's been
told; you pick up wherever you left off.

This frames everything else in this doc:
- **No `session_id`.** The conversation never ends.
- **The agent has identity.** Sarah has a stable persona that grows
  through use, not a per-call system prompt.
- **Memory is the product.** The killer feature is *recall* — Sarah
  surfacing the right note, fact, or email when you mention it vaguely.
- **Same Sarah everywhere.** Telegram, web, voice, future surfaces — one
  identity, one memory, multiple inputs.

The agent's job is to be the front-door — she can delegate to specialist
agents (extractor, summarizer, future planners) when she needs them.

---

## 2. The six layers

Memory in Mantle is six storage layers, each with a fixed role and its
own retrieval pattern. The keyword in the first column is the canonical
identifier used in code, schemas, and config jsonb keys.

| # | Keyword | Display name | What it holds | Lifetime | Always in prompt? |
|---|---|---|---|---|---|
| 1 | `persona` | **Persona** | The agent's stable identity — voice, style, and the relationship notes it has accumulated about *this* user (preferences observed, in-jokes, corrections). | Indefinite; slowly evolves. | Yes — verbatim. |
| 2 | `recent_turns` | **Recent Turns** | The last N raw exchanges between user and agent (`telegram_messages` direction-tagged). | Sliding window (default 20). | Yes — chronological. |
| 3 | `conversation_digest` | **Conversation Digests** | Compressed summaries of older conversations, rolled up in batches by the summarizer agent. | Permanent once written. | Top-K most relevant prepended. |
| 4 | `profile` | **Profile** | Durable, dedup'd facts about the user and their world — identity, relationships, projects, preferences. Each fact is declarative and can be updated, contradicted, or retired. | Indefinite; mutable. | Top-K most relevant retrieved. |
| 5 | `content_index` | **Content Index** | Searchable catalogue over every stored item. Per item: title, tags, 1-2 sentence summary, entities mentioned, embedding. The *spine* of the books — cheap to scan, never the full body. | Refreshed when source content changes. | Top match prepended as link + summary. |
| 6 | `content_store` | **Content Store** | The source content itself — emails, files, notes, sermons, attachments. Append-only, immutable, citable. | Permanent. | Fetched by id only when full body is requested. |

These six layers organise naturally around three concerns:

```
ABOUT THE AGENT       persona               (who I am)

ABOUT OUR DIALOG      recent_turns          (what we just said)
                      conversation_digest   (what we used to say)

ABOUT YOUR WORLD      profile               (what I know is true)
                      content_index         (where the receipts are)
                      content_store         (the receipts themselves)
```

This grouping isn't a 7th layer — it's the mental model behind the six.

### Fact subtypes (inside `profile`)

The `profile` layer carries facts of three shapes, distinguished by the
`kind` column on `facts`:

- **Factual**: a verifiable claim about a specific thing. *"Sarah's
  passport expires 2030-06-12."* Has a value; can be wrong; can be
  updated.
- **Episodic**: a record of something that happened. *"On 2026-05-17
  Jason said he was preaching Romans 8."* Anchored in time. Doesn't get
  "updated" — superseded by newer episodes.
- **Semantic**: an abstraction inferred from many episodes. *"Jason is a
  pastor."* Stable identity; rarely changes; can be contradicted but
  only by weight of evidence.
- **Preference**: a stable statement about how the user prefers things.
  *"Jason prefers terse replies, no bullet lists."* Drives style.

Each subtype gets different weight at retrieval time. Preferences are
usually always-injected (small, high signal); episodes are
recency-weighted; semantic facts rarely change and stay in the prefix.

### Two shapes of summary

The word "summary" appears in two places and they're different shapes:

- **Item summary** — 1-to-1 with a single Content Store item. Lives as a
  field inside its `content_index` entry (currently planned as
  `nodes.data.summary`). Generated at ingest by the summarizer or
  extractor; refreshed if the source is edited.
- **Aggregate summary** — 1-to-many. One summary covers N source items.
  Conversation digests are the working example: one digest covers ~20
  telegram_messages. Lives as its own row (today a `note` node tagged
  `conversation-digest`).

Both compress information through an LLM. They differ in cardinality and
home, not in spirit.

---

## 3. The retrieval flow

The killer query for Sarah: *"I made a note on my Lister 3D printer
gantry."* Sarah must walk the memory stack from cheapest scan to deepest
fetch and surface the right file. Here's how the layers compose:

```
User: "I have made a note on how I want to build my Lister 3D printer gantry."
                                  │
                                  ▼
                  ┌──────────────────────────────────┐
                  │   Working memory assembly         │
                  │   (per-turn prompt builder)       │
                  └────────────────┬─────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │ pull always-loaded slices                            │
        ▼                          ▼                          ▼
  ┌─────────┐               ┌──────────────┐         ┌──────────────────┐
  │ persona │               │ recent_turns │         │ conversation_    │
  │         │               │              │         │   digest         │
  │ "I am   │               │ last 20      │         │ "Last month      │
  │  Sarah" │               │  chats"      │         │  Jason mentioned │
  │         │               │              │         │  the 3D printer  │
  │         │               │              │         │  rebuild"        │
  └─────────┘               └──────────────┘         └──────────────────┘
        │                          │                          │
        │ pull relevance-keyed slices                          │
        ▼                          ▼                          ▼
                  ┌──────────────────────────────────┐
                  │           profile                │
                  │  vector + entity search for      │
                  │  facts mentioning "3D printer",  │
                  │  "Lister", "gantry"              │
                  │  → "Jason owns a Lister 3D       │
                  │     printer; project: rebuild    │
                  │     gantry"                      │
                  └────────────────┬─────────────────┘
                                   │
                                   ▼
                  ┌──────────────────────────────────┐
                  │        content_index             │
                  │  multi-step cascade:             │
                  │   ① tag filter   ['note',        │
                  │                   '3d-printing'] │
                  │   ② FTS / embedding rank         │
                  │   ③ read top-3 summaries         │
                  │   ④ pick best match              │
                  │                                  │
                  │  → node 8f3a-… titled            │
                  │   "Lister Gantry Rebuild Plan"   │
                  │   summary: "Linear rail upgrade  │
                  │   for the Lister 3D printer..."  │
                  └────────────────┬─────────────────┘
                                   │
                                   ▼
                   Sarah: "Yes — your note 'Lister
                          Gantry Rebuild Plan' from
                          Apr 12. Want the full plan
                          or just the link?"
                                   │
                  (only if Jason asks for the body, Sarah
                   fetches the content_store row by node.id)
```

The key insight: **Sarah hits the `content_index`, not the
`content_store` directly.** The Index is the spine of the book — title,
tags, summary, embedding. The Store is the body, fetched only when
needed. You don't reread every book on your shelf to remember you own
it; you scan the spines.

Five mini-stages inside the `content_index` cascade:

1. **Tag / FTS pre-filter** (cheap: indexed columns, GIN on tags + tsvector)
2. **Embedding rank** (medium: pgvector cosine similarity)
3. **Read top-K summaries** (very cheap: short text already in the row)
4. **Pick best match**
5. **Fetch the content_store body by id** (only if the user wants the body)

Each step narrows. Cheapest first.

---

## 4. Two retrieval axes: vector and graph

Memory retrieval needs to answer two different *shapes* of question. They
demand different indexing strategies, and a good system uses both.

### 4.1 Vector retrieval — "what's like this?"

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
> closest (usually by cosine similarity).

**Use cases:** "fuzzy" semantic recall — *"what do I know about church
work?"* hits items that don't say "church" if they're semantically related
(sermon, congregation, pastoral, preaching).

**Examples:** Pinecone, Weaviate, Qdrant, Chroma, Milvus — and, the one
that matters for us, **pgvector**, a Postgres extension that adds a
`vector` column type and similarity operators (`<=>` for cosine,
`<->` for L2).

**Mantle's situation:** pgvector is already loaded
([`infra/postgres/init/01-extensions.sql`](../infra/postgres/init/01-extensions.sql))
and `nodes.embedding` is declared as `vector(1536)`
([`packages/db/src/schema/nodes.ts:45`](../packages/db/src/schema/nodes.ts:45)).
The column is currently always NULL because no ingestion path embeds
content yet. When the extractor lands, every `content_index` entry and
every `facts` row gets embedded at write time and similarity-searched at
read time — same Postgres, no second service.

Typical query shape against `facts`:

```sql
SELECT content, kind, entity_id
FROM facts
WHERE owner_id = $user
ORDER BY embedding <=> $query_embedding   -- cosine distance, lower = closer
LIMIT 10;
```

### 4.2 Graph retrieval — "what's connected to what?"

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
items mentioning "Sarah" or items mentioning "passport"; it cannot tell
you they refer to the same object — only an explicit relationship can.

**Examples of graph DBs:** Neo4j, ArangoDB, AWS Neptune, Memgraph,
JanusGraph. Mem0 uses Neo4j when graph features are enabled.

**Mantle does NOT need a separate graph DB.** At personal scale (millions
of edges or less), graphs are just tables — Postgres handles them fine
with foreign keys and **recursive CTEs**. You only need a dedicated graph
engine when traversal becomes the bottleneck of a high-throughput
production system: social graphs, fraud detection, recommendations at
internet scale. None of those apply here.

### 4.3 Why both together

| Query shape | Best tool | Example |
|---|---|---|
| Fuzzy, theme-based | Vector | "What do I know about church work?" |
| Entity-anchored | Graph | "What did Sarah and I discuss this month?" |
| Both | Hybrid | "Recent things related to Sarah about travel" |

The killer pattern is **filter, then rank**: use the graph to restrict
the candidate set ("facts that mention Sarah"), then use vectors to rank
within it ("…by relevance to 'travel plans'"). Or the reverse — vector-
rank first, then expand each result's entity neighbourhood for context.

---

## 5. Layer-to-schema mapping

All in one Postgres. Where each layer lives today, and what's planned:

| Layer | Storage | Status |
|---|---|---|
| `persona` | `agents.system_prompt` carries the seed identity. Style evolution + relationship notes will land in a `persona_notes` jsonb field (or a separate `agent_notes` table if it grows). | Seed exists; evolution unbuilt. |
| `recent_turns` | Query against `telegram_messages` (direction-tagged) for the chat. Schema in `packages/db/src/schema/telegram.ts`. | ✓ Live. |
| `conversation_digest` | `nodes` rows of `type='note'` with `tags @> ['conversation-digest']`. Data jsonb carries summary, period, source turn ids. | ✓ Live (migration 0013). |
| `profile` | New `facts` table — content, kind (factual / episodic / semantic / preference), entity_id, confidence, valid_from / valid_to, source_node_id, embedding, superseded_by. Optional `entities` + `entity_edges` tables for the graph layer. | Planned (migration 0014+). |
| `content_index` | Fields on existing `nodes`: `title`, `tags`, `data.summary` (eager-written at ingest), `data.entities`, `embedding` (vector(1536), currently NULL on most rows). Indexable via tsvector + GIN(tags) + IVFFlat(embedding). | Columns exist; summary + embedding population is unbuilt. |
| `content_store` | Existing `nodes` + specialised tables: `emails`, `email_attachments`, `telegram_messages`, `secrets`, future `files`. | ✓ Live. |

### The `facts` table sketch (planned 0014)

```sql
CREATE TABLE facts (
  id              uuid PRIMARY KEY,
  owner_id        uuid NOT NULL REFERENCES auth.users(id),
  content         text NOT NULL,           -- the fact as a sentence
  kind            fact_kind NOT NULL,      -- 'factual'|'episodic'|'semantic'|'preference'
  entity_id       uuid REFERENCES entities(id),  -- primary "about" entity, optional
  confidence      real DEFAULT 1.0,        -- 0..1; lower for inferences
  valid_from      timestamptz,             -- when the fact became true
  valid_to        timestamptz,             -- when it stopped (NULL = still current)
  source_node_id  uuid REFERENCES nodes(id) ON DELETE SET NULL,  -- citation
  embedding       vector(1536),
  superseded_by   uuid REFERENCES facts(id),  -- UPDATE replaces a prior fact
  data            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

**Citation is first-class.** Every fact has `source_node_id` pointing
back at the original `content_store` row it was extracted from. This
means:

- You can always trace a fact to its receipt.
- If the source item is edited (e.g. an email re-parsed), derived facts
  can be marked `dirty=true` and re-extracted — much cleaner than
  syncing across two stores.
- If the source is deleted, `ON DELETE SET NULL` makes the fact an
  orphan but doesn't lose it.

### The `entities` + `entity_edges` sketch (planned, after 0014)

```sql
CREATE TABLE entities (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES auth.users(id),
  kind        text NOT NULL,        -- 'person'|'project'|'place'|'event'|…
  name        text NOT NULL,        -- 'Sarah', 'kitchen renovation'
  aliases     text[] NOT NULL DEFAULT '{}',
  data        jsonb NOT NULL DEFAULT '{}',
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entity_edges (
  id           uuid PRIMARY KEY,
  owner_id     uuid NOT NULL REFERENCES auth.users(id),
  source_id    uuid NOT NULL,
  source_kind  text NOT NULL,   -- 'entity'|'fact'|'node'
  target_id    uuid NOT NULL,
  target_kind  text NOT NULL,
  relation     text NOT NULL,   -- 'married_to'|'works_at'|'mentioned_in'|…
  data         jsonb NOT NULL DEFAULT '{}',
  valid_from   timestamptz,
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_edges_source_idx ON entity_edges(source_id, relation);
CREATE INDEX entity_edges_target_idx ON entity_edges(target_id, relation);
```

Temporal edges (`valid_from`, `valid_to`) borrow from Zep's Graphiti
design and let memory reason about facts that change over time.
"Jason worked at X from 2023 to 2025, now works at Y" stays queryable
as "where does Jason work *currently*?" via `WHERE valid_to IS NULL`.

---

## 6. The retrieval order in the prompt

Once the full memory stack is built, the responder's prompt assembly is:

```
[persona]                                     ← cache_control (stable for days)
[profile — top-K facts]                       ← cache_control (stable for minutes)
[conversation_digest — last N digests]        ← cache_control (changes every ~20 turns)
[content_index hits — if user mentioned content]  ← changes per turn
[recent_turns — last N raw]                   ← drifts each turn
[new user message]                            ← always fresh
```

Persona first, then world-knowledge facts (load-bearing identity context),
then dialog memory, then per-query content references, then raw recent
turns. The model treats the early blocks as durable and the late blocks
as live conversation.

Three Anthropic cache breakpoints used (of four allowed). One slot stays
free for a future "stable history prefix" breakpoint if the raw-turn
section starts dominating the bill.

---

## 7. Build sequence

Each step delivers value standalone.

1. **`recent_turns`** — DONE (migration 0012, agent runner).
2. **`conversation_digest`** — DONE (migration 0013, summarizer agent).
3. **`content_index` population** — backfill `data.summary` and
   `embedding` on existing `nodes`. Extractor agent runs at ingest time
   on new content. Responder gains a basic `search_content_index()` call
   it can invoke when the user references stored content. **Next.**
4. **`profile` v1 (facts only, no graph)** — `facts` table, extractor
   produces facts at ingest using a ported ADD/UPDATE/DELETE/NOOP
   classifier prompt. Responder retrieves top-K relevant facts and
   prepends them. (Migration 0014.)
5. **`persona` evolution** — `persona_notes` storage + a small
   reflective agent that watches conversations for relationship signals
   ("Jason said 'too verbose' on date X") and appends to notes. Stays
   small; never overwrites the core seed prompt.
6. **`profile` v2 (entities + graph)** — `entities` and `entity_edges`
   tables, entity-anchored retrieval, hybrid vector+graph filtering.
   (Migration 0015+.)
7. **Web assistant surface** — same Sarah, browser chat. Memory is
   shared; surface is new. Likely a new node type for the conversation
   stream, or extending the telegram_messages model into a generic
   `conversation_messages` table.

Roughly a weekend per step.

---

## 8. What we deliberately don't do

- **No separate vector DB.** pgvector in one Postgres handles personal-
  scale data with room to spare. Pinecone et al. are right when you
  shard billions of vectors across regions; not us.
- **No separate graph DB.** Neo4j is right when traversal is the
  application's bottleneck. For one user's life, recursive CTEs on a few
  thousand edges are fast and free.
- **No Mem0 / Letta / Zep as infrastructure.** We borrow the *patterns*
  (taxonomy, retrieval ordering, ADD/UPDATE/DELETE classifier, temporal
  edges) and implement them inside Mantle's Postgres. One store, one
  operational story, full ownership of every prompt and every schema.
  See [`architecture.md`](./architecture.md) for the broader reasoning.
- **No automated background fact mining of all historical content from
  day one.** The extractor runs on new ingest, not on a sweep of
  history. A one-off backfill script can replay older content into the
  memory layer once the pipeline is stable.
- **No user-visible sessions.** Sarah is continuous. Internally we may
  cluster turns into topics; the user never declares one.

---

## 9. Reading the code

Live today:
- [`apps/agent/src/main.ts`](../apps/agent/src/main.ts) — responder +
  context assembly (`loadContext`).
- [`apps/agent/src/summarizer.ts`](../apps/agent/src/summarizer.ts) —
  `conversation_digest` production.
- [`apps/agent/src/messages.ts`](../apps/agent/src/messages.ts) —
  `buildChatMessages` with cache breakpoints.

To come (read in this order once shipped):
1. `packages/db/src/schema/facts.ts` — the shape of a fact.
2. `apps/agent/src/extractor.ts` — what runs at ingest, what prompts
   are used, the dedup classifier.
3. `apps/agent/src/main.ts` `loadContext()` extension — how `profile`
   and `content_index` blend with the rest of the layers.
4. `packages/search/src/index.ts` — hybrid vector + graph retrieval.
