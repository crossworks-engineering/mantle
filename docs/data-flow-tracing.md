# Tracing data through the 6-layer brain

How to verify, by hand, that a piece of content landed where it should —
from the raw `nodes` row all the way through summary, embedding, facts,
entities, and the trace trail. Written for an operator (or a future
Claude session) sitting in front of the running dev stack who needs to
answer *"I sent X in — did the system actually digest it, and if not,
where did it stall?"*

Companion to [`memory.md`](./memory.md) (what the six layers *are*),
[`observability.md`](./observability.md) (the trace model), and
[`journey.md`](./journey.md) (the action→layer map + the `/debug/journey`
screen). This file is the **operational** counterpart: the exact queries.

One-shot tracer: [`scripts/trace-node.sh <node-id>`](../scripts/trace-node.sh)
runs everything below for a single node. Read this doc to understand what
it's showing you.

---

## 1. Connecting to the database

The dev stack runs Postgres in a Docker container named `mantle_pg`
(db `postgres`, user `postgres`, see `docker-compose.dev.yml`). Two ways in:

```bash
# One-shot query (use this for scripted / non-interactive tracing):
docker exec mantle_pg psql -U postgres -d postgres -c "select count(*) from nodes;"

# Interactive shell (pnpm infra:psql uses -it; only works in a real terminal):
docker exec -it mantle_pg psql -U postgres -d postgres
```

From the host you can also reach it on `127.0.0.1:54323` if you have a
local `psql` (`-h 127.0.0.1 -p 54323 -U postgres -d postgres`), but the
`docker exec` form needs nothing installed and always matches the
container's version.

**Read-only discipline.** Tracing is observation. Stick to `select`.
The only write you ever need for verification is re-firing a single
node's pipeline (§6) — and that's a `pg_notify`, not a row mutation.

---

## 2. Mental model: which layers are per-entry

The six memory layers don't all populate per ingested item. Split them:

| Layer | Per-entry? | Where it lands |
|---|---|---|
| L6 `content_store` | ✅ yes | `nodes` + specialised table (`emails`, `telegram_messages`, `secrets`, …) |
| L5 `content_index` | ✅ yes | columns on `nodes`: `data.summary`, `embedding`, `data.entities`, `search_tsv`, `tags` |
| L4 `profile` (facts) | ✅ yes | `facts` (rows with `source_node_id` = the node) |
| Graph axis | ✅ yes | `entities` + `entity_edges` (relation `mentioned_in`, **entity → node**) |
| L1 `persona` | ❌ conversation-driven | `agents.system_prompt` + `agents.persona_notes` |
| L2 `recent_turns` | ❌ conversation-driven | `telegram_messages` / `assistant_messages` |
| L3 `conversation_digest` | ❌ conversation-driven | `nodes` of type `note`, tag `conversation-digest` |

So tracing **an ingested item** = checking L6 → L5 → L4 → graph, plus the
trace trail. L1–L3 are about dialogue, not document ingest; trace those
separately when debugging the responder.

The whole per-entry flow hangs off one trigger: a `nodes` INSERT fires
`pg_notify('node_ingested', <id>)`, the extractor (`apps/agent`) picks it
up, and writes L5 + L4 + graph. Every step is mirrored into a `traces`
row.

---

## 3. The footprint trace (query by query)

Substitute the node id for `$N`. Or just run
`scripts/trace-node.sh $N`.

### L6 — content_store

```sql
-- core node
select type, title, path, tags, created_at,
       (updated_at > created_at) as touched_by_extractor
from nodes where id = '$N';

-- specialised table (whichever applies)
select from_addr, has_attachments, length(body_text) from emails where node_id = '$N';
select filename, mime_type, size_bytes from email_attachments where file_node_id = '$N';
select direction, text from telegram_messages where node_id = '$N';
```

`touched_by_extractor` (updated_at > created_at) is a quick "did anything
run after insert" tell.

### L5 — content_index

```sql
select left(data->>'summary', 120)                       as summary,
       data->>'summary_model'                            as model,
       case when embedding is null then null
            else vector_dims(embedding) end              as emb_dims,
       jsonb_array_length(coalesce(data->'entities','[]')) as n_entities,
       (search_tsv is not null)                          as has_tsv
from nodes where id = '$N';
```

Healthy: `summary` non-empty, `emb_dims = 768`, `n_entities ≥ 1`,
`has_tsv = t`. (**768, not 1536** — the brain migrated to local
EmbeddingGemma-300m on 2026-05-31; every `vector` column is now
`vector(768)`. See [`embeddings.md`](./embeddings.md).) **Watch the
empty-string trap** — `data->>'summary'` can
be `''` (key present, value blank) which is *not* NULL. Always check the
text, or wrap in `nullif(data->>'summary','')`.

### L4 — profile (facts)

```sql
select kind, content, confidence,
       (embedding is not null) as emb,
       (entity_id is not null) as linked
from facts where source_node_id = '$N' order by kind;
```

Each fact should be embedded (`emb = t`) and usually entity-linked.
`kind` ∈ `factual | episodic | semantic | preference`.

### Graph — entity edges

```sql
-- Edges point ENTITY → NODE with relation 'mentioned_in' (this is the
-- only relation in use today; all edges are this shape).
select e.kind, e.name
from entity_edges ed join entities e on e.id = ed.source_id
where ed.target_id = '$N' and ed.relation = 'mentioned_in';
```

Edge count should match `n_entities` from L5.

### Observability — the trace trail

