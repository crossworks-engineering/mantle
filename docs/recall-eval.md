# Recall eval — measuring whether the brain finds the right thing

The brain's killer feature is recall ("Saskia surfaces the right note when you
mention it vaguely"). This harness turns that from a vibe into a number. It runs
a gold-set of `(query → expected node)` pairs through the **real** retrieval code
and scores `recall@k` + `MRR`. Run it before and after any retrieval change; the
`--baseline` flag is the regression gate.

Companion to [`memory.md`](./memory.md) (the layers) and the audit findings that
motivated it. Lives at [`apps/web/scripts/eval-recall.ts`](../apps/web/scripts/eval-recall.ts);
gold cases at [`apps/web/scripts/eval/recall-cases.json`](../apps/web/scripts/eval/recall-cases.json).

## Run it

```bash
ALLOWED_USER_ID=<uuid> pnpm -C apps/web eval:recall
pnpm -C apps/web eval:recall --case=sermon-potter-clay      # one case
pnpm -C apps/web eval:recall --rank-k=30                    # deeper candidate set
pnpm -C apps/web eval:recall --baseline=scripts/eval/last-run.json   # Δ vs a prior run
pnpm -C apps/web eval:recall --json                        # machine-readable
```

Read-only — it never writes to the brain, safe against prod. Needs the embedder
up (local Ollama by default) and the dev/prod DB reachable via `DATABASE_URL`.

## What it measures — five retrievers, side by side

Each case is scored against five rankers so you see both the current reality and
the headroom in one run:

| Retriever | What it is | Why it's here |
|---|---|---|
| `prod` | `loadConversationContext()` exactly as the responder runs it (content hits capped at `content_hit_limit`, 0.6 cosine cutoff) | The truest "what actually reaches the prompt" number |
| `vector` | the same per-node vector ranker, top-`RANK_K`, **no** cutoff | Shows where the gold node ranks even when prod's cap drops it |
| `fts` | `searchNodes()` — Postgres full-text | What the MCP/builtin **`search`** tool uses |
| `chunks` | `searchChunks()` — passage-level vector | What **`search_chunks`** uses |
| `rrf` | Reciprocal-Rank Fusion of vector+fts+chunks | A naive-hybrid baseline for the recommended Tier-0 upgrade |

**Metrics:** `recall@{1,3,5,10}` (fraction of cases whose gold node appears in
top-k) and `MRR` (mean reciprocal rank of the first gold hit). A node counts as
gold if its id is in `expectNodeIds` **or** its title contains an
`expectNodeTitleIncludes` substring (id = precise, title = authorable/resilient).

## Adding cases

Append to `recall-cases.json`. Write the query the way *you'd actually ask it* —
vague, paraphrased, avoiding the node's title words — that's the recall the
product promises. Anchor with a stable node id and a title substring:

```json
{
  "id": "short-slug",
  "query": "the natural, vague way you'd refer to it",
  "expectNodeIds": ["<uuid>"],
  "expectNodeTitleIncludes": ["distinctive title fragment"],
  "expectFactIncludes": ["optional fact substring the prompt should carry"],
  "note": "what this node is + what the query is testing"
}
```

Grow this set whenever you hit a real "she should have found that" miss — those
are the highest-signal cases.

## First baseline (2026-06-03, 12 cases, pages + events)

```
  retriever     R@1   R@3   R@5  R@10   MRR
  prod          83%   92%   92%   92%   0.88
  vector        83%   92%  100%  100%   0.90
  fts            8%    8%    8%    8%   0.08
  chunks        17%   75%   75%   92%   0.44
  rrf           58%   92%  100%  100%   0.76
```

This **sharpened** the audit's "retrieval is weak" claim into something more
precise and more actionable:

1. **Per-node vector recall is genuinely good on clean, well-summarised content**
   (pages, events): `vector` R@5 = 100%, MRR = 0.90. The audit's earlier "marketing
   pollution" misses were on *noisy* content (bulk email); they don't generalise to
   curated nodes. Honest correction.
2. **The FTS-only `search` tool is the real villain: R@1 = 8%.** It found the gold
   node in only 1/12 cases — the one where the query happened to share words with the
   title. Since `search` is the **primary tool exposed to Claude over MCP**, the
   upstream brain is getting ~8% recall on natural-language queries. Giving the
   `search` tool a vector/hybrid path is now the highest-impact, best-evidenced fix.
3. **Naive equal-weight RRF *regresses* vs pure vector** (MRR 0.76 < 0.90) — the dead
   FTS arm and noisy chunk arm drag the fusion down. So Tier-0 #1 is **not** "fuse
   everything equally." The measured design is: **vector as the spine + FTS as a
   rare-term recall booster (down-weighted) + a reranker over the union.** The eval
   is what will tell us if that beats 0.90.
4. **The `content_hit_limit=3` cap silently drops near-misses.** `car-licence` ranked
   #4 under vector, so prod never saw it (the only prod miss). A reranker or a slightly
   larger cap recovers it.

Re-run with `--baseline` after each retrieval change and require the number to go up.

## After step (b): the `search` tool is fixed (2026-06-03)

`searchNodes` gained a hybrid path (vector-led + FTS booster, [`packages/search/src/index.ts`](../packages/search/src/index.ts)); the `search` / `search_nodes` tools now embed the query and use it. The eval column `fts` (legacy, FTS-only) and `search` (the shipped hybrid) sit side by side so the lift is self-documenting:

```
  retriever     R@1   R@3   R@5  R@10   MRR
  fts            8%    8%    8%    8%   0.08   ← old tool (FTS hard-filter)
  search        75%   92%  100%  100%   0.84   ← new tool (hybrid)
  vector        83%   92%  100%  100%   0.90   ← ranker ceiling
```

The `search` tool found the gold node in **11/12** cases (was 1/12). It trails pure
`vector` by 0.06 MRR — the 0.3 FTS weight occasionally nudges a keyword hit up. That
weight is deliberate: it rescues exact-term queries (a ticket number, an invoice id,
an exact name) that vector misses and which this semantic gold set doesn't cover.
Tune via `SearchOptions.semanticWeight` (default 0.7) if a future exact-term case set
says otherwise — and re-run this eval to confirm.

Still open (step c): the responder's auto-context (`prod`) is unchanged — it's already
at MRR 0.88, and the remaining miss (`car-licence`, ranked #4 under vector) needs a
reranker or a larger `content_hit_limit`, not hybrid.
