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

## After step (c): responder auto-context (2026-06-03)

Three changes to `loadConversationContext` ([conversation.ts](../packages/agent-runtime/src/conversation.ts)), all in the one chokepoint both surfaces share:

1. **Window widened 3 → 5.** A 3-hit window dropped genuinely relevant near-misses below the prompt. The eval's `prod` (what the responder actually sees) went **R@5 92%→100%, MRR 0.88→0.90** (now at the vector ceiling); the gold node reaches the prompt in **12/12** cases (was 11/12). Probed cause: for "when does my licence disc renew", the user's vehicle page ranked #4 — outside the old cap — beside the actual licence PDF (#3) and a related note (#1), all now included. The settings-form default and existing agent rows persisted `3` explicitly, so the code default never reached them; [`scripts/widen-content-hits.ts`](../apps/web/scripts/widen-content-hits.ts) (`pnpm -C apps/web widen:content-hits --apply`, dry-run by default) bumps existing rows — **run once per env (dev + prod)**.

2. **System-docs hygiene.** Content hits now exclude `origin='system'` nodes (Mantle's own ~57 docs) — a reference corpus, not personal memory. Verified: the "memory/brain architecture" query that used to surface memory.md now returns the user's own doc with 0 system-origin leaks. (Doesn't move the node-recall gold set; the gold cases are personal.)

3. **Preferences always-injected.** The kind taxonomy's promise, finally wired: up to 8 most-recent `preference` facts ride in every turn's prefix, deduped against the vector hits (verified 9 surfacing on a neutral query). Tunable via `PREFERENCE_INJECT_LIMIT`. Improves relationship feel, not node-recall — so it's invisible to this eval but real.

Deliberately **not** built: an LLM/cross-encoder reranker. The data says no — `prod` is now at the 0.90 vector ceiling, so a per-turn rerank would add latency + cost for ~nothing. Revisit only if a noisier gold set shows headroom.

## After step (d): bulk-email salience down-weight (2026-06-03)

Marketing/newsletters were embedded at full weight and crowded out real content (a "3d printer" query returned PiShop/Prusa newsletters). The fix wires a **node-level `salience`** (0..1) into ranking: effective distance = `cosine + λ·(1 − salience)`, `λ=0.15` (env `MANTLE_SALIENCE_LAMBDA`), applied in all three retrieval sites (content hits, `searchNodes`, `searchChunks`). A down-weight, never a filter — the email stays fully findable by explicit `search`.

Salience source, in order of trust:
1. **Header classifier** (`emails.delivery_kind`, already built — precise): `salienceForDeliveryKind` maps `marketing→0.25, list→0.5, automated→0.75, direct/unknown→1.0`. Set at ingest ([sync.ts](../packages/email/src/sync.ts)) + migration `0073` backfill. Covers new mail + 156 legacy.
2. **Body fallback** ([`backfill-email-salience.ts`](../apps/web/scripts/backfill-email-salience.ts)) for the ~1,227 legacy `unknown` emails (synced before the classifier; raw headers aren't stored, so they can't be re-classified offline). Scores the stored body for unambiguous bulk tells (tracking-link density + unsubscribe) with a **transactional veto** (invoice/order/receipt/OTP → never demote). Tagged 568.

Measured effect (`MANTLE_SALIENCE_LAMBDA=0` vs `0.15`, 13 cases incl. a noisy printer case):

```
            prod R@3   prod MRR
λ=0 (off)      92%       0.90
λ=0.15 (on)   100%       0.91     ← no regression; +1 case (demoting a cross-domain
                                    firearm-licence email promoted the real vehicle page)
```

**Coverage limit (body fallback):** the body heuristic can't tell a sale email ("free delivery", "order now") from a receipt, so the invoice-protecting veto also spares some marketing — they stay salience 1.0. That's the precision/recall ceiling of body heuristics, and the reason the next step exists.

## After step (e): precise header re-classification (2026-06-03)

[`classify:backfill`](../apps/web/scripts/classify-backfill.ts) closes the coverage gap properly: it re-fetches the classification headers for legacy `unknown` emails over IMAP (`reclassifyByRefs` in [@mantle/email](../packages/email/src/providers/imap.ts) — BODY.PEEK, one round trip per folder, never marks read), runs the **same** `classifyDelivery`, writes the true `delivery_kind`, and re-derives `nodes.salience` (clearing the fuzzy `body_bulk_heuristic` marker). Read-only against the mailbox; dry-run by default; idempotent (only touches `unknown` rows).

Real run reclassified **1,162 / 1,227** legacy emails (65 moved/deleted/stale-uidvalidity): **667 marketing, 279 direct, 210 automated, 6 list**. The header classifier does what the body heuristic can't — it separates the 279 *direct* (real personal mail, restored to salience 1.0) from the 667 *marketing* (correctly demoted to 0.25), and fixes both directions of the body heuristic's mistakes.

Result on the noisy printer case:

```
                 prod pollution   search pollution   rrf MRR
body heuristic       1/1               1/1            0.79
header reclassify    0/1               0/1            0.86
```

The newsletters (Earth Day Sale, Prusameters, PiShop) leave the prompt entirely; the window fills with real supplier files, quotes, and the directory page. Going forward every newly-synced email is classified at ingest, so `unknown` only shrinks. `classify:backfill` is the canonical tool; `backfill:email-salience` remains the offline fallback for mail IMAP can't reach.

## After step (f): auto-chunk retrieval (2026-06-04)

The responder's context used only the coarse per-node summary; the section-level
`content_chunks` index (~1.5k-char passages, own embeddings) was reachable only
via the explicit `search_chunks` tool. Now `loadConversationContext` also pulls
the top passages (`chunk_limit`, default 3; cutoff 0.65; salience-aware,
system-docs + telegram excluded) and `buildChatMessages` renders them as a
"Relevant passages" block. Both surfaces inherit it.

**Why the node-recall eval is flat here (0.91, no Δ) and that's correct.** These
gold cases already find their node via content hits, so chunks don't change node
*discovery* — they change what the model can *say*. The value is putting the
actual answer text in the prompt. Demonstrated: for "what does the company pay
for rent and vehicle finance each month", the content hit gives only the summary
("This document details the monthly recurring expenses…"); the chunk hits deliver
the line items — `Ashley Schoeman Salary R 59,960.00…` and the financial
statement's `STATEMENT OF FINANCIAL POSITION` figures. Without chunks the model
knows the doc exists; with them it can answer from it.

This is the same lesson as preferences (step c): node-recall is necessary but
not sufficient — some wins (passage text, preference injection, relationship
feel) are real and invisible to it. Verify those with a direct context probe, not
the recall number. Cost: ~3 passages (~4.5k chars) added per turn — tune via
`memory_config.chunk_limit`.
