# Embedding model choice

Operator-facing guide for picking + switching the embedding model your Mantle install uses. For the runtime-side detail (how dispatch resolves, how the cache works, how the rebuild button is wired), see [`ai-workers.md` §5e](./ai-workers.md#5e-embedding--the-cross-cutting-kind).

For the wider memory architecture, [`memory.md`](./memory.md) is the spine; embeddings are the indexing layer that makes "find me that thing about X" actually work.

> **2026-05-31 — the brain now runs on a LOCAL 768-dim model.** Mantle migrated
> off cloud `openai/text-embedding-3-small` (1536-dim) to **EmbeddingGemma-300m
> (768-dim)** served by Ollama on the host. Every vector column is now
> `vector(768)` and the indexes are HNSW. The "Mantle-specific constraint" is
> therefore **768 dims, not 1536** — and the implications invert: the local
> Gemma model is the one that fits, and the old cloud 1536 models are the ones
> that now need a schema migration to use. The migration history lives in
> [`handoff-local-embeddings-2026-05-30.md`](./handoff-local-embeddings-2026-05-30.md).

---

## TL;DR

| If you want… | Pick this |
|---|---|
| The default — private, free, no cloud calls (the shipped case) | **`embeddinggemma:latest`** via the `local` provider (Ollama, 768-dim) |
| Maximum English recall and you don't mind cloud + a re-embed | `openai/text-embedding-3-large` truncated to 768 (MRL) |
| Heavily multilingual (German + English emails, French notes, mixed CJK) | `google/gemini-embedding-001` truncated to 768 (MRL) |

**Don't switch unless you have a reason.** The local default works, costs nothing, and never leaves the box — which is the whole point of a self-hosted brain. Re-embedding the corpus to switch isn't free in *time* (semantic search is degraded while the space is mixed), and switching to a model with a different native dim now requires **another** schema migration. Read the rest of this doc before flipping.

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
| `embeddinggemma:latest` (local/Ollama) | 768 | ✅ native | **$0 (local)** | ~62% | ~55% | **Default (shipped)** |
| `openai/text-embedding-3-small` | 1536 | ❌ no clean MRL to 768 | $0.020 | 62.3% | 44.0% | Retired default; needs migration to use again |
| `openai/text-embedding-3-large` | 3072 | ✅ MRL → 768 | $0.130 | 64.6% | 54.9% | Wired (cloud) |
| `google/gemini-embedding-001` | 3072 | ✅ MRL → 768 | $0.15 | ~68% | ~62% | Wired (cloud; top of MTEB) |
| `cohere/embed-multilingual-v3.0` | 1024 | ❌ no MRL | $0.10 | 60% | ~56% | Wired (needs migration) |
| `mistral/mistral-embed` | 1024 | ❌ no MRL | $0.10 | ~60% | ~50% | Wired (needs migration) |

**Definitions:**
- **Native dims** — how many numbers each vector contains by default. More = more resolution, more storage.
- **Fits 768?** — whether the model can write into Mantle's current `vector(768)` columns without a schema change. A model that natively emits 768 (EmbeddingGemma) fits exactly. A model that supports **MRL** (Matryoshka Representation Learning) truncation — OpenAI's `-3-large`, Google's `gemini-embedding-*` — can be asked for a 768-dim vector and still be useful. A model with a fixed non-768 native dim and no MRL (Cohere, Mistral, and `-3-small`, which only truncates cleanly to 512) does **not** fit without a migration.
- **MTEB** — Massive Text Embedding Benchmark. English retrieval, classification, clustering. The most widely-cited general score.
- **MIRACL** — Multilingual retrieval across 18 languages. Most predictive score for non-English corpora.

EmbeddingGemma punches well above its 308M-parameter / 768-dim weight class — competitive with much larger cloud models on MTEB while being free and local. For a single-user personal brain it's the right default by a wide margin.

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

1. **A model that natively emits 768 dims fits perfectly.** `embeddinggemma:latest` (the shipped default). No truncation, no schema change.

2. **A model that supports MRL truncation to 768 also fits.** `openai/text-embedding-3-large` (native 3072) and `google/gemini-embedding-001` (native 3072) both honour a request for 768 dims — Mantle's dispatcher sends `dimensions: 768` (the `EMBEDDING_DIMS` constant in [`packages/embeddings/src/index.ts`](../packages/embeddings/src/index.ts)). You get the model's better signal compressed into 768 dims, at the cost of cloud calls.

3. **A model that emits something else (1536, 1024, 3072-fixed) DOES NOT fit.** The old `openai/text-embedding-3-small` (1536), Mistral and Cohere (1024 native) would crash on first insert against the 768 column. The workers form's **Test Dimensions** button is meant to catch this BEFORE the save — switching to a model whose detected dim ≠ 768 should trigger a destructive-banner warning that blocks the save.

> **⚠ Known gap (2026-05-31):** the form's dim guard + the per-agent embedding
> dropdown were not flipped from 1536 to 768 during the migration. Until they
> are, the workers form will *block* a 768 model and *permit* the old 1536 ones
> (exactly backwards), and the agents dropdown still offers cloud 1536 models.
> The runtime is unaffected (the DB worker row is correct), but don't trust the
> UI dim guard to protect you yet. Tracked alongside this migration.

To switch back to a cloud 1536 model (or a 1024 Cohere/Mistral model), every `vector(N)` column needs an ALTER TABLE to the new dim + an index rebuild + a full re-embed — the same shape as migration `0060`. Doable, not a button.

---

## What you actually pay attention to

Three questions, in order of importance:

### 1. Do you actually need to leave local?

This is the biggest signal-to-effort ratio in the whole decision now that the default is local + free.

- **Privacy / cost / self-hosting matter to you** → stay on `embeddinggemma:latest`. Nothing leaves the box, every embed is free, and it's genuinely competitive on quality. This is why it's the default.
- **You have a measurable recall problem AND your corpus is heavily multilingual** → a cloud `gemini-embedding-001` (MRL → 768) is the strongest multilingual option. But weigh it against sending your whole corpus to a cloud provider, which is the thing the local move was meant to avoid.

### 2. How often does retrieval miss for you, today?

The honest test: when you ask Saskia about something specific from your past, does she find it? If she frequently says "I don't have a note about that" but you DO have one, the embedding model *might* be the bottleneck — but it's usually not the first thing to check (see "Why this matters more than it seems" below).

If retrieval feels solid: stay where you are. Embedding upgrades give diminishing returns once you're "good enough."

### 3. What's the upfront cost of switching?

Switching models means re-embedding your entire corpus and — if the new model's native dim differs — a schema migration first. The token cost itself is a rounding error (a ~15K-vector install is cents even on the priciest cloud model). What costs you is:
- **Operational time during the rebuild** — for the duration of a re-embed, semantic search is degraded (some vectors new-model, some old-model; cosine similarity across spaces is meaningless). Plan it for an off-hours window.
- **A schema migration** if the dim changes — write + apply an ALTER TABLE across all five vector columns, rebuild the four HNSW indexes, then re-embed. This is what `0060` did for the 1536→768 move.

---

## How to switch

In `/settings/ai-workers`:

1. **For a cloud model:** add an API key at `/settings/keys` for the target provider. (The `local` provider is keyless — Ollama needs no credential.)
2. **Edit the embedding worker** (provider + model). The shipped default is `provider=local`, `model=embeddinggemma:latest`, no API key.
3. **Pick the new model** from the dropdown. The form auto-fetches the provider's catalog.
4. **Click Test Dimensions** to confirm the model emits 768 (or can be MRL-truncated to it). The form blocks the save if dims don't fit. *(See the known-gap note above — the guard currently checks against 1536, not 768.)*
5. **If the native dim differs from 768**, write + apply a schema migration across every `vector()` column first. There is no button for this.
6. **Save** the worker, then **Rebuild Index** — the helper at [`packages/embeddings/src/reembed.ts`](../packages/embeddings/src/reembed.ts) walks `nodes`, `entities`, `facts`, `content_chunks`; re-embeds every row against the new model; idempotent under the `embedding_cache` so re-running against the same model is free.

The CLI alternative is the same code path:
```
pnpm -C apps/web re-embed --model=<model-id>
```
For a **dimension-migration repopulation** (every embedding nulled by an ALTER), add `--repopulate` so it embeds rows whose vector is currently null rather than only refreshing populated ones:
```
pnpm -C apps/web re-embed --repopulate --model=embeddinggemma:latest
```
`--model` is required when repopulating — without it the CLI defaults to the resolver's fallback (still a cloud model) and asks the local server for one it doesn't have.

During rebuild, the UI shows progress per layer. Until it completes, retrieval quality on older items is inconsistent — vectors written under the old model won't cosine-match against queries embedded under the new one.

---

## The local provider (EmbeddingGemma via Ollama)

The shipped default. Worth knowing how it's wired:

- **Server:** Ollama on the host, OpenAI-compatible endpoint at `http://localhost:11434/v1`. Base URL is overridable via the `MANTLE_LOCAL_EMBEDDING_URL` env (defaults to that, so no env needed in dev). Keep `ollama serve` running.
- **Model:** `embeddinggemma:latest` — 768-dim, Gemma license (commercial-OK).
- **Keyless:** the `local` provider needs no API key; the embed path treats it as keyless (an earlier version threw "no api key for provider 'local'").
- **Free:** no per-token cost. The cost dashboard shows $0 for embedding traffic, correctly.
- **Adapter:** `local-embedding` (OpenAI-compatible shape). Lives in `packages/voice/src/adapters/`.

**Why EmbeddingGemma and not jina-embeddings-v5?** jina-v5 was evaluated and rejected for the LM Studio path — it loads as `type=llm` there (Qwen3 base) and LM Studio silently falls back to another embedder. EmbeddingGemma loads as a real embedder (768-dim, proper pooling). If jina-v5 is ever wanted, serve it via llama.cpp `--pooling last` / TEI / vLLM, not LM Studio.

---

## Per-provider quirks worth knowing

### Local (Ollama / LM Studio)
- Keyless, free, private. The default.
- 768 native — fits the column exactly, no MRL games.
- Requires the local server to be up. If `ollama serve` is down, embedding calls fail (no cloud fallback — embeddings can't fail over across spaces; a 1536 cloud fallback would crash on the 768 column).

### OpenAI
- `text-embedding-3-large` honours the `dimensions` parameter for MRL truncation → can be coerced to 768. `text-embedding-3-small` only truncates cleanly to 512, so it does **not** fit 768 without a migration.
- The dispatcher sends `dimensions: 768` for MRL-capable models.

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

A short list of reasons to leave the local default alone:

1. **Privacy is the point.** Switching to a cloud model sends your entire corpus to a third party — the exact thing the local migration removed. That's a real cost, not a benchmark number.
2. **It's free.** Local embedding has no per-token cost. Cloud does.
3. **Retrieval already feels solid.** Don't fix what isn't broken — EmbeddingGemma is competitive, and the upgrade headroom on a personal English/German corpus is small.
4. **Your corpus is small (< 1000 vectors).** At this scale every model finds everything.
5. **You haven't tried tuning the retrieval params first.** `top_k`, the similarity threshold, the chunk size — these often matter more than the embedding model. The responder's `memory_config.{fact_limit, content_hit_limit, digest_limit}` knobs at `/settings/agents` are where to look first.

---

## Why this matters more than it seems

Embeddings are the cheap memory layer that makes the expensive layers (LLM context, your reading time) usable. A 5% better embedding model means:
- 5% more "Saskia remembered that thing" moments
- 5% fewer "I don't have a note about that" misses
- 5% less context-window pressure on the LLM (it gets the RIGHT 3 notes instead of 5 mediocre ones)

Compounded across hundreds of queries, this is the difference between a memory system that feels uncannily good and one that feels mid. **But it's not the bottleneck most installs hit first.** Most retrieval misses come from indexing (the wrong things got embedded, or weren't chunked well) or from query phrasing. The embedding model upgrade is the third-most-important lever, not the first.

That's why the recommendation here is "stay on the local default unless you have a reason." The reasons are real when they apply — a measured multilingual recall problem, ambitious memory work — but they're rare, and now they come with a privacy and cost trade-off that the local default was specifically chosen to avoid.
