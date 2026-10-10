# Embedding model choice

Operator-facing guide for picking + switching the embedding model your Mantle install uses. For the runtime-side detail (how dispatch resolves, how the cache works, how the rebuild button is wired), see [`ai-workers.md` §5e](./ai-workers.md#5e-embedding--the-cross-cutting-kind).

For the wider memory architecture, [`memory.md`](./memory.md) is the spine; embeddings are the indexing layer that makes "find me that thing about X" actually work.

> **2026-05-31; every vector column became 768-dim.** Mantle migrated off
> cloud `openai/text-embedding-3-small` (1536-dim) to **EmbeddingGemma-300m
> (768-dim)** served by Ollama on the host. Every vector column is now
> `vector(768)` and the indexes are HNSW. The "Mantle-specific constraint" is
> therefore **768 dims, not 1536**. The migration history lives in
> [`handoff-local-embeddings-2026-05-30.md`](./_archive/handoff-local-embeddings-2026-05-30.md).
>
> **2026-06/07 (v0.103–0.104), the shipped DEFAULT flipped back to ONLINE.**
> The product default is now `openai/text-embedding-3-large` **MRL-reduced to
> 768 dims** (so the columns stay `vector(768)`), chosen in the onboarding
> **Memory** step and run via **OpenRouter** (default, reuses the chat key,
> slug `openai/text-embedding-3-large`) or OpenAI direct; the budget pick is
> `text-embedding-3-small` @768. The **local** EmbeddingGemma path is now the
> **advanced opt-in**: in the prod compose it sits behind the `local-embedder`
> profile and does NOT run by default (`docker compose --profile local-embedder
up -d`, then select provider `local` in Settings → Embedding). The keyless
> local config remains the pre-onboarding **fallback**, so a fresh box boots
> without any key, but semantic search is off until the Memory step (or a
> local setup) completes.

---

## TL;DR

| If you want…                                                            | Pick this                                                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The default, strongest wired recall, no extra key (the shipped case)    | **`openai/text-embedding-3-large`** truncated to 768 (MRL), via OpenRouter (reuses the chat key) or OpenAI direct |
| The budget online pick                                                  | `openai/text-embedding-3-small` truncated to 768 (MRL)                                                            |
| Private, free, no cloud calls (self-host purists)                       | `embeddinggemma:latest` via the `local` provider (Ollama, 768-dim), the advanced opt-in                           |
| Heavily multilingual (German + English emails, French notes, mixed CJK) | `google/gemini-embedding-001` truncated to 768 (MRL)                                                              |

**Don't switch unless you have a reason.** The shipped default (`text-embedding-3-large` @768) is the strongest wired option and rides the OpenRouter key you already have. Re-embedding the corpus to switch isn't free in _time_ (semantic search is degraded while the space is mixed), and switching to a model with a different native dim requires **another** schema migration. Read the rest of this doc before flipping.

---

## What an embedding model actually does

Takes any text (a note, an email, a fact) and turns it into a fixed-length vector of numbers, a point in a high-dimensional space. Two pieces of text whose vectors sit close together "mean similar things" to the model.

That's the whole trick. Once your corpus is embedded, "find me notes about X" becomes "find the vectors closest to the vector for X", a few milliseconds of math instead of scanning every document.

**What an embedding model is good at:**

- Semantic similarity ("calm" finds "relaxed", "peaceful", "serene")
- Cross-language matching IF the model was trained for it
- Topic-level recall (a query about "kubernetes" finds notes mentioning pods/clusters/helm)

**What it's bad at:**

- Exact-string matching (use FTS (full-text search) for that; Mantle uses both)
- Reasoning ("what's the dosage I take?" only finds vectors NEAR the answer; the LLM has to actually read it)
- Distinguishing close-but-different things (two notes about your two kids will read as nearly identical to most embedding models)

---

## The numbers: current models, side by side

Benchmark scores come from each model's published reports + MTEB leaderboard snapshots. Use as relative ordering, not absolute truth; your corpus is the real test.

| Model                                  | Native dims | Fits 768?    | Price ($/1M tokens) | MTEB (Eng) | MIRACL (multi) | Mantle status                                                                     |
| -------------------------------------- | ----------- | ------------ | ------------------- | ---------- | -------------- | --------------------------------------------------------------------------------- |
| `openai/text-embedding-3-large`        | 3072        | ✅ MRL → 768 | $0.130              | 64.6%      | 54.9%          | **Default (shipped)**: via OpenRouter or OpenAI                                   |
| `openai/text-embedding-3-small`        | 1536        | ✅ MRL → 768 | $0.020              | 62.3%      | 44.0%          | Wired (cloud), the budget pick in onboarding                                      |
| `embeddinggemma:latest` (local/Ollama) | 768         | ✅ native    | **$0 (local)**      | ~62%       | ~55%           | Opt-in local (`local-embedder` profile), also the keyless pre-onboarding fallback |
| `google/gemini-embedding-001`          | 3072        | ✅ MRL → 768 | $0.15               | ~68%       | ~62%           | Wired (cloud; top of MTEB)                                                        |
| `cohere/embed-multilingual-v3.0`       | 1024        | ❌ no MRL    | $0.10               | 60%        | ~56%           | Wired (needs migration)                                                           |
| `mistral/mistral-embed`                | 1024        | ❌ no MRL    | $0.10               | ~60%       | ~50%           | Wired (needs migration)                                                           |

**Definitions:**

- **Native dims**: how many numbers each vector contains by default. More = more resolution, more storage.
- **Fits 768?**: whether the model can write into Mantle's current `vector(768)` columns without a schema change. A model that natively emits 768 (EmbeddingGemma) fits exactly. A model that supports **MRL** (Matryoshka Representation Learning) truncation (OpenAI's `-3-large` and `-3-small`, Google's `gemini-embedding-*`) can be asked for a 768-dim vector and still be useful. A model with a fixed non-768 native dim and no MRL (Cohere, Mistral) does **not** fit without a migration.
- **MTEB**: Massive Text Embedding Benchmark. English retrieval, classification, clustering. The most widely-cited general score.
- **MIRACL**: Multilingual retrieval across 18 languages. Most predictive score for non-English corpora.

EmbeddingGemma punches well above its 308M-parameter / 768-dim weight class, competitive with much larger cloud models on MTEB while being free and local. If privacy or cost rules out cloud calls, it's the right pick by a wide margin, which is why it stays wired as the opt-in local path even though the shipped default is now `-3-large`.

---

## The Mantle-specific constraint: 768 dims

Mantle's vector columns are all `vector(768)` (migration `0060`). Every embedding writes to:

- `nodes.embedding` (the per-document spine)
- `entities.embedding` (per-person/place/thing)
- `facts.embedding` (per atomic fact)
- `content_chunks.embedding` (the ~2750-char passages for long-doc retrieval)
- `tool_result_chunks.embedding` (spilled tool-result store)

All four retrieval indexes are **HNSW** (rebuilt during the migration).

### Querying HNSW correctly (`withHnswPool`)

Two traps make a vector query silently miss the index (July 2026, after the
salience ranking landed):

1. **An adjusted ORDER BY is not index-eligible.** pgvector's HNSW only
   serves a _bare_ `embedding <=> $vec` ordering, add any arithmetic
   (salience, recency decay) and the planner falls back to a full scan +
   sort: the exact latency cliff migration 0057 removed. Proven with
   EXPLAIN: with seq/bitmap scans force-disabled, an adjusted ORDER BY still
   cannot touch `nodes_embedding_idx`.
2. **`hnsw.ef_search` caps the scan at 40 rows by default**: a fifth of the
   200-candidate pools the hybrid ranker asks for.

Every vector arm therefore follows one recipe, wrapped by `withHnswPool`
(`packages/search/src/hnsw.ts`): inner subquery with the bare-distance ORDER
BY + `LIMIT pool` (index-eligible) → `SET LOCAL hnsw.ef_search` sized to the
pool (clamped 40–1000) + `hnsw.iterative_scan = relaxed_order` (pgvector
≥ 0.8, probed safely) → outer re-rank with the adjustment terms. Applied to
`searchNodes`, `searchChunks`, and the per-turn fact/content queries in
`loadConversationContext`. Re-ranking inside a ≥5× pool is a bounded
approximation (the adjustments only penalise, never promote); at small
corpora the planner still picks the exact seq scan, which is correct.

**Small workspace scopes search exactly** (workspaces W3,
`packages/search/src/scope.ts`). Under a workspace scope row security keeps
the rows whose node the scope reads; chunks and windows hold no access copy
of their own and follow their node (migration 0249), so a grant change
rewrites no vector row. HNSW walks the whole graph and drops what the rule
hides, so a scope that holds a small share of a big brain gets short or poor
pools. When the scope's rows in the searched table number at most
`MANTLE_SCOPE_EXACT_MAX_ROWS` (default 15000: the scope's items, counted once
per transaction and bounded on the GIN index `nodes_read_ws_gin`, times the
table's rows per item from the planner statistics; a sermon brain has about
33 chunks and 85 windows per item), the node, chunk and window arms take the
scope's items by that index and their rows by node id, and order by the true
distance (an ORDER BY no index serves). Over the threshold they use HNSW as above, with
one more step: the scope is a run-time setting, so the planner cannot tell
how much of the brain it holds and guesses a tiny share, then plans "every
node, then its chunks, then sort" (0.3 to 2.7 s on a 50k-item brain). The
vector pool query therefore runs with sorts off (`withHnswPool(..., {
hnswFirst })`), which keeps it on the HNSW order; the setting is restored
right after. The GIN
index is built `CONCURRENTLY` by the migration runner after the migrations
(`packages/db/src/concurrent-indexes.ts`), never inside a migration.

One more driver trap while you're here: drizzle's postgres-js driver does
**not** serialise a JS array bind param into a Postgres array literal, use
`pgArrayLiteral` (`packages/search/src/pg.ts`) with a `::uuid[]`/`::text[]`
cast, or an inline literal for constants.

**What this means in practice:**

1. **A model that supports MRL truncation to 768 fits.** `openai/text-embedding-3-large` (native 3072, **the shipped default**), `openai/text-embedding-3-small` (native 1536, the budget pick), and `google/gemini-embedding-001` (native 3072) all honour a request for 768 dims, Mantle's dispatcher sends `dimensions: 768` (the `EMBEDDING_DIMS` constant in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts)). You get the model's better signal compressed into 768 dims, at the cost of cloud calls.

2. **A model that natively emits 768 dims also fits perfectly.** `embeddinggemma:latest` (the local opt-in). No truncation, no schema change.

3. **A model that emits something else (1024, 3072-fixed, or an un-truncated 1536) DOES NOT fit.** Mistral and Cohere (1024 native) would crash on first insert against the 768 column. The **[`/settings/embedding`](#the-one-config-settingsembedding) per-route dim probe** catches this; it embeds a sentinel string against the route and shows the live dimension, with a hard warning when it isn't 768.

To switch back to a cloud 1536 model (or a 1024 Cohere/Mistral model), every `vector(N)` column needs an ALTER TABLE to the new dim + an index rebuild + a full re-embed, the same shape as migration `0060`. Doable, not a button.

---

## What you actually pay attention to

Three questions, in order of importance:

### 1. Do you actually need to leave the shipped default?

This is the biggest signal-to-effort ratio in the whole decision.

- **You just want it to work well** → stay on `openai/text-embedding-3-large` @768. Strongest wired English recall, rides the OpenRouter key you already have, and the token cost is a rounding error at personal scale. This is why it's the default.
- **Privacy / self-hosting matter more than convenience** → switch to `embeddinggemma:latest` via the `local` provider. Nothing leaves the box, every embed is free, and it's genuinely competitive on quality; at the cost of running the embedder yourself (the `local-embedder` compose profile in prod, or a native Ollama in dev).
- **You have a measurable recall problem AND your corpus is heavily multilingual** → a cloud `gemini-embedding-001` (MRL → 768) is the strongest multilingual option.

### 2. How often does retrieval miss for you, today?

The honest test: when you ask Saskia about something specific from your past, does she find it? If she frequently says "I don't have a note about that" but you DO have one, the embedding model _might_ be the bottleneck, but it's usually not the first thing to check (see "Why this matters more than it seems" below).

If retrieval feels solid: stay where you are. Embedding upgrades give diminishing returns once you're "good enough."

### 3. What's the upfront cost of switching?

Switching models means re-embedding your entire corpus and (if the new model's native dim differs) a schema migration first. The token cost itself is a rounding error (a ~15K-vector install is cents even on the priciest cloud model). What costs you is:

- **Operational time during the rebuild**: for the duration of a re-embed, semantic search is degraded (some vectors new-model, some old-model; cosine similarity across spaces is meaningless). Plan it for an off-hours window.
- **A schema migration** if the dim changes, write + apply an ALTER TABLE across all five vector columns, rebuild the four HNSW indexes, then re-embed. This is what `0060` did for the 1536→768 move.

---

## The one config: `/settings/embedding`

Since migration `0061` the embedder is **one row** (`embedding_config`) edited at a dedicated page, not the `ai-workers` embedding kind (retired), not a per-agent or per-extractor field (removed), not an env var (now only seeds the no-row fallback). Every `embed()` call (ingest, retrieval, recall, MCP search, the spill store) resolves from this one row via `resolveEmbeddingConfig`. Agents _display_ the embedder; they can't set it. This is deliberate: the brain is **vector-space-locked** (every stored vector must come from the same model, or cosine similarity across the corpus is meaningless), so a single chokepoint is the only safe design.

The page holds: the **model** identity, a **primary route**, and an optional **same-model backup route** (see failover below). Each route has a **Test dimensions** probe that embeds a sentinel against that exact route (bypassing resolver + cache) and shows the live dim with a hard warning when it isn't 768.

## How to switch

At `/settings/embedding`:

1. **For a cloud model:** add an API key at `/settings/keys` first. (The `local` provider is keyless, Ollama needs no credential.)
2. **Set the model** (e.g. `embeddinggemma:latest`) and the **primary route** (provider + optional base URL + key).
3. **Click Test dimensions** on the route to confirm it emits 768 (or MRL-truncates to it). A non-768 result shows a destructive warning.
4. **If the native dim differs from 768**, write + apply a schema migration across every `vector()` column first. There is no button for this.
5. **Save**, then **Rebuild index** (or **Repopulate** if the column was nulled by a migration): the helper at [`packages/embeddings/src/reembed.ts`](../packages/embeddings/src/reembed.ts) walks `nodes`, `entities`, `facts`, `content_chunks`; idempotent under the `embedding_cache`.

The CLI alternative is the same code path:

```
pnpm -C server/web re-embed --model=<model-id>
```

For a **dimension-migration repopulation** (every embedding nulled by an ALTER), add `--repopulate` so it embeds rows whose vector is currently null rather than only refreshing populated ones:

```
pnpm -C server/web re-embed --repopulate --model=embeddinggemma:latest
```

`--model` is required when repopulating, without it the CLI falls back to the resolver's no-row default (the keyless local config) rather than the model you actually configured. A repopulation skips the extract-exempt nodes (Forum archive pages, a member's team request no admin has acted on yet; `packages/db/src/extract-exempt.ts`), which are never indexed.

During rebuild, the UI shows progress per layer. Until it completes, retrieval quality on older items is inconsistent, vectors written under the old model won't cosine-match against queries embedded under the new one.

A rebuild that walks `content_chunks` also deletes the brain's passage windows (below): they were embedded in the old space. Run `pnpm maintain chunk-windows --apply` after it to rebuild them.

---

## The local provider (EmbeddingGemma via Ollama)

The **advanced opt-in** (and, as a config, the keyless pre-onboarding fallback). To enable it on a prod box: `docker compose --profile local-embedder up -d` (the embedder does **not** run by default), then select provider `local` in Settings → Embedding. Worth knowing how it's wired:

- **Server:** Ollama on the host, OpenAI-compatible endpoint at `http://localhost:11434/v1`. Base URL is overridable via the `MANTLE_LOCAL_EMBEDDING_URL` env (defaults to that, so no env needed in dev). Keep `ollama serve` running.
- **Model:** `embeddinggemma:latest`, 768-dim, Gemma license (commercial-OK).
- **Keyless:** the `local` provider needs no API key; the embed path treats it as keyless (an earlier version threw "no api key for provider 'local'").
- **Free:** no per-token cost. The cost dashboard shows $0 for embedding traffic, correctly.
- **Adapter:** `local-embedding` (OpenAI-compatible shape). Lives in `packages/voice/src/adapters/`.

---

## Throughput on a CPU-only box (the three knobs)

EmbeddingGemma on a GPU is instant; on a **shared-vCPU VPS with no GPU** it's serial CPU inference, a few chunks per second at best. That's fine for everyday ingest (a note, an email, 1–3 short texts), but it bites when you bulk-ingest **large documents that chunk into hundreds of passages** (a big spreadsheet or PDF). Two things compound:

1. A single embed request that's too large can't finish inside the per-request timeout and aborts.
2. Multiple extractor jobs running at once contend for the same cores, so each one slows down and is more likely to time out.

**Symptom:** extractor traces failing at the `embed_batch` / `write_chunks` step with `"The operation was aborted due to timeout"`, the file ending up with only a title/summary chunk, and the job retry-looping (burning CPU). On a healthy box you never see this.

**The adapter already sub-batches**: [`local-embedding.ts`](../packages/voice/src/adapters/local-embedding.ts) splits the caller's batch into sequential sub-requests (default 16 texts each) so a retry resumes from the completed sub-batches via the embedding cache. Three env knobs tune it for slow/fast hardware (all passed through the compose `x-app-env` anchor):

| Env var                         | Default  | What it does                                                                     | When to change                                                                                     |
| ------------------------------- | -------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `EXTRACT_CONCURRENCY`           | `2`      | In-flight extractor jobs (clamped 1–16). The UI value wins over this; see below. | **Drop to `1`** on a CPU-only embedder so jobs don't contend for cores.                            |
| `MANTLE_LOCAL_EMBED_BATCH`      | `16`     | Texts per local-embedder HTTP request.                                           | **Lower (e.g. `8`)** on an especially slow box so each request clears the timeout; raise on a GPU. |
| `MANTLE_LOCAL_EMBED_TIMEOUT_MS` | `120000` | Per-request timeout (ms).                                                        | Raise for very slow hardware so a legitimate sub-batch isn't aborted early.                        |

**Set it from the UI, live.** Settings → AI workers → Extractor (and Settings →
Embedding → Performance & throughput) set the extractor count, 1 to 16. The
extractor re-reads it every 30s and adds or removes workers with no restart; a
removed worker finishes the job it holds first. The time budget is live the same
way. The panel also shows the queue: working now, waiting, retrying, done in the
last 10 minutes, dead-lettered (`GET/PATCH /api/embedding/extraction`). A host
that sends extraction to a hosted model (no local CPU embedder) can run 8 or
more; a CPU-only box should stay at 1 or 2.

```bash
# .env on a small CPU-only box:
EXTRACT_CONCURRENCY=1
MANTLE_LOCAL_EMBED_BATCH=8
```

**The real fix is hardware.** These knobs trade latency for reliability; they stop the timeouts, but a CPU embedder is still the throughput ceiling for both bulk ingest and live `search_chunks`. If you regularly ingest bulky documents, give the box more/faster vCPU, or point the embedding route at a **GPU or remote EmbeddingGemma** (`/settings/embedding`, same model, see failover below); then you can raise `MANTLE_LOCAL_EMBED_BATCH` back up. Re-ingest anything that landed thin while the box was timing out (clear its `data.summary`/`extract_completed_at` and re-fire `node_ingested`, or use the `process_extraction` tool).

**Hosted embedders run in parallel.** Every embed call goes through the shared provider pool (docs/provider-http.md). Before v0.237.11, Node 26's built-in fetch sent parallel POSTs to one provider one at a time, so 8 extractors embedding at once waited in line. Now they run side by side. A 429 from the provider backs off (2, 4, 8, 16 s) and retries; after that the error stands. If a provider keeps answering 429, lower the extractor count.

---

## Passage windows (optional, per brain)

A retrieval chunk is about 1.6k characters with one vector. A question about one sentence of it matches that vector weakly, so on a large single-topic corpus the right passage often never reaches the search pool. Passage windows give the inside of each chunk its own vectors: the chunk is cut into sentence windows of about 800 characters, each window is embedded, and passage search (`search_chunks`, the responder's auto-context) adds a window arm that returns the window's chunk. The model still sees the same chunk text, so the context budget does not change.

**Off by default.** It costs money and space, so a brain opts in:

```
pnpm maintain chunk-windows            # dry run: chunks, windows, tokens, estimated USD
pnpm maintain chunk-windows --apply    # switch on, then embed every chunk's windows
pnpm maintain chunk-windows --off      # switch off (rows kept)
pnpm maintain chunk-windows --clear    # switch off and delete the rows
```

`--parallel=N` (1 to 32, default 4) sets how many embed calls are in flight; each call is about 100 windows (whole chunks only, so a few over). `--apply` sets `embedding_config.chunk_windows` first, so the extractor writes windows for every chunk it (re)builds from then on; it is resumable. A one-window chunk reuses its chunk vector (no embed). The vectors are `halfvec` (half the bytes; the measured set ranked identically) in `content_chunk_windows`, which cascades with the chunk and has no text column. Window embeds skip `embedding_cache` (they are written once; the cache would only grow).

**Memory and speed.** The backfill holds at most `2 x parallel x 100` window vectors in Node (`parallel` embed calls and `parallel` inserts in flight, an embed call never waiting for an insert), whatever the corpus size: chunks are read as text only, a one-window chunk is copied inside Postgres (its vector never reaches Node), and each batch's vectors are dropped when its insert returns. Up to v0.237.12 a "page" was 500 chunks (about 1,300 windows), held as JS arrays, strings and one page-sized JSON parameter at once; `--parallel=16` inside mantle_web pushed the web container past its 3 GB limit and the kernel killed the task (2026-10-04).

Measured 2026-10-04 on a workstation copy shaped like the library brain (122,000 chunks of about 1,350 characters, 239,639 windows, 196,065 embedded) with a fake embedder that answers each 100-window call in 1 s (no spend). Peak RSS of the task process (it includes about 280 MB for tsx and the workspace) and wall time:

| Code                        | `--parallel=4`   | `--parallel=16`   |
| --------------------------- | ---------------- | ----------------- |
| v0.237.12 (500-chunk pages) | 555 MB, 15.0 min | 1,047 MB, 5.6 min |
| now (100-window batches)    | 458 MB, 13.7 min | 486 MB, 5.3 min   |

Run end to end through `scripts/box-maintain.sh` with `--memory=1g --parallel=16`, the whole container (pnpm, the runner and the task) stayed at 500 to 530 MiB and finished in 5.2 min (46k windows/min). A real provider is slower per call, so on a box the windows per minute scale with `--parallel` until the provider answers 429. `--parallel=16` in a 1g container is a safe default for a brain this size.

**On a box, run it in its own container**, not inside mantle_web and not with `nohup` over ssh: `scripts/box-maintain.sh <box> chunk-windows --apply --yes --parallel=16` ([maintenance-runner.md](./maintenance-runner.md), "Long runs on a box"). One maintenance run per box at a time.

What it costs, measured on a 122k-chunk library brain (docs/recall-eval.md, "Paraphrased questions"): 314,004 windows, about 43M tokens, about USD 6 once with `openai/text-embedding-3-large`; about 1.1 GB of table and index; ingest embeds about twice the tokens; a judged search scores twice the pool (about USD 0.0013 more with the decider's `passage_scoring`). What it bought there: paraphrased questions found their passage in the top 10 for 63% of cases instead of 40% with the judge, 50% instead of 28% without it; all question types 75% instead of 53%. One trade: four "named verse, answer in a sermon" questions moved from rank 1 to rank 2 or 3. On a small brain with short documents it changes nothing (each document is one window).

## Primary + backup routes (failover)

Availability without breaking the space lock. The config holds **two routes to the same model**: a primary and an optional backup. They differ only in _route_ (provider, base URL, API key) **never in model**. The `/settings/embedding` form keeps the backup pinned to the primary's model id for exactly this reason.

How it behaves at runtime ([`doEmbed`](../packages/embeddings/src/index.ts)):

- The primary route runs first.
- On a **route-down** error, connection refused, DNS failure, request timeout, or a 5xx (classified by `isRouteDownError`); it retries the misses on the backup route and stamps `last_failover_at` (surfaced on the page).
- On an **account** error (no credits, a refused key, no key, a model the provider does not offer; `isAccountError` in [`provider-error.ts`](../packages/embeddings/src/provider-error.ts)) it fails over too: the backup is another provider or key, which gets round exactly that. Added 2026-10-04, see "Provider outages" below.
- On a **bad-input** error (any other 4xx, unsupported input) it rethrows, a second route wouldn't help.
- The cache is keyed on **model only**, so both routes share entries and a failover never pollutes the cache.

**Why same-model only.** Unlike chat (where a different backup model is fine), a different _embedding_ model produces vectors in a different coordinate system. If the backup embedded the query with another model, it wouldn't cosine-match the corpus the primary built; retrieval would silently return garbage, and anything ingested during the outage would be permanently off-space until re-embedded. So a safe embedding backup is the _same_ model on a different host: e.g. primary `local` Ollama on the Mac → backup a second Ollama / a hosted EmbeddingGemma. (Cloud models that aren't EmbeddingGemma make sense as a _primary_ you commit to, not as a failover target.)

**Why EmbeddingGemma and not jina-embeddings-v5?** jina-v5 was evaluated and rejected for the LM Studio path; it loads as `type=llm` there (Qwen3 base) and LM Studio silently falls back to another embedder. EmbeddingGemma loads as a real embedder (768-dim, proper pooling). If jina-v5 is ever wanted, serve it via llama.cpp `--pooling last` / TEI / vLLM, not LM Studio.

---

## Provider outages (alerts and automatic recovery)

**What happened (2026-10-04).** Two brains embedded through OpenAI direct while the account had no credits. OpenAI answered `429 insufficient_quota`, which looks like a rate limit. Every extract job retried five times and went to the dead-letter queue, new files were not indexed, and some chat turns had no retrieved context. No backup route was set. Nobody was told: the only traces were log lines and the /debug/integrity dead-letter check. When the admin switched to OpenRouter, new embeds worked, but the backlog did not move until a restart.

**1. Error classes** ([`provider-error.ts`](../packages/embeddings/src/provider-error.ts)). `classifyProviderError(err)` sorts a provider error:

| Class               | Codes                                                                                                               | What the brain does                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Permanent (account) | `quota` (402, a 429 or 403 that says no credits), `auth` (401, 403), `no_key`, `model` (404, a 400 about the model) | Fails over to the backup route. Pauses the extract queue once confirmed. Shows the alert at once. |
| Transient           | `rate_limit` (a plain 429), `server` (5xx), `network`, `timeout`                                                    | Retries with backoff, as before. Shows the alert only after 10 min.                               |
| None                | a bad input, a 403 for flagged input, a parse error                                                                 | Nothing new: it says nothing about the provider.                                                  |

A no-credits 429 no longer waits through the rate-limit backoff (2, 4, 8, 16 s): no wait fixes an empty account. Chat failover uses the same rule ([`chat-failover.md`](./chat-failover.md) §4).

**2. The alert** (migration `0230`, table `provider_alerts`, store in [`provider-alerts.ts`](../packages/db/src/provider-alerts.ts)). One row per brain and subject (`embedding`, `extraction`). Every embed call reports its outcome ([`provider-outage.ts`](../packages/embeddings/src/provider-outage.ts)): a failure opens or extends the row (one write per subject per minute per process), and a call that reaches a provider and works closes it. The extractor's chat calls report the same way for `extraction`. The `reason` is fixed text per code, never the provider's body, so a key or an account id never reaches a banner or a phone.

What admins (owner and admin logins) see, and members and clients never see:

- the app-shell banner and the Settings, Embedding page: "Embeddings are failing since 08:14: The provider account has no credits or quota left. New files are not indexed and search has less context. 30 items wait." with the fix (add credits, check the key, switch provider, add a backup route) and a **Try again** button;
- the "Needs you" feed (`GET /api/team-admin/needs-you`, field `providers`), which the live stream refreshes: the table's trigger raises `needs_you_changed` when what an admin sees changes;
- one phone push per outage to admin devices ("Embeddings are failing"), on the same toggle as other "things waiting for you".

`GET /api/embedding/recover` returns the shown alerts; `GET /api/embedding` returns them with the config.

**3. The circuit and automatic recovery** ([`provider-circuit.ts`](../server/api/src/agent/provider-circuit.ts), wired in [`extract-queue.ts`](../server/api/src/agent/extract-queue.ts)).

- **Open.** A job fails with a permanent class. One tiny probe call confirms it is the account and not that one document. Then the queue pauses (no worker takes a job, so nothing burns its retries) and the alert is marked paused.
- **Probe.** While an alert is shown, the agent makes ONE tiny call at 5 min, then 10, 20, 40, then every 60 min. One probe in flight at a time; none while all works.
- **Recover.** When a probe works, or the alert closes elsewhere (any embed that works closes it), the agent resumes the queue, re-drives the dead-letter queue and runs the unextracted-node sweep. These are the same bounded code paths as at boot (1000 jobs, 1000 nodes, `MANTLE_EXTRACT_DRAIN_LIMIT`). No restart.
- **Admin actions probe at once.** A save on Settings, Embedding (and `PATCH /api/embedding/extraction`) and the **Try again** button (`POST /api/embedding/recover`) raise `provider_recover`. The agent probes the open alert now, and with no alert open it still recovers a waiting dead-letter backlog after one probe works. The 30 s config poll catches a lost notify. A restart probes a paused alert at once and holds the queue paused until it works.

**Worst-case cost.** A probe is one request of a few tokens: at most 26 a day per subject while an outage lasts (4 in the first 75 min, then one an hour), plus one per admin action, and none while all works. A recovery enqueues at most 1000 dead letters and 1000 unextracted nodes; they run through the queue's own worker count and retry policy, so they cost what the backlog would have cost anyway. Recovery runs at most once per 30 min on its own (a probe that works, an alert closing) and at most once per 2 min on an admin action. A job that fails for its own reason gets one more round of 6 attempts per recovery, as it does per restart. No cron, no trigger starts LLM work: the table's trigger only notifies.

**4. Backup route guidance.** With no backup set, Settings, Embedding suggests a same-model one when the other provider's key is saved ([`embedding-backup.ts`](../server/web/lib/embedding-backup.ts)): OpenAI direct with `text-embedding-3-*` gets OpenRouter, and the reverse. Both serve the same vectors, and both adapters take the same slug (OpenRouter takes `text-embedding-3-large` and `openai/text-embedding-3-large`; the OpenAI adapter drops an `openai/` prefix), so the backup needs no second model field. Onboarding sets that backup by default when the key is there, after a probe at 768 dims.

---

## Per-provider quirks worth knowing

### Local (Ollama / LM Studio)

- Keyless, free, private. The opt-in path for self-host purists.
- 768 native, fits the column exactly, no MRL games.
- Requires the local server to be up. If `ollama serve` is down, embedding calls fail (no cloud fallback; embeddings can't fail over across spaces; a 1536 cloud fallback would crash on the 768 column).

### OpenAI

- `text-embedding-3-large` (the shipped default) and `text-embedding-3-small` (the budget pick) both honour the `dimensions` parameter for MRL truncation → coerced to 768.
- The dispatcher sends `dimensions: 768` for MRL-capable models.
- Route via **OpenRouter** (default, the same key as chat, slug `openai/text-embedding-3-large`) or an OpenAI key direct. The OpenAI adapter drops an `openai/` prefix, so one slug serves both routes: set the other one as the backup.
- A `429` with `insufficient_quota` means **no credits**, not a rate limit. The brain treats it as an account error (see "Provider outages").

### Google (Gemini)

- `gemini-embedding-001` currently tops the MTEB leaderboard and honours `outputDimensionality` for MRL, coerces to 768. Strongest multilingual option if you must go cloud.
- `gemini-embedding-2-preview` is the only multimodal embedding option in the catalogue.

### Cohere / Mistral

- 1024-dim native, no MRL. **Don't fit Mantle's 768 column**: require a schema migration.
- Cohere is asymmetric (`input_type` document vs query); the adapter defaults to `'search_document'`.

### OpenRouter

- Aggregator, proxies the cloud providers above through one key. Includes open-weight embedding models (sentence-transformers, BGE, GTE, E5), several of which are natively 768 and would fit.
- The only adapter that accepts multimodal inputs via the unified endpoint.
- Discovery gotcha: OR splits chat + embeddings across two `/v1/models` endpoints; some embedding models lack `embed` in their slug, so id-pattern filtering misses them (see [`ai-workers.md` §5e.3](./ai-workers.md#5e3-discovery--per-provider)).

---

## When NOT to switch

A short list of reasons to leave your current embedder alone:

1. **You're on the shipped default.** `text-embedding-3-large` @768 is the strongest wired option for English recall; there's little headroom above it, and every switch costs a re-embed.
2. **You chose local deliberately.** If privacy is the point, switching to a cloud model sends your entire corpus to a third party, the exact thing you opted out of. And local embedding has no per-token cost.
3. **Retrieval already feels solid.** Don't fix what isn't broken, the upgrade headroom on a personal English/German corpus is small (that goes for EmbeddingGemma too, which is competitive).
4. **Your corpus is small (< 1000 vectors).** At this scale every model finds everything.
5. **You haven't tried tuning the retrieval params first.** `top_k`, the similarity threshold, the chunk size; these often matter more than the embedding model. The responder's `memory_config.{fact_limit, content_hit_limit, chunk_limit, digest_limit}` knobs at `/settings/agents`, plus the June-2026 ranking factors (`MANTLE_{SALIENCE_LAMBDA, RECENCY_EPISODIC, RECENCY_CONTENT, RECENCY_TAU_DAYS, QUERY_ENRICH}` env) are where to look first. Ranking is no longer raw cosine, see [`memory.md` §7](./memory.md#7-the-retrieval-order-in-the-prompt) and measure changes with `pnpm -C server/web eval:recall`.

---

## Why this matters more than it seems

Embeddings are the cheap memory layer that makes the expensive layers (LLM context, your reading time) usable. A 5% better embedding model means:

- 5% more "Saskia remembered that thing" moments
- 5% fewer "I don't have a note about that" misses
- 5% less context-window pressure on the LLM (it gets the RIGHT 3 notes instead of 5 mediocre ones)

Compounded across hundreds of queries, this is the difference between a memory system that feels uncannily good and one that feels mid. **But it's not the bottleneck most installs hit first.** Most retrieval misses come from indexing (the wrong things got embedded, or weren't chunked well) or from query phrasing. The embedding model upgrade is the third-most-important lever, not the first.

That's why the recommendation here is "stay on the shipped default unless you have a reason." The reasons are real when they apply, a privacy stance that rules out cloud calls (→ go local), a measured multilingual recall problem (→ Gemini), but they're rare, and every switch costs a corpus re-embed.
