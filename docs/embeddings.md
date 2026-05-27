# Embedding model choice

Operator-facing guide for picking + switching the embedding model your Mantle install uses. For the runtime-side detail (how dispatch resolves, how the cache works, how the rebuild button is wired), see [`ai-workers.md` §5e](./ai-workers.md#5e-embedding--the-cross-cutting-kind).

For the wider memory architecture, [`memory.md`](./memory.md) is the spine; embeddings are the indexing layer that makes "find me that thing about X" actually work.

---

## TL;DR

| If your corpus is… | Pick this |
|---|---|
| Mostly English personal/work content (the default case) | `openai/text-embedding-3-small` — what ships today |
| Heavily multilingual (German + English emails, French notes, mixed Chinese/Japanese) | `google/gemini-embedding-001` or `openai/text-embedding-3-large` |
| Cost-extreme (Mistral fan, lots of embedding traffic) | `mistral/mistral-embed` (but loses the 1536-dim fit — see below) |
| You're already running Cohere for other workloads | `cohere/embed-multilingual-v3.0` — strong on non-English |

**Don't switch unless you have a reason.** The default works. Re-embedding the corpus to switch isn't free (you pay for every existing vector to be recomputed against the new model). Read the rest of this doc before flipping.

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

| Model | Native dims | MRL trunc to | Price ($/1M tokens) | MTEB (Eng) | MIRACL (multi) | Mantle status |
|---|---|---|---|---|---|---|
| `openai/text-embedding-3-small` | 1536 | 512 | $0.020 | 62.3% | 44.0% | **Default** |
| `openai/text-embedding-3-large` | 3072 | 256 | $0.130 | 64.6% | 54.9% | Wired |
| `openai/text-embedding-ada-002` | 1536 | (no MRL) | $0.100 | 61.0% | 31.4% | Wired (deprecated; skip) |
| `google/gemini-embedding-001` | 3072 | 768 | $0.15 | ~68% | ~62% | Wired (top of MTEB at time of writing) |
| `google/gemini-embedding-2-preview` | 3072 (multimodal) | 768 | preview | TBD | TBD | Wired — only multimodal embedding option |
| `cohere/embed-english-v3.0` | 1024 | (no MRL) | $0.10 | 64.5% | ~32% | Wired |
| `cohere/embed-multilingual-v3.0` | 1024 | (no MRL) | $0.10 | 60% | ~56% | Wired (strong multilingual) |
| `mistral/mistral-embed` | 1024 | (no MRL) | $0.10 | ~60% | ~50% | Wired |

**Definitions:**
- **Native dims** — how many numbers each vector contains by default. More = more resolution, more storage.
- **MRL trunc** — Matryoshka Representation Learning. Some models let you ask for a SHORTER vector that's still useful. `text-embedding-3-large` natively makes 3072-dim vectors but you can request 1536 (or 512, or 256) by passing `dimensions: N`. The quality degrades gracefully — a truncated -large is still better than -small at the same dims.
- **MTEB** — Massive Text Embedding Benchmark. English retrieval, classification, clustering. The most widely-cited general score.
- **MIRACL** — Multilingual retrieval across 18 languages. Most predictive score for non-English corpora.

---

## The Mantle-specific constraint: 1536 dims

Mantle's vector columns are all `vector(1536)`. Every embedding writes to:
- `nodes.embedding` (the per-document spine)
- `entities.embedding` (per-person/place/thing)
- `facts.embedding` (per atomic fact)
- `content_chunks.embedding` (the ~1500-char passages for long-doc retrieval)
- `tool_result_chunks.embedding` (spilled tool-result store)

**What this means in practice:**

1. **A model that natively emits 1536 dims fits perfectly.** `openai/text-embedding-3-small`, `openai/text-embedding-ada-002`. No truncation, no schema change.

2. **A model that supports MRL truncation to 1536 also fits.** `openai/text-embedding-3-large` (native 3072) and `google/gemini-embedding-001` (native 3072) both honour `dimensions: 1536` in the request — Mantle's dispatcher already sends that flag. You get the model's better signal compressed into 1536 dims. Quality is still better than `-small` at the same dim count.

3. **A model that emits something else (1024, 768, 384) DOES NOT fit.** Mistral and Cohere's models emit 1024 dims natively. Switching to them today would crash on first insert. The workers form's **Test Dimensions** button catches this BEFORE the save — switching to a non-1536 model triggers a destructive-banner warning that the save is blocked.

The form's `Test Dimensions` button + the `KNOWN_DIMS` allow-list in [`worker-form.tsx`](apps/web/app/(app)/settings/ai-workers/worker-form.tsx) make this honest: you can't accidentally configure a non-fitting model.

To use Mistral / Cohere properly, every `vector(1536)` column would need an ALTER TABLE to `vector(1024)` — a 5-migration job that's not currently shipped. Doable, not a button.

---

## What you actually pay attention to

Three questions, in order of importance:

### 1. Is your corpus mostly English, or genuinely multilingual?

This is the biggest signal-to-effort ratio in the whole decision.

- **Mostly English** → `-small` gives 62.3% MTEB. The +2pp from `-large` ($0.020 → $0.130, **6.5× cost**) is real but rarely noticeable.
- **20%+ non-English** → seriously consider `gemini-embedding-001` or `embed-multilingual-v3.0`. The MIRACL gap matters: ~44% (`-small`) vs ~62% (gemini) is the difference between "finds the right note 4 times out of 9" and "finds it 6 times out of 9" on cross-language queries. You'll notice.

If you're not sure: do you write notes in any language other than English? Do you ingest emails from German/French/Spanish/Asian-language senders? If yes to either, the multilingual upgrade pays back.

### 2. How often does retrieval miss for you, today?

The honest test: when you ask Saskia about something specific from your past, does she find it? If she frequently says "I don't have a note about that" but you DO have one, your embedding model is the bottleneck.

If retrieval feels solid: stay where you are. Embedding upgrades give diminishing returns once you're "good enough."

If retrieval misses noticeably: try a `-large` or `gemini-embedding-001` swap. The Rebuild Index button re-embeds your existing corpus against the new model so old notes become searchable too (not just newly-ingested ones).

### 3. What's the upfront cost of switching?

Switching models means re-embedding your entire corpus. The math, for a 10K-vector install averaging 500 tokens per vector:

- 10K × 500 = **5M tokens to re-embed**
- `-small`: $0.10 (negligible)
- `-large`: $0.65 (negligible)
- `gemini-embedding-001`: $0.75 (negligible)

For a 100K-vector install: ~$1 / $6.50 / $7.50 respectively. Still rounding errors.

**Cost isn't really the decider.** What costs you is the *operational time* during the rebuild — for ~hours during a re-embed, semantic search is degraded (some vectors are new-model, some are old-model; cosine similarity across spaces is meaningless). Plan it for an off-hours window.

---

## How to switch

In `/settings/ai-workers`:

1. **Add an API key** at `/settings/keys` if you don't have one for the target provider.
2. **Edit the embedding worker** (or create one if you don't have one — without an explicit worker the resolver falls through to the env default).
3. **Pick the new model** from the dropdown. The form auto-fetches the provider's catalog.
4. **Click Test Dimensions** to confirm the model emits 1536 (or compatible). The form blocks the save if dims don't fit.
5. **Save** the worker.
6. **Click Rebuild Index** — the button is gated until after save. The helper at [`packages/embeddings/src/reembed.ts`](../packages/embeddings/src/reembed.ts) walks `nodes`, `entities`, `facts`; re-embeds every row against the new model; idempotent under the `embedding_cache` so re-running against the same model is free.

During rebuild, the UI shows progress per layer. Until it completes, retrieval quality on older items will be inconsistent — vectors written under the old model won't cosine-match against queries embedded under the new one.

The CLI alternative `pnpm re-embed` is the same code path — useful if you're scripting or want to run it from a server shell.

---

## Per-provider quirks worth knowing

### OpenAI

- `text-embedding-3-*` family honours the `dimensions` parameter for MRL truncation. The dispatcher always sends `dimensions: 1536`.
- `text-embedding-ada-002` is the legacy model — same price as `-3-large` but worse on every benchmark. Don't pick it for new installs.
- Rate limit: 5000 RPM on Tier 1. Re-embed of a typical Mantle corpus is far below this.

### Google (Gemini)

- `gemini-embedding-001` currently tops the MTEB leaderboard. The catch: it's newer, less battle-tested in production embedding pipelines than OpenAI's.
- Honours `outputDimensionality` for MRL — Mantle's dispatcher sends 1536.
- `gemini-embedding-2-preview` is the only multimodal embedding option in the catalogue. If you want to embed images alongside text (e.g. for "find me images that match this concept"), this is the path. Quality on text-only inputs is similar to `001`.
- Rate limits per project vary by tier; check the Google Cloud console.

### Cohere

- Two flavours: `embed-english-v3.0` (1024-dim, English-only) and `embed-multilingual-v3.0` (1024-dim, 100+ languages).
- **1024 dims doesn't fit Mantle's schema** — using either requires the schema migration noted above.
- Asymmetric model: Cohere expects you to tell it whether each input is a "document" (for the corpus) or a "query" (for retrieval) via the `input_type` parameter. The adapter defaults all calls to `'search_document'` since the dominant use case is corpus indexing. Query-side calls (responder retrieval) get the same setting, which costs some recall but stays functional. Documented at [`packages/voice/src/adapters/cohere-embedding.ts`](../packages/voice/src/adapters/cohere-embedding.ts).

### Mistral

- One model: `mistral-embed` (1024-dim). Same 1536-dim mismatch as Cohere.
- OpenAI-compatible endpoint shape, so the adapter is thin.

### OpenRouter

- Aggregator — proxies all of the above through one key + endpoint. Includes some open-weight embedding models (sentence-transformers, BGE, GTE, E5) that the direct providers don't expose.
- **The only adapter that accepts multimodal inputs** (gemini-embedding-2-preview, nemotron-embed-vl) via the unified endpoint. If you want multimodal embedding and aren't ready to add a Google key, OR is the path.
- Heuristic gotcha (see [`ai-workers.md` §5e.3](./ai-workers.md#5e3-discovery--per-provider)): OR splits chat + embeddings across two `/v1/models` endpoints; 13 of 25 embedding models lack `embed` in their slug, so id-pattern filtering misses them. The `/models` page handles this correctly by hitting both endpoints.

---

## When NOT to switch

A short list of reasons to leave the default alone:

1. **Retrieval already feels solid.** Don't fix what isn't broken — the upgrade headroom on English corpora is real but small.
2. **You don't have multilingual content.** The biggest reason to upgrade evaporates.
3. **Your corpus is small (< 1000 vectors).** At this scale every model finds everything; pick whatever's cheapest.
4. **You haven't tried tuning the retrieval params first.** The number of `top_k` results, the similarity threshold, the chunk size — these often matter more than the embedding model. The responder agent's `memory_config.{fact_limit, content_hit_limit, digest_limit}` knobs at `/settings/agents` are where to look first.

---

## Why this matters more than it seems

Embeddings are the cheap memory layer that makes the expensive layers (LLM context, your reading time) usable. A 5% better embedding model means:
- 5% more "Saskia remembered that thing" moments
- 5% fewer "I don't have a note about that" misses
- 5% less context-window pressure on the LLM (it gets the RIGHT 3 notes instead of 5 mediocre ones)

Compounded across hundreds of queries, this is the difference between a memory system that feels uncannily good and one that feels mid. **But it's not the bottleneck most installs hit first.** Most retrieval misses come from indexing (the wrong things got embedded, or weren't chunked well) or from query phrasing (the user asked in a way that doesn't surface what they wanted). The embedding model upgrade is the third-most-important lever, not the first.

That's why the recommendation here is "stay on `-small` unless you have a reason." The reasons are real when they apply — multilingual, recall-quality complaints, ambitious memory work — but they're not the universal case.
