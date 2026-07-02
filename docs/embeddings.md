# Embedding model choice

Operator-facing guide for picking + switching the embedding model your Mantle install uses. For the runtime-side detail (how dispatch resolves, how the cache works, how the rebuild button is wired), see [`ai-workers.md` §5e](./ai-workers.md#5e-embedding--the-cross-cutting-kind).

For the wider memory architecture, [`memory.md`](./memory.md) is the spine; embeddings are the indexing layer that makes "find me that thing about X" actually work.

> **2026-05-31 — every vector column became 768-dim.** Mantle migrated off
> cloud `openai/text-embedding-3-small` (1536-dim) to **EmbeddingGemma-300m
> (768-dim)** served by Ollama on the host. Every vector column is now
> `vector(768)` and the indexes are HNSW. The "Mantle-specific constraint" is
> therefore **768 dims, not 1536**. The migration history lives in
> [`handoff-local-embeddings-2026-05-30.md`](./_archive/handoff-local-embeddings-2026-05-30.md).
>
> **2026-06/07 (v0.103–0.104) — the shipped DEFAULT flipped back to ONLINE.**
> The product default is now `openai/text-embedding-3-large` **MRL-reduced to
> 768 dims** (so the columns stay `vector(768)`), chosen in the onboarding
> **Memory** step and run via **OpenRouter** (default — reuses the chat key,
> slug `openai/text-embedding-3-large`) or OpenAI direct; the budget pick is
> `text-embedding-3-small` @768. The **local** EmbeddingGemma path is now the
> **advanced opt-in**: in the prod compose it sits behind the `local-embedder`
> profile and does NOT run by default (`docker compose --profile local-embedder
> up -d`, then select provider `local` in Settings → Embedding). The keyless
> local config remains the pre-onboarding **fallback**, so a fresh box boots
> without any key — but semantic search is off until the Memory step (or a
> local setup) completes.

---

## TL;DR

| If you want… | Pick this |
|---|---|
| The default — strongest wired recall, no extra key (the shipped case) | **`openai/text-embedding-3-large`** truncated to 768 (MRL), via OpenRouter (reuses the chat key) or OpenAI direct |
| The budget online pick | `openai/text-embedding-3-small` truncated to 768 (MRL) |
| Private, free, no cloud calls (self-host purists) | `embeddinggemma:latest` via the `local` provider (Ollama, 768-dim) — the advanced opt-in |
| Heavily multilingual (German + English emails, French notes, mixed CJK) | `google/gemini-embedding-001` truncated to 768 (MRL) |

**Don't switch unless you have a reason.** The shipped default (`text-embedding-3-large` @768) is the strongest wired option and rides the OpenRouter key you already have. Re-embedding the corpus to switch isn't free in *time* (semantic search is degraded while the space is mixed), and switching to a model with a different native dim requires **another** schema migration. Read the rest of this doc before flipping.

---

## What an embedding model actually does

Takes any text (a note, an email, a fact) and turns it into a fixed-length vector of numbers — a point in a high-dimensional space. Two pieces of text whose vectors sit close together "mean similar things" to the model.

That's the whole trick. Once your corpus is embedded, "find me notes about X" becomes "find the vectors closest to the vector for X" — a few milliseconds of math instead of scanning every document.

**What an embedding model is good at:**
- Semantic similarity ("calm" finds "relaxed", "peaceful", "serene")
- Cross-language matching IF the model was trained for it
- Topic-level recall (a query about "kubernetes" finds notes mentioning pods/clusters/helm)

**What it's bad at:**
- Exact-string matching (use FTS — full-text search — for that; Mantle uses both)
- Reasoning ("what's the dosage I take?" only finds vectors NEAR the answer; the LLM has to actually read it)
- Distinguishing close-but-different things (two notes about your two kids will read as nearly identical to most embedding models)

---

## The numbers — current models, side by side

Benchmark scores come from each model's published reports + MTEB leaderboard snapshots. Use as relative ordering, not absolute truth — your corpus is the real test.

| Model | Native dims | Fits 768? | Price ($/1M tokens) | MTEB (Eng) | MIRACL (multi) | Mantle status |
|---|---|---|---|---|---|---|
| `openai/text-embedding-3-large` | 3072 | ✅ MRL → 768 | $0.130 | 64.6% | 54.9% | **Default (shipped)** — via OpenRouter or OpenAI |
| `openai/text-embedding-3-small` | 1536 | ✅ MRL → 768 | $0.020 | 62.3% | 44.0% | Wired (cloud) — the budget pick in onboarding |
| `embeddinggemma:latest` (local/Ollama) | 768 | ✅ native | **$0 (local)** | ~62% | ~55% | Opt-in local (`local-embedder` profile) — also the keyless pre-onboarding fallback |
| `google/gemini-embedding-001` | 3072 | ✅ MRL → 768 | $0.15 | ~68% | ~62% | Wired (cloud; top of MTEB) |
| `cohere/embed-multilingual-v3.0` | 1024 | ❌ no MRL | $0.10 | 60% | ~56% | Wired (needs migration) |
| `mistral/mistral-embed` | 1024 | ❌ no MRL | $0.10 | ~60% | ~50% | Wired (needs migration) |

**Definitions:**
- **Native dims** — how many numbers each vector contains by default. More = more resolution, more storage.
- **Fits 768?** — whether the model can write into Mantle's current `vector(768)` columns without a schema change. A model that natively emits 768 (EmbeddingGemma) fits exactly. A model that supports **MRL** (Matryoshka Representation Learning) truncation — OpenAI's `-3-large` and `-3-small`, Google's `gemini-embedding-*` — can be asked for a 768-dim vector and still be useful. A model with a fixed non-768 native dim and no MRL (Cohere, Mistral) does **not** fit without a migration.
- **MTEB** — Massive Text Embedding Benchmark. English retrieval, classification, clustering. The most widely-cited general score.
- **MIRACL** — Multilingual retrieval across 18 languages. Most predictive score for non-English corpora.

EmbeddingGemma punches well above its 308M-parameter / 768-dim weight class — competitive with much larger cloud models on MTEB while being free and local. If privacy or cost rules out cloud calls, it's the right pick by a wide margin — which is why it stays wired as the opt-in local path even though the shipped default is now `-3-large`.

---

## The Mantle-specific constraint: 768 dims

Mantle's vector columns are all `vector(768)` (migration `0060`). Every embedding writes to:
- `nodes.embedding` (the per-document spine)
- `entities.embedding` (per-person/place/thing)
- `facts.embedding` (per atomic fact)
- `content_chunks.embedding` (the ~1500-char passages for long-doc retrieval)
- `tool_result_chunks.embedding` (spilled tool-result store)

All four retrieval indexes are **HNSW** (rebuilt during the migration).

**What this means in practice:**

1. **A model that supports MRL truncation to 768 fits.** `openai/text-embedding-3-large` (native 3072, **the shipped default**), `openai/text-embedding-3-small` (native 1536, the budget pick), and `google/gemini-embedding-001` (native 3072) all honour a request for 768 dims — Mantle's dispatcher sends `dimensions: 768` (the `EMBEDDING_DIMS` constant in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts)). You get the model's better signal compressed into 768 dims, at the cost of cloud calls.

2. **A model that natively emits 768 dims also fits perfectly.** `embeddinggemma:latest` (the local opt-in). No truncation, no schema change.

3. **A model that emits something else (1024, 3072-fixed, or an un-truncated 1536) DOES NOT fit.** Mistral and Cohere (1024 native) would crash on first insert against the 768 column. The **[`/settings/embedding`](#the-one-config-settingsembedding) per-route dim probe** catches this — it embeds a sentinel string against the route and shows the live dimension, with a hard warning when it isn't 768.

To switch back to a cloud 1536 model (or a 1024 Cohere/Mistral model), every `vector(N)` column needs an ALTER TABLE to the new dim + an index rebuild + a full re-embed — the same shape as migration `0060`. Doable, not a button.

---

## What you actually pay attention to

Three questions, in order of importance:

### 1. Do you actually need to leave the shipped default?

This is the biggest signal-to-effort ratio in the whole decision.

- **You just want it to work well** → stay on `openai/text-embedding-3-large` @768. Strongest wired English recall, rides the OpenRouter key you already have, and the token cost is a rounding error at personal scale. This is why it's the default.
- **Privacy / self-hosting matter more than convenience** → switch to `embeddinggemma:latest` via the `local` provider. Nothing leaves the box, every embed is free, and it's genuinely competitive on quality — at the cost of running the embedder yourself (the `local-embedder` compose profile in prod, or a native Ollama in dev).
- **You have a measurable recall problem AND your corpus is heavily multilingual** → a cloud `gemini-embedding-001` (MRL → 768) is the strongest multilingual option.

### 2. How often does retrieval miss for you, today?

The honest test: when you ask Saskia about something specific from your past, does she find it? If she frequently says "I don't have a note about that" but you DO have one, the embedding model *might* be the bottleneck — but it's usually not the first thing to check (see "Why this matters more than it seems" below).

If retrieval feels solid: stay where you are. Embedding upgrades give diminishing returns once you're "good enough."

### 3. What's the upfront cost of switching?

Switching models means re-embedding your entire corpus and — if the new model's native dim differs — a schema migration first. The token cost itself is a rounding error (a ~15K-vector install is cents even on the priciest cloud model). What costs you is:
- **Operational time during the rebuild** — for the duration of a re-embed, semantic search is degraded (some vectors new-model, some old-model; cosine similarity across spaces is meaningless). Plan it for an off-hours window.
- **A schema migration** if the dim changes — write + apply an ALTER TABLE across all five vector columns, rebuild the four HNSW indexes, then re-embed. This is what `0060` did for the 1536→768 move.

---

## The one config: `/settings/embedding`

Since migration `0061` the embedder is **one row** (`embedding_config`) edited at a dedicated page — not the `ai-workers` embedding kind (retired), not a per-agent or per-extractor field (removed), not an env var (now only seeds the no-row fallback). Every `embed()` call — ingest, retrieval, recall, MCP search, the spill store — resolves from this one row via `resolveEmbeddingConfig`. Agents *display* the embedder; they can't set it. This is deliberate: the brain is **vector-space-locked** (every stored vector must come from the same model, or cosine similarity across the corpus is meaningless), so a single chokepoint is the only safe design.

The page holds: the **model** identity, a **primary route**, and an optional **same-model backup route** (see failover below). Each route has a **Test dimensions** probe that embeds a sentinel against that exact route (bypassing resolver + cache) and shows the live dim with a hard warning when it isn't 768.

## How to switch

At `/settings/embedding`:

1. **For a cloud model:** add an API key at `/settings/keys` first. (The `local` provider is keyless — Ollama needs no credential.)
2. **Set the model** (e.g. `embeddinggemma:latest`) and the **primary route** (provider + optional base URL + key).
3. **Click Test dimensions** on the route to confirm it emits 768 (or MRL-truncates to it). A non-768 result shows a destructive warning.
4. **If the native dim differs from 768**, write + apply a schema migration across every `vector()` column first. There is no button for this.
5. **Save**, then **Rebuild index** (or **Repopulate** if the column was nulled by a migration) — the helper at [`packages/embeddings/src/reembed.ts`](../packages/embeddings/src/reembed.ts) walks `nodes`, `entities`, `facts`, `content_chunks`; idempotent under the `embedding_cache`.

The CLI alternative is the same code path:
```
pnpm -C apps/web re-embed --model=<model-id>
```
For a **dimension-migration repopulation** (every embedding nulled by an ALTER), add `--repopulate` so it embeds rows whose vector is currently null rather than only refreshing populated ones:
```
pnpm -C apps/web re-embed --repopulate --model=embeddinggemma:latest
```
`--model` is required when repopulating — without it the CLI falls back to the resolver's no-row default (the keyless local config) rather than the model you actually configured.

During rebuild, the UI shows progress per layer. Until it completes, retrieval quality on older items is inconsistent — vectors written under the old model won't cosine-match against queries embedded under the new one.

---

## The local provider (EmbeddingGemma via Ollama)

The **advanced opt-in** (and, as a config, the keyless pre-onboarding fallback). To enable it on a prod box: `docker compose --profile local-embedder up -d` (the embedder does **not** run by default), then select provider `local` in Settings → Embedding. Worth knowing how it's wired:

- **Server:** Ollama on the host, OpenAI-compatible endpoint at `http://localhost:11434/v1`. Base URL is overridable via the `MANTLE_LOCAL_EMBEDDING_URL` env (defaults to that, so no env needed in dev). Keep `ollama serve` running.
- **Model:** `embeddinggemma:latest` — 768-dim, Gemma license (commercial-OK).
- **Keyless:** the `local` provider needs no API key; the embed path treats it as keyless (an earlier version threw "no api key for provider 'local'").
- **Free:** no per-token cost. The cost dashboard shows $0 for embedding traffic, correctly.
- **Adapter:** `local-embedding` (OpenAI-compatible shape). Lives in `packages/voice/src/adapters/`.

---

## Throughput on a CPU-only box (the three knobs)

EmbeddingGemma on a GPU is instant; on a **shared-vCPU VPS with no GPU** it's serial CPU inference — a few chunks per second at best. That's fine for everyday ingest (a note, an email — 1–3 short texts), but it bites when you bulk-ingest **large documents that chunk into hundreds of passages** (a big spreadsheet or PDF). Two things compound:

1. A single embed request that's too large can't finish inside the per-request timeout and aborts.
2. Multiple extractor jobs running at once contend for the same cores, so each one slows down and is more likely to time out.

**Symptom:** extractor traces failing at the `embed_batch` / `write_chunks` step with `"The operation was aborted due to timeout"`, the file ending up with only a title/summary chunk, and the job retry-looping (burning CPU). On a healthy box you never see this.

**The adapter already sub-batches** — [`local-embedding.ts`](../packages/voice/src/adapters/local-embedding.ts) splits the caller's batch into sequential sub-requests (default 16 texts each) so a retry resumes from the completed sub-batches via the embedding cache. Three env knobs tune it for slow/fast hardware (all passed through the compose `x-app-env` anchor):

| Env var | Default | What it does | When to change |
| --- | --- | --- | --- |
| `EXTRACT_CONCURRENCY` | `2` | In-flight extractor jobs (clamped 1–8). | **Drop to `1`** on a CPU-only embedder so jobs don't contend for cores. |
| `MANTLE_LOCAL_EMBED_BATCH` | `16` | Texts per local-embedder HTTP request. | **Lower (e.g. `8`)** on an especially slow box so each request clears the timeout; raise on a GPU. |
| `MANTLE_LOCAL_EMBED_TIMEOUT_MS` | `120000` | Per-request timeout (ms). | Raise for very slow hardware so a legitimate sub-batch isn't aborted early. |

```bash
# .env on a small CPU-only box:
EXTRACT_CONCURRENCY=1
MANTLE_LOCAL_EMBED_BATCH=8
```

**The real fix is hardware.** These knobs trade latency for reliability — they stop the timeouts, but a CPU embedder is still the throughput ceiling for both bulk ingest and live `search_chunks`. If you regularly ingest bulky documents, give the box more/faster vCPU, or point the embedding route at a **GPU or remote EmbeddingGemma** (`/settings/embedding`, same model — see failover below); then you can raise `MANTLE_LOCAL_EMBED_BATCH` back up. Re-ingest anything that landed thin while the box was timing out (clear its `data.summary`/`extract_completed_at` and re-fire `node_ingested`, or use the `process_extraction` tool).

---

## Primary + backup routes (failover)

Availability without breaking the space lock. The config holds **two routes to the same model**: a primary and an optional backup. They differ only in *route* — provider, base URL, API key — **never in model**. The `/settings/embedding` form keeps the backup pinned to the primary's model id for exactly this reason.

How it behaves at runtime ([`doEmbed`](../packages/embeddings/src/index.ts)):
- The primary route runs first.
- On a **route-down** error — connection refused, DNS failure, request timeout, or a 5xx (classified by `isRouteDownError`) — it retries the misses on the backup route and stamps `last_failover_at` (surfaced on the page).
- On a **bad-input** error (4xx, unsupported input) it rethrows — a second route wouldn't help.
- The cache is keyed on **model only**, so both routes share entries and a failover never pollutes the cache.

**Why same-model only.** Unlike chat (where a different backup model is fine), a different *embedding* model produces vectors in a different coordinate system. If the backup embedded the query with another model, it wouldn't cosine-match the corpus the primary built — retrieval would silently return garbage, and anything ingested during the outage would be permanently off-space until re-embedded. So a safe embedding backup is the *same* model on a different host: e.g. primary `local` Ollama on the Mac → backup a second Ollama / a hosted EmbeddingGemma. (Cloud models that aren't EmbeddingGemma make sense as a *primary* you commit to, not as a failover target.)

**Why EmbeddingGemma and not jina-embeddings-v5?** jina-v5 was evaluated and rejected for the LM Studio path — it loads as `type=llm` there (Qwen3 base) and LM Studio silently falls back to another embedder. EmbeddingGemma loads as a real embedder (768-dim, proper pooling). If jina-v5 is ever wanted, serve it via llama.cpp `--pooling last` / TEI / vLLM, not LM Studio.

---

## Per-provider quirks worth knowing

### Local (Ollama / LM Studio)
- Keyless, free, private. The opt-in path for self-host purists.
- 768 native — fits the column exactly, no MRL games.
- Requires the local server to be up. If `ollama serve` is down, embedding calls fail (no cloud fallback — embeddings can't fail over across spaces; a 1536 cloud fallback would crash on the 768 column).

### OpenAI
- `text-embedding-3-large` (the shipped default) and `text-embedding-3-small` (the budget pick) both honour the `dimensions` parameter for MRL truncation → coerced to 768.
- The dispatcher sends `dimensions: 768` for MRL-capable models.
- Route via **OpenRouter** (default — the same key as chat, slug `openai/text-embedding-3-large`) or an OpenAI key direct.

### Google (Gemini)
- `gemini-embedding-001` currently tops the MTEB leaderboard and honours `outputDimensionality` for MRL — coerces to 768. Strongest multilingual option if you must go cloud.
- `gemini-embedding-2-preview` is the only multimodal embedding option in the catalogue.

### Cohere / Mistral
- 1024-dim native, no MRL. **Don't fit Mantle's 768 column** — require a schema migration.
- Cohere is asymmetric (`input_type` document vs query); the adapter defaults to `'search_document'`.

### OpenRouter
- Aggregator — proxies the cloud providers above through one key. Includes open-weight embedding models (sentence-transformers, BGE, GTE, E5), several of which are natively 768 and would fit.
- The only adapter that accepts multimodal inputs via the unified endpoint.
- Discovery gotcha: OR splits chat + embeddings across two `/v1/models` endpoints; some embedding models lack `embed` in their slug, so id-pattern filtering misses them (see [`ai-workers.md` §5e.3](./ai-workers.md#5e3-discovery--per-provider)).

---

## When NOT to switch

A short list of reasons to leave your current embedder alone:

1. **You're on the shipped default.** `text-embedding-3-large` @768 is the strongest wired option for English recall — there's little headroom above it, and every switch costs a re-embed.
2. **You chose local deliberately.** If privacy is the point, switching to a cloud model sends your entire corpus to a third party — the exact thing you opted out of. And local embedding has no per-token cost.
3. **Retrieval already feels solid.** Don't fix what isn't broken — the upgrade headroom on a personal English/German corpus is small (that goes for EmbeddingGemma too, which is competitive).
4. **Your corpus is small (< 1000 vectors).** At this scale every model finds everything.
5. **You haven't tried tuning the retrieval params first.** `top_k`, the similarity threshold, the chunk size — these often matter more than the embedding model. The responder's `memory_config.{fact_limit, content_hit_limit, chunk_limit, digest_limit}` knobs at `/settings/agents`, plus the June-2026 ranking factors (`MANTLE_{SALIENCE_LAMBDA, RECENCY_EPISODIC, RECENCY_CONTENT, RECENCY_TAU_DAYS, QUERY_ENRICH}` env) are where to look first. Ranking is no longer raw cosine — see [`memory.md` §7](./memory.md#7-the-retrieval-order-in-the-prompt) and measure changes with `pnpm -C apps/web eval:recall`.

---

## Why this matters more than it seems

Embeddings are the cheap memory layer that makes the expensive layers (LLM context, your reading time) usable. A 5% better embedding model means:
- 5% more "Saskia remembered that thing" moments
- 5% fewer "I don't have a note about that" misses
- 5% less context-window pressure on the LLM (it gets the RIGHT 3 notes instead of 5 mediocre ones)

Compounded across hundreds of queries, this is the difference between a memory system that feels uncannily good and one that feels mid. **But it's not the bottleneck most installs hit first.** Most retrieval misses come from indexing (the wrong things got embedded, or weren't chunked well) or from query phrasing. The embedding model upgrade is the third-most-important lever, not the first.

That's why the recommendation here is "stay on the shipped default unless you have a reason." The reasons are real when they apply — a privacy stance that rules out cloud calls (→ go local), a measured multilingual recall problem (→ Gemini) — but they're rare, and every switch costs a corpus re-embed.