```sql
select kind, status, coalesce(data->>'disposition','-') as disposition,
       cost_micro_usd, tokens_in, tokens_out, step_count, started_at
from traces where subject_id = '$N' order by started_at;

-- steps of the latest extractor_run
select s.name, s.kind, s.status, coalesce(s.meta->>'model','') as model
from trace_steps s join traces t on t.id = s.trace_id
where t.subject_id = '$N'
  and t.started_at = (select max(started_at) from traces
                      where subject_id = '$N' and kind = 'extractor_run')
order by s.started_at;
```

A healthy extractor run is 8 steps:
`llm_extract → embed_batch → update_index → reconcile_entities →
(embed_batch × N) → process_facts`.

---

## 4. Signature guide — reading the result

Three outcomes you'll see, and how to tell them apart at a glance:

| Signature | What it means |
|---|---|
| `extractor_run` **success** + summary set + facts > 0 + edges > 0 | **Healthy.** Content reached the brain. |
| `extractor_run` **skipped**, disposition `body_too_short` | Declined, by design. < 20 chars of body — an unsupported file type or a title-only node. 0 facts/edges expected. |
| `extractor_run` **skipped**, disposition `no_text_layer` | A scanned/image-only PDF whose OCR fallback also produced nothing (no/unwired vision worker, unrenderable PDF, or blank scan). Look for a preceding `photo_ingest` (`mode=pdf_ocr`) trace showing the rasterize + vision attempt. 0 facts/edges. |
| `extractor_run` **skipped**, disposition `already_extracted` | Declined — node already had `data.summary` + `embedding`. Re-fires no-op. |
| `extractor_run` **success** but summary **empty** + 0 facts | **Silent miss.** The LLM ran (cost was spent) but its output couldn't be used — historically a JSON-parse failure where the model appended prose after the object (fixed in `extractor-parse.ts`, but the *signature* is the diagnostic). Check the agent console for `[extractor] LLM returned non-JSON`. |
| `extractor_run` **success**, summary set, entities > 0, but **0 facts** + `process_facts` step **skipped** (`fact_cost_cap`) | **Cost-cap drop.** The model produced facts but the per-node budget (`extract_cost_cap_micro_usd`) was exhausted, so they were discarded before persisting. The run still succeeds (index/entities landed); only the `process_facts` step is amber. A cap of `0`/negative means *unlimited* — a positive cap set too low is the usual culprit. Surfaced in `/debug` → "Facts dropped to cost cap". Raise the cap (or null it) and re-fire (§6) to recover. |

> **Known observability gap:** the silent-miss case records a `success`
> trace, not `error`/`skipped`, so it's invisible in `/traces` — only the
> console log betrays it. A future improvement is to mark empty-output
> runs distinctly.

---

## 5. Baseline snapshot

Before injecting a test entry, capture "normal" so you can spot the delta:

```sql
select 'nodes by type' as scope, type::text as k, count(*)::text as n from nodes group by type
union all select 'facts by kind', kind::text, count(*)::text from facts group by kind
union all select 'totals','entities', count(*)::text from entities
union all select 'totals','entity_edges', count(*)::text from entity_edges
union all select 'totals','traces', count(*)::text from traces
order by scope, k;
```

To find the entry you just sent, sort by recency:

```sql
select id, type, title, created_at,
       (nullif(data->>'summary','') is not null) as has_summary,
       (embedding is not null) as has_embedding
from nodes order by created_at desc limit 10;
```

---

## 6. Re-running extraction on ONE node (safely)

To re-test the pipeline on a node that already exists (e.g. after a code
fix), re-fire its trigger — **for that single node only**:

```sql
select pg_notify('node_ingested', '<node-id>');
```

The extractor re-runs *iff* the node is still eligible: the
already-extracted guard is `if (data.summary && embedding)`, and an
**empty-string summary is falsy**, so a node that previously silent-missed
is re-processed. A node with a real summary will skip
(`already_extracted`) — clear `data.summary` first if you truly need to
force it.

> **Do NOT confuse this with a backlog.** `pg_notify('node_ingested', id)`
> is one node. A full re-process of history is
> `pnpm -C apps/web extract:backfill` — that one *does* sweep old content
> (and spend LLM budget). Never run the backfill to test a single change.
> Old **emails** are never re-pulled by anything short of the IMAP cursor
> resetting; restarting the stack does not re-ingest mail.

---

## 7. Gotchas worth remembering

- **The agent must run the code you're testing.** The dev stack runs from
  the **main** worktree, and `tsx --watch` does *not* reliably reload
  workspace-package (`packages/*`) changes. After editing a package or
  merging, **restart `apps/agent`** — otherwise you're tracing stale code.
- **New deps need `pnpm install` in the worktree the stack runs from**
  (main), then a restart, before a dynamically-imported parser resolves.
- **Empty string ≠ NULL** for `data.summary` (see §3). This trips up
  "has it been extracted?" checks constantly.
- **Edge direction is entity → node** (`mentioned_in`). Querying
  `source_id = node` finds nothing; the node is the `target_id`.
- **Emails get an `extractor_run` trace but no `content_ingest` trace** —
  the IMAP path doesn't call `recordIngest`. So the node-biography anchor
  is absent for mail; `extractor_run` is the only trace.
- **Attachments are real `file` nodes** under `inbox.<user>.attachments`,
  linked back via `email_attachments.file_node_id`. They extract through
  the same path as any file (PDF via pdf-parse, Word via mammoth, Excel
  via SheetJS). A **scanned / image-only PDF** (no text layer) is
  rasterized to PNG and run through the vision worker (OCR) — a
  `photo_ingest` trace with `data.mode='pdf_ocr'`, page-capped at
  `MAX_OCR_PAGES`; only if OCR yields nothing does the extractor record
  `skipped: no_text_layer`. Standalone **photos** still go through the
  image vision path (`isImageNeedingVision`).
