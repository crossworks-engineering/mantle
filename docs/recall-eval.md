# Recall eval: measuring whether the brain finds the right thing

The brain's killer feature is recall ("Saskia surfaces the right note when you
mention it vaguely"). This harness turns that from a vibe into a number. It runs
a gold-set of `(query → expected node)` pairs through the **real** retrieval code
and scores `recall@k` + `MRR`. Run it before and after any retrieval change; the
`--baseline` flag is the regression gate.

Companion to [`memory.md`](./memory.md) (the layers) and the audit findings that
motivated it. Lives at [`server/web/scripts/eval-recall.ts`](../server/web/scripts/eval-recall.ts).

> **The gold set is yours, and it is local-only.** A case pins node ids from ONE
> brain, so a shared set names its author's real pages and resolves to nothing on
> anyone else's. the eval case file next to `server/web/scripts/eval-recall.ts` is **gitignored and
> not shipped** — write your own before the first run (see _Adding a case_). The
> repo carried one until 2026-08-21; it leaked the owner's bank, a company
> expense figure and their full name into a public repo, which is exactly the
> failure this note exists to prevent.

## Run it

```bash
ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall
pnpm -C server/web eval:recall --case=<your-case-id>      # one case
pnpm -C server/web eval:recall --rank-k=30                    # deeper candidate set
pnpm -C server/web eval:recall --baseline=scripts/eval/last-run.json   # Δ vs a prior run
pnpm -C server/web eval:recall --json                        # machine-readable
```

Read-only; it never writes to the brain, safe against prod. Needs the embedder
up (local Ollama by default) and the dev/prod DB reachable via `DATABASE_URL`.

## What it measures: five retrievers, side by side

Each case is scored against five rankers so you see both the current reality and
the headroom in one run:

| Retriever | What it is                                                                                                                   | Why it's here                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `prod`    | `loadConversationContext()` exactly as the responder runs it (content hits capped at `content_hit_limit`, 0.6 cosine cutoff) | The truest "what actually reaches the prompt" number          |
| `vector`  | the same per-node vector ranker, top-`RANK_K`, **no** cutoff                                                                 | Shows where the gold node ranks even when prod's cap drops it |
| `fts`     | `searchNodes()`, Postgres full-text                                                                                          | What the MCP/builtin **`search`** tool uses                   |
| `chunks`  | `searchChunks()`, passage-level vector                                                                                       | What **`search_chunks`** uses                                 |
| `rrf`     | Reciprocal-Rank Fusion of vector+fts+chunks                                                                                  | A naive-hybrid baseline for the recommended Tier-0 upgrade    |

**Metrics:** `recall@{1,3,5,10}` (fraction of cases whose gold node appears in
top-k) and `MRR` (mean reciprocal rank of the first gold hit). A node counts as
gold if its id is in `expectNodeIds` **or** its title contains an
`expectNodeTitleIncludes` substring (id = precise, title = authorable/resilient).

## Adding cases

Append to `recall-cases.json`. Write the query the way _you'd actually ask it_,
vague, paraphrased, avoiding the node's title words, that's the recall the
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

Grow this set whenever you hit a real "she should have found that" miss; those
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
   pollution" misses were on _noisy_ content (bulk email); they don't generalise to
   curated nodes. Honest correction.
2. **The FTS-only `search` tool is the real villain: R@1 = 8%.** It found the gold
   node in only 1/12 cases, the one where the query happened to share words with the
   title. Since `search` is the **primary tool exposed to Claude over MCP**, the
   upstream brain is getting ~8% recall on natural-language queries. Giving the
   `search` tool a vector/hybrid path is now the highest-impact, best-evidenced fix.
3. **Naive equal-weight RRF _regresses_ vs pure vector** (MRR 0.76 < 0.90), the dead
   FTS arm and noisy chunk arm drag the fusion down. So Tier-0 #1 is **not** "fuse
   everything equally." The measured design is: **vector as the spine + FTS as a
   rare-term recall booster (down-weighted) + a reranker over the union.** The eval
   is what will tell us if that beats 0.90.
4. **The `content_hit_limit=3` cap silently drops near-misses.** One case ranked
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
`vector` by 0.06 MRR, the 0.3 FTS weight occasionally nudges a keyword hit up. That
weight is deliberate: it rescues exact-term queries (a ticket number, an invoice id,
an exact name) that vector misses and which this semantic gold set doesn't cover.
Tune via `SearchOptions.semanticWeight` (default 0.7) if a future exact-term case set
says otherwise, and re-run this eval to confirm.

## After step (c): responder auto-context (2026-06-03)

Three changes to `loadConversationContext` ([conversation.ts](../packages/runtime/src/agent/conversation.ts)), all in the one chokepoint both surfaces share:

1. **Window widened 3 → 5.** A 3-hit window dropped genuinely relevant near-misses below the prompt. The eval's `prod` (what the responder actually sees) went **R@5 92%→100%, MRR 0.88→0.90** (now at the vector ceiling); the gold node reaches the prompt in **12/12** cases (was 11/12). Probed cause: for "when does my licence disc renew", the user's vehicle page ranked #4 (outside the old cap) beside the actual licence PDF (#3) and a related note (#1), all now included. The settings-form default and existing agent rows persisted `3` explicitly, so the code default never reached them; [`server/web/scripts/widen-content-hits.ts`](../server/web/scripts/widen-content-hits.ts) (`pnpm -C server/web widen:content-hits --apply`, dry-run by default) bumps existing rows, **run once per env (dev + prod)**.

2. **System-docs hygiene.** Content hits now exclude `origin='system'` nodes (Mantle's own ~57 docs), a reference corpus, not personal memory. Verified: the "memory/brain architecture" query that used to surface memory.md now returns the user's own doc with 0 system-origin leaks. (Doesn't move the node-recall gold set; the gold cases are personal.)

3. **Preferences always-injected.** The kind taxonomy's promise, finally wired: up to 8 most-recent `preference` facts ride in every turn's prefix, deduped against the vector hits (verified 9 surfacing on a neutral query). Tunable via `PREFERENCE_INJECT_LIMIT`. Improves relationship feel, not node-recall, so it's invisible to this eval but real.

Deliberately **not** built: an LLM/cross-encoder reranker. The data says no, `prod` is now at the 0.90 vector ceiling, so a per-turn rerank would add latency + cost for ~nothing. Revisit only if a noisier gold set shows headroom.

## After step (d): bulk-email salience down-weight (2026-06-03)

Marketing/newsletters were embedded at full weight and crowded out real content (a "3d printer" query returned PiShop/Prusa newsletters). The fix wires a **node-level `salience`** (0..1) into ranking: effective distance = `cosine + λ·(1 − salience)`, `λ=0.15` (env `MANTLE_SALIENCE_LAMBDA`), applied in all three retrieval sites (content hits, `searchNodes`, `searchChunks`). A down-weight, never a filter; the email stays fully findable by explicit `search`.

Salience source, in order of trust:

1. **Header classifier** (`emails.delivery_kind`, already built, precise): `salienceForDeliveryKind` maps `marketing→0.25, list→0.5, automated→0.75, direct/unknown→1.0`. Set at ingest ([sync.ts](../packages/email/src/sync.ts)) + migration `0073` backfill. Covers new mail + 156 legacy.
2. **Body fallback** ([`backfill-email-salience.ts`](../server/web/scripts/backfill-email-salience.ts)) for the ~1,227 legacy `unknown` emails (synced before the classifier; raw headers aren't stored, so they can't be re-classified offline). Scores the stored body for unambiguous bulk tells (tracking-link density + unsubscribe) with a **transactional veto** (invoice/order/receipt/OTP → never demote). Tagged 568.

Measured effect (`MANTLE_SALIENCE_LAMBDA=0` vs `0.15`, 13 cases incl. a noisy printer case):

```
            prod R@3   prod MRR
λ=0 (off)      92%       0.90
λ=0.15 (on)   100%       0.91     ← no regression; +1 case (demoting a cross-domain
                                    firearm-licence email promoted the real vehicle page)
```

**Coverage limit (body fallback):** the body heuristic can't tell a sale email ("free delivery", "order now") from a receipt, so the invoice-protecting veto also spares some marketing; they stay salience 1.0. That's the precision/recall ceiling of body heuristics, and the reason the next step exists.

## After step (e): precise header re-classification (2026-06-03)

[`classify:backfill`](../server/web/scripts/classify-backfill.ts) closes the coverage gap properly: it re-fetches the classification headers for legacy `unknown` emails over IMAP (`reclassifyByRefs` in [@mantle/email](../packages/email/src/providers/imap.ts), BODY.PEEK, one round trip per folder, never marks read), runs the **same** `classifyDelivery`, writes the true `delivery_kind`, and re-derives `nodes.salience` (clearing the fuzzy `body_bulk_heuristic` marker). Read-only against the mailbox; dry-run by default; idempotent (only touches `unknown` rows).

Real run reclassified **1,162 / 1,227** legacy emails (65 moved/deleted/stale-uidvalidity): **667 marketing, 279 direct, 210 automated, 6 list**. The header classifier does what the body heuristic can't; it separates the 279 _direct_ (real personal mail, restored to salience 1.0) from the 667 _marketing_ (correctly demoted to 0.25), and fixes both directions of the body heuristic's mistakes.

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
the top passages (`chunk_limit`, default 8 today; cutoff 0.65; salience-aware,
system-docs + telegram excluded) and `buildChatMessages` renders them as a
"Relevant passages" block. Both surfaces inherit it.

**Why the node-recall eval is flat here (0.91, no Δ) and that's correct.** These
gold cases already find their node via content hits, so chunks don't change node
_discovery_; they change what the model can _say_. The value is putting the
actual answer text in the prompt. Demonstrated: for "what does the company pay
for rent and vehicle finance each month", the content hit gives only the summary
("This document details the monthly recurring expenses…"); the chunk hits deliver
the line items, the salary rows and the financial
statement's `STATEMENT OF FINANCIAL POSITION` figures. Without chunks the model
knows the doc exists; with them it can answer from it.

This is the same lesson as preferences (step c): node-recall is necessary but
not sufficient; some wins (passage text, preference injection, relationship
feel) are real and invisible to it. Verify those with a direct context probe, not
the recall number. Cost: up to `chunk_limit` passages (~22k chars at today's default of 8) added per turn, tune via
`memory_config.chunk_limit`.

## After step (g): recency / time-decay (2026-06-04)

Retrieval ranked purely by similarity, a 2-year-old fact tied a fresh one. Now a
saturating age penalty rides on the ranking distance: `λ·(1 − e^(−age/τ))`
(τ=180d, env-tunable), 0 at age 0 → λ as age → ∞. It's a tiebreaker, not a
sledgehammer: among similarly-relevant items the recent one wins, but a
much-more-relevant old item still beats a marginal recent one.

**Kind-aware on facts**: the design's call (memory.md §2): episodic memories
("on the 4th Alex said…") are recency-driven (λ=0.15); **semantic/preference
don't decay at all** (stable identity, "Alex is a pastor" doesn't get staler);
factual sits between (0.05). Anchor: `coalesce(valid_from, created_at)`.

**Mild on content** (λ=0.06), and the date anchor is the content's _own_ date when
it has one (an email's `internalDate`, not `created_at`) so an old email synced
last month reads as old, not fresh. Recency only reorders content; the 0.6 cutoff
stays on the salience distance, so a relevant-but-old doc is never dropped for age.

Verified by direct probe (the eval doesn't rank facts): episodic facts take the
penalty (17d → +0.013, 1d → +0.001), semantic take **+0.0000**, factual mild.
Content eval: no regression (prod MRR 0.91, Δ 0). **Impact scales with corpus
age**, on today's young corpus (0–17 days) penalties are ≤0.013 by design;
they grow toward λ as memories age, which is exactly when recency matters. Tune
via `MANTLE_RECENCY_{EPISODIC,CONTENT,TAU_DAYS}`.

## After step (h): entity-anchored expansion (2026-06-04)

The knowledge graph (2,472 relation edges) was invisible to retrieval, reachable
only when the LLM explicitly called a graph tool. This wires the design's marquee
pattern (memory.md §4.3, "expand each result's entity neighbourhood"): vector
search finds the relevant facts, then `entityRelationsFor` pulls the 1-hop
relationships of THEIR entities into the prompt, structured knowledge no vector
query can produce.

Mechanism: the top matching facts' entities (rank order, distinct, cap 5) become
anchors; one batched query returns their relation triples (excluding
`mentioned_in`/retired, cap 12), rendered as a "Known relationships" block.
Verified by probe, for "who does Cross-Works work with and bank with", the
context gains `Cross-Works banks_with ABSA`, `Nedbank banks_with South African
Reserve Bank`, `ACM Technology supplier_of Cross-Works`, etc. Node-recall flat
(0.91, expected; relations aren't nodes); the win is relational knowledge,
verified by probe not the recall number.

**It also surfaced a real graph-quality issue** (pre-existing, not from this
change): the same company appears as both `Cross-Works Engineering` and
`CrossWorksEngineering`, entity fragmentation. The feature makes graph hygiene
_consequential_: running `entities:dedupe` / the `/settings/entities` review
(audit item #10) is now a retrieval-quality lever, not just tidiness.

## After step (i): the backlog sweep (2026-06-04)

Six smaller audit items, committed individually:

- **Chunk overlap** (`0ce4e90`): `chunkDocText` overlaps consecutive chunks ~150
  chars (word-boundary trimmed) so a fact straddling a boundary is embedded whole.
- **Persona-note dedup** (`0ce4e90`): `dedupeNewNotes` (token-Jaccard ≥ 0.6) stops
  the reflector re-learning the same trait worded differently each run.
- **Entity dedup** (`d08537c`): `orgCompactKey` (legal-suffix + alphanumeric-only)
  across org-like kinds collapses "CrossWorksEngineering" = "Cross-Works
  Engineering"; dropped 'sa' from legal suffixes (SA = South Africa here). 4 auto
  merges applied on dev. Run `entities:dedupe --go` per env.
- **Telegram embeddings** (`1283cf2`): embed-only branch in extractNode makes
  turns semantically searchable (no per-message summary). Backfill existing:
  `extract:backfill --types=telegram_message` after the agent restarts.
- **Event dates → valid_from** (`684b25c`): extractor parses `occurred_at` for
  episodic facts so recency decays by when the event HAPPENED, not when ingested.
- **Query enrichment** (`90277a9`): short anaphoric follow-ups ("tell me more
  about that") ground their retrieval embedding in recent turns (zero LLM cost).
  Full LLM HyDE intentionally left opt-in.

Verified: full content/db/agent/agent-runtime suites green; eval no regression
(0.91; none of these touch the clean-page gold cases; they target email/graph/
follow-up/long-doc paths the gold set doesn't exercise).

## After step (j): the keyword arm searches the rarest terms (2026-09-29)

The hybrid arms bound the raw query text to `plainto_tsquery`, which ANDs every
stem. The responder's auto-context sends the whole user message, so a passage
had to hold every word. On dev, 4 of the last 35 inbound turns got any keyword
hit; one realistic question matched 0 chunks, while its three key terms ORed
matched 925. The hybrid arm and the exact-term rescue floor almost never fired.

[`packages/search/src/keyword-query.ts`](../packages/search/src/keyword-query.ts)
now builds the keyword query from the rarest terms, after Hindsight's
`bm25_term_selection.py`:

- Frequency of common lexemes comes from `pg_stats.most_common_elems` on
  `search_tsv` (ANALYZE keeps it). Up to 32 untracked lexemes get a real count,
  capped at 500 rows each through the GIN index.
- Dropped: terms in more than 5% of rows, terms in no row, and a short list of
  chat filler (`hey`, `quick`, `got`, …) that is rare in documents but carries
  no content.
- Up to 8 terms are ORed. Rows rank by the summed rarity (`ln(1/df)`) of the
  terms they hold, then `ts_rank`, so a rare code outranks ordinary words.
- Only common terms, or a failed lookup: the old `plainto_tsquery` AND.

Measured on dev (read-only, same 35 turns): chunk keyword hits 4 → 33, node
keyword hits 8 → 35. A task id buried in a 30-word question: the old AND found
0 chunks; the new arm ranks the 3 chunks that hold it 1st to 3rd. Lookup cost
on the server for the longest message (136 lexemes): 25 ms execution, 11 ms
planning. The FTS-only legacy path of `searchNodes` (no query embedding) is
unchanged.

## Scale curve on a single-topic corpus (2026-10-03)

The capacity policy (watch 50k / split 100k passage vectors) came from the
literature, not from a measurement. This section measures it on the hardest
corpus we have: a brain of about 3,600 public-domain sermons by one preacher,
five whole Bibles, and a few commentaries (122,224 embedded chunks). Passages
in it are very alike: one author, one subject, the same Bible texts preached
again and again, the same verse in five translations.

### Method

1. **Gold set, passage level.** 98 questions, each with one target chunk
   (node + ordinal; any chunk of that node that holds the answer counts, so
   overlapping chunks are fair). Three groups:
   - `paraphrase` (40): a question about the specific point of one sermon
     passage, in modern words, no 4-word run copied from it.
   - `verse` (28): a question that names a verse and a translation ("What
     does Proverbs 23:13 say in the WEB about ..."). The target is that
     translation's chunk.
   - `trap` (30): two sermons on the same Bible text; the question has to
     be answered from one of them, and names the text.

   Generated once with a cheap model (`google/gemini-3.1-flash-lite`, 159k
   tokens in, 7k out, **$0.05**), then read by hand: 2 dropped (their
   "evidence" was the ESV cross-reference apparatus, not verse text), 12
   rewritten (too vague, or the verse was not named). The set names pages of
   one brain, so it lives outside the repo like every gold set here.

2. **Retrievers.** `eval:recall` gained three passage retrievers (see the
   header of [`eval-recall.ts`](../server/web/scripts/eval-recall.ts)):
   `passage` is `searchChunks()` with the query text, the exact call
   `search_chunks` and the responder's auto-context make; `passage-vector`
   is the same call without text; `passage-keyword` is the keyword arm on
   its own (`arms: 'keyword'`, a diagnostic option on `searchChunks`). Each
   is scored on the exact passage and on the document. `--retrievers=` skips
   `prod`, so it runs against a bare corpus copy with no agents.
3. **Nested sub-corpora.** A copy of the brain in a throwaway Postgres (the
   brain itself was only read). The gold documents and the trap partners
   (105 documents, 22,013 chunks) are always kept; every other document
   gets a fixed random rank and the corpus is cut at 100k, 75k, 50k and 25k
   chunks, whole documents at a time. Each cut is VACUUMed, the HNSW index
   rebuilt and ANALYZEd (the keyword arm reads `pg_stats`).
4. **Past today's size.** About 2,000 English religious books from Project
   Gutenberg (public domain; Spurgeon and King James texts left out, so no
   gold passage gets an exact twin) were chunked with the extractor's own
   `clampPieces(chunkDocText(...))` and embedded with the brain's own model
   (a stored chunk re-embedded to cosine distance 0.0003). Added in a fixed
   order, cut at 171,797 and 224,050 chunks (the load stopped at 224k).
   Embedding cost: **about $5.60** (101,826 chunks, about 43M tokens).

### Result

Exact passage in the top 10 (recall@10), and MRR, per corpus size:

| chunks  | hybrid R@10 | hybrid MRR | vector R@10 | keyword R@10 | doc R@10 (hybrid) |
| ------- | ----------- | ---------- | ----------- | ------------ | ----------------- |
| 25,000  | 50%         | 0.27       | 56%         | 8%           | 74%               |
| 50,000  | 40%         | 0.17       | 43%         | 4%           | 59%               |
| 75,000  | 37%         | 0.14       | 41%         | 3%           | 56%               |
| 100,000 | 35%         | 0.13       | 40%         | 3%           | 53%               |
| 122,224 | 33%         | 0.11       | 37%         | 2%           | 51%               |
| 171,797 | 31%         | 0.11       | 32%         | 2%           | 47%               |
| 224,050 | 27%         | 0.11       | 30%         | 2%           | 43%               |

The 122k row was measured twice (two HNSW builds); the second gave 34% /
38% / 52%. One case moves between parallel index builds.

With 98 cases one point carries about ±9 points of noise (bootstrap 95%),
but the cuts are nested, so the loss is paired: from 25k to 122k, 18 cases
stopped finding their passage and 1 started.

What it says:

1. **There is no cliff.** Recall falls about 5 to 8 points per doubling
   of the corpus and the slope flattens with size. Nothing in the curve
   marks 100k as special. Past today's size the slope holds: 122k to 224k
   (1.8x) costs 7 points (hybrid 34% to 27%), even though those added
   books are less alike than the brain's own sermons. Search time grows
   mildly: p50 147 ms at 122k, 200 ms at 224k (p90 236 to 393 ms, over a
   LAN).
2. **The absolute level is the problem, not the size.** Even at 25k only
   half of the questions find their passage. The misses are not junk: on
   the full corpus, most paraphrase and trap misses rank other sermons on
   the same theme, and 11 of 16 verse misses find the right Bible but the
   wrong chunk. Chunks are embedded as raw text, so a verse chunk knows
   neither its book nor its translation, and a sermon chunk does not know
   its title or text.
3. **Hybrid costs quality on this corpus.** At every size vector-only beats
   hybrid (R@10 by 3 to 6 points, R@1 8% vs 1% at 122k). The keyword arm
   alone finds 2% of passages: its rarity score sums the IDF of every term,
   so the question's frame ("author", "describe", "commentary") outvotes
   the one rare word that matters ("nautilus"). This is the
   user-message-shaped query the responder's auto-context sends.
   Fixed: see "Keyword arm on a single-topic corpus" below.
4. **A split would buy one halving.** Cutting the brain in two moves it one
   step left on the curve: about 5 points of R@10. A single-topic corpus
   cannot be split away from its own near-duplicates (both sermons on
   John 6:37 land in the same half), so the split remedy fits a mixed
   brain, where a category can leave, better than this one.

### What changed in the policy

`CAPACITY_POLICY.chunkVectors` moves from watch 50k / split 100k to
**watch 100k / split 250k**. The rule: a split is worth its cost (a
federated breakout brain, routing, a second index) when it recovers at least
**10 points of R@10**. On this curve one halving recovers about 6 points, so
splitting at 100k bought little; 250k is where the measured loss from 100k
reaches about 10 points (35% at 100k, 27% at 224k, the slope projects 25% to
26% at 250k). Watch at 100k is where the eval starts to matter, and the
dashboard dial now shows it (below). The document axis (10k / 20k) is
unchanged: this corpus has about 3,700 documents, so it says nothing about
that axis. A 250k index is about 0.8 GB of HNSW, well inside a small box.

The policy is one number for every brain, but corpus character changes what
to do at the line. A mixed brain (mail, projects, a church archive) can move
a category out and gain the halving. A single-topic brain like this one
cannot: its distractors are its own content. For it the lever is retrieval,
not a split: the hybrid fusion and the keyword arm's term weighting (point 3
above), and context in the chunk itself (a verse chunk that carries its book
and translation). The heartbeat already watches the measured score, which
catches both kinds.

The dial: `corpusCapacity` also returns `retrieval`, the passage score
(`chunks` arm, recall@10 and MRR) of the newest `recall_eval` run note, or
null when a brain has never run one. Size says when to look; the score says
whether quality moved.

Re-run: build the copy, then

```bash
ALLOWED_USER_ID=<uuid> pnpm -C server/web eval:recall --cases=<gold.json> \
  --retrievers=search,passage,passage-vector,passage-keyword
```

## Keyword arm on a single-topic corpus (2026-10-03)

Point 3 above, fixed. Same gold set, a fresh copy of the same brain
(122,256 chunks), current code against the fix.

### Why hybrid lost

Two causes, measured one at a time in an offline lab (cached vector pool,
keyword variants fused with the shipped RRF):

1. **Term weighting.** Rows ranked by the plain IDF sum of the terms they
   hold, so four ordinary question words outvoted the one rare word. Worse,
   most query words in this corpus sit between 0.4% and 2% of rows: below
   the `pg_stats` floor (2%) but above the count cap (500 rows), so they all
   got the same df and the order among them was alphabetical.
2. **The arm fires on every question.** The gold passages are paraphrased,
   so they rarely hold the question's words: only about 10 of 98 hold the
   rarest one (a name, "nautilus", "Portland vase"). On the rest the arm
   still filled its pool with rows that shared ordinary words. The rescue
   floor then pushed two of them into the top 10 (that alone cost 4 points
   of R@10), and RRF lifted any row both arms knew above the vector's first
   hit (that cost R@1: 8% to 1%).

Better weighting alone (rank weights, a frame stoplist, exact counts,
saturation, fewer terms) moved hybrid R@10 by at most 2 points: there is
little for a better ranking to find. The lever is to let the arm speak
only when it has a literal.

### What changed (`packages/search/src/keyword-query.ts`)

- **Rank weights.** The k-th rarest kept term weighs `idf * 0.5^k`, so the
  rarest term outweighs all the others together; the rest only order rows
  that tie on it.
- **Question-frame words** ("describe", "according", "author", "speaker",
  "perspective", "specific" ...) are dropped like chat filler. In an old
  corpus "perspective" is as rare as a name (16 rows here).
- **A rare-term gate on the passage arm** (`gateRareTerms`, used by
  `searchChunks` only): the arm returns only rows holding a term that no
  more rows hold than its pool (50 for a 10-hit search). A query without
  such a literal leaves the arm silent, so the vector order stands. The AND
  fallback is not gated. Node search (`searchNodes`) gets the weights and
  the stoplist, not the gate.

### Result (exact passage, 98 cases)

| retriever      | R@1 | R@10 | MRR  |
| -------------- | --- | ---- | ---- |
| hybrid, before | 1%  | 34%  | 0.11 |
| hybrid, after  | 8%  | 38%  | 0.17 |
| vector only    | 8%  | 38%  | 0.16 |

Hybrid now ranks the gold passage where vector-only does in 95 of 98
cases. One is a literal win: the "Portland vase" passage, which vector
misses, ranks first. Two are losses to rare-word rows: one gold passage
drops from first to second, one from ninth out of the top 10. Node search
is unchanged (document R@10 18%). Search time fell from p50 150 ms to
14 ms: the ungated OR query ranked match sets of tens of thousands of rows.

### Contextual chunk headers: tested, not adopted

The other lever named in point 2: embed each chunk with a header. This
corpus has no `heading_path` on any chunk, and Bible titles are file names
("engwebu.epub"), so the only context at hand is the document's title and
its summary (which names the translation: "...the World English Bible
Updated (WEB)..."). Every chunk of a second copy was re-embedded as
`title + summary (cut near 400 chars) + blank line + chunk text`, same
model; queries unchanged. Cost: 56.5M tokens, **$7.37** for 122,256 chunks.

| exact passage, 98 cases | R@1 | R@10 | MRR  | paraphrase | verse | trap |
| ----------------------- | --- | ---- | ---- | ---------- | ----- | ---- |
| hybrid, no header       | 8%  | 38%  | 0.17 | 30%        | 50%   | 37%  |
| hybrid, title + summary | 10% | 30%  | 0.17 | 23%        | 25%   | 43%  |
| vector, title + summary | 10% | 30%  | 0.16 | 23%        | 25%   | 43%  |

(group columns are R@10). Document R@10 fell too, 54% to 44%.

A header shared by every chunk of a document pulls those chunks together.
The right document wins more often at the top (trap R@1 10% to 23%), but
when a document wins, its chunks crowd the top 10: distinct documents in
the vector top 10 fell from 8.0 to 5.5 (paraphrase), 5.8 to 4.1 (verse)
and 7.4 to 4.9 (trap). A verse question names its translation, so all
3,856 chunks of that Bible move closer to it at once and the one verse
drowns among them.

So a document-level header is not a passage-level fix. What could still
help, untested: a header that differs per chunk (the book and chapter a
verse chunk sits in, the section a passage is under), which needs the
chunker to carry structure it does not have for these files, or a cap on
chunks per document in the top 10, which would keep the trap gain without
the crowding.

## Diversity cap and rerankers (2026-10-03)

The next step after the keyword fix: the same 98 cases, a fresh copy of the
same corpus. Base = hybrid `searchChunks`, top 10. All rows: exact passage.
The gold passage is in the hybrid top 50 for 54 of 98 cases (55%) and the
top 100 for 59: that is the ceiling any reranker of that pool can reach.

### A per-document cap: no win, not built

At most N chunks of one document in the top 10, the rest backfilled.

| cap  | R@1 | R@10 | MRR  | distinct documents |
| ---- | --- | ---- | ---- | ------------------ |
| none | 9%  | 39%  | 0.18 | 7.2                |
| 3    | 9%  | 38%  | 0.18 | 7.6                |
| 2    | 9%  | 38%  | 0.18 | 8.0                |

Without headers the top 10 is not crowded, so a cap has little to fix. It
would matter for document-level headers (above), which are not adopted.

### Rerankers on the hybrid top 50

Hosted rerank models through OpenRouter (`POST /api/v1/rerank`; the model
catalog lists them with output modality `rerank` and a price of 0, so the
cost below is the `usage.cost` each response reports), two small chat models
asked to pick the 10 best, and the decider's `passage_scoring` (Jev). Each
document is the node title, a blank line and the chunk text. Latency is one
search at a time, from the Mac.

| reranker                            | R@1 | R@10 | MRR  | p50    | $ per search |
| ----------------------------------- | --- | ---- | ---- | ------ | ------------ |
| none (hybrid)                       | 9%  | 39%  | 0.18 | 0.02 s | 0            |
| voyageai/rerank-2.5-lite            | 32% | 54%  | 0.39 | 1.6 s  | 0.00055      |
| voyageai/rerank-2.5                 | 32% | 55%  | 0.39 | 1.7 s  | 0.00136      |
| cohere/rerank-4-fast                | 17% | 52%  | 0.30 | 1.7 s  | 0.00202      |
| cohere/rerank-4-pro                 | 34% | 54%  | 0.41 | 2.7 s  | 0.00253      |
| qwen/qwen3-reranker-8b              | 34% | 55%  | 0.42 | 3.5 s  | 0.00621      |
| google/gemini-2.5-flash-lite (chat) | 16% | 37%  | 0.22 | 3.5 s  | 0.00133      |
| google/gemini-3.1-flash-lite (chat) | 27% | 39%  | 0.30 | 4.4 s  | 0.00323      |
| Jev, top 20 (today's pool)          | 34% | 44%  | 0.37 | 0.55 s | 0.00056      |
| Jev, top 50 (two requests)          | 36% | 53%  | 0.41 | 1.26 s | 0.00138      |

The rerankers nearly reach the ceiling: almost every gold passage in the top
50 lands in their top 10. A 100-deep pool (Voyage lite) gave 56% for twice
the cost. The chat models do not help. Jev on the top 20 is where a brain
with `passage_scoring` on stands today; the gap to the rerankers is the
pool, not the model: Jev on the top 50 matches them.

### What was built

No new worker kind and no new model. The decider's `passage_scoring` use
gained an optional `pool` (docs/decisions.md): unset keeps today's pool,
`pool: 50` scores the top 50 in two requests. The `search_chunks` tool path,
measured with the new `passage-scored` retriever (the tool's own sequence:
search, score, drop, cut):

| `search_chunks` with Jev | R@1 | R@10 | MRR  | p50 / p90       |
| ------------------------ | --- | ---- | ---- | --------------- |
| pool unset (20)          | 31% | 43%  | 0.35 | 0.56 s / 0.81 s |
| `pool: 50`               | 36% | 53%  | 0.41 | 1.24 s / 1.44 s |

The two requests of a fan-out are not served side by side, so its requests
may wait the worker timeout times the request count (without that, 14 of 98
searches ran past the 1.5 s timeout). With the pool set, the responder's
auto-context also scores before its budget cut when `context_pruning` is on:
before, pruning only saw the 8 passages search order had already chosen.

## eval:route: retrieval per question type (2026-10-03)

One fixed ruleset serves every question today, and a rule that wins on one
kind of question can lose on another (document headers: trap questions up,
verse questions down). `eval:route` scores passage retrieval PER QUESTION
TYPE so every routing rule is gated per type, not on one blended number.
Script: [`server/web/scripts/eval-route.ts`](../server/web/scripts/eval-route.ts);
the pure scoring and gate: `server/web/scripts/eval/route-score.ts` (tested).

```bash
pnpm -C server/web eval:route --cases=<file> --rulesets=hybrid,vector,scored \
  --vectors=<cache.json> --pool=50 --out=<run.json>
pnpm -C server/web eval:route --cases=<file> --rulesets=auto,auto-scored --vectors=<cache.json>
pnpm -C server/web eval:route --cases=<file> --rulesets=auto --baseline=<run.json> --target=T3
```

**Cases** are typed: `{id, query, type, flags?, profile?, expectChunks? |
expectNodeIds? | expectNodeTitleIncludes?}`. Types are the routing plan's
list: T0 small talk, T1 follow-up, T2 locate / quote (a rare literal, a code,
a reference), T3 scoped lookup (names a source), T4 fact lookup, T5 personal
history, T6 synthesis / explain, T7 data query, T8 action, `default`. One
primary `type`; `flags` hold the others that apply. Gold sets name one
brain's nodes, so they live outside the repo.

**Rulesets** (the first named is the reference; every other one is compared
to it, paired by case): `vector` (vector arm alone), `hybrid`
(`search_chunks` with the decider off), `auto` (the responder's
auto-context: hybrid pool of chunk_limit + 4, the 0.65 cutoff, the
chunk_limit cut), `scored` (`search_chunks` with Jev over the pool, ordered
as `live`), `auto-scored` (auto-context with Jev before the cut, v0.237.4).
A new routing rule is a new entry in `RULESETS`.

**Report**, per ruleset and type: n, R@1, R@10 (for `auto` rulesets, "in the
prompt"), MRR, p50/p90 latency of the ruleset's own work, and model cost.
Then, per type, cases won and lost against the reference at R@10 and R@1,
and the gate: **a change passes when no type loses more than 2 cases at R@10
or R@1 and a type (or the `--target` type) gains at either.** R@1 counts
because on a small corpus R@10 sits at the ceiling. At n = 98 one point is
about ±9 points of noise, so the gate reads case counts, not percentages.

**Cost.** Each query is embedded once and cached in `--vectors` (a repeat
run embeds nothing). The scored rulesets cost one Jev fan-out per case
(about USD 0.0007 per 25 passages); the run prints its total. Manual only:
never wire it to a cron or a trigger.

**A throwaway copy.** Run it against a copy, never a live box: restore a
dump into a throwaway Postgres (rebuild the HNSW index if the restore ran
out of shared memory), then re-seal the copy's provider key with your own
key and a throwaway master key (the source box's key stays on the box) and
check embedding parity on one stored chunk (0.0003 here). Both sets below
ran that way on the Linux workstation.

### Sets

| set      | profile  | n   | types (n)                                | corpus                                                 |
| -------- | -------- | --- | ---------------------------------------- | ------------------------------------------------------ |
| library  | library  | 98  | T2 (30), T3 (28), T6 (40)                | the sermons corpus above, 122,256 chunks               |
| business | business | 27  | T2 6, T3 5, T4 3, T5 3, T6 4, T7 3, T8 3 | a made-up engineering firm, 24 documents, no real data |

Library labels: `verse` → T3 (names a translation) with flag T2 (names a
reference); `trap` → T2 (names a reference, but the answer is in a sermon
ON it, the case a scope route must not misfire on) with flag T3;
`paraphrase` → T6.

### First numbers (v0.237.4 + this change, pool 50)

Library, exact passage:

| ruleset     | T2 R@1 / R@10 | T3 R@1 / R@10 | T6 R@1 / R@10 | all R@1 / R@10 / MRR | p50    |
| ----------- | ------------- | ------------- | ------------- | -------------------- | ------ |
| vector      | 7% / 37%      | 11% / 50%     | 8% / 28%      | 8% / 37% / 0.162     | 3 ms   |
| hybrid      | 10% / 37%     | 11% / 50%     | 5% / 28%      | 8% / 37% / 0.166     | 9 ms   |
| scored      | 43% / 57%     | 61% / 68%     | 13% / 40%     | 36% / 53% / 0.415    | 1.32 s |
| auto        | 10% / 37%     | 11% / 46%     | 8% / 28%      | 9% / 36% / 0.170     | 17 ms  |
| auto-scored | 50% / 57%     | 57% / 68%     | 15% / 40%     | 38% / 53% / 0.425    | 1.39 s |

`auto-scored` vs `auto`: T2 +6/-0, T3 +6/-0, T6 +5/-0 at R@10 (+17/-0 all);
R@1 +29/-1. Gate: pass. Cost: USD 0.137 per 98 searches (196 requests).
The `scored` numbers repeat the earlier lab (36% / 53% / 0.41), so the
harness measures what the lab measured. T6 (paraphrase) is the weak type:
40% at R@10 even with the judge; its gold is often past the pool (embedding
reach), not misranked.

Business (24 documents, so R@10 is at the ceiling; read R@1 and MRR):

| ruleset     | all R@1 / R@10 / MRR | note                                                    |
| ----------- | -------------------- | ------------------------------------------------------- |
| vector      | 67% / 96% / 0.809    | loses a T2 code question the keyword arm finds          |
| hybrid      | 67% / 100% / 0.827   | T3 R@1 40%, T4 33%, T5 33%                              |
| scored      | 100% / 100% / 1.000  | +9/-0 at R@1, every type at 100%; p50 0.48 s; USD 0.019 |
| auto        | 63% / 96% / 0.790    | misses T2 "valve V-118": see below                      |
| auto-scored | 96% / 96% / 0.963    | same T2 miss                                            |

The T2 miss, read off the decision trace: the keyword arm found the
commissioning plan (keyword rank 1, vector rank 17, fused rank 1), Jev scored
it 2.77, and the fixed 0.65 cosine cutoff then dropped it (distance 0.765).
The routing plan's "rescue fights the cut" weak point, now measured: a T2
ruleset where a keyword hit (or a judged one) is exempt from the cosine
cutoff is the obvious next rule to gate here.

## Automated eval: `recall_eval` + the brain-health heartbeat (2026-07-13)

The harness above is manual (`pnpm -C server/web eval:recall`). The automated
half runs the same idea inside the brain, on a schedule:

- **Golden cases live in the brain**: a note tagged `recall-eval-cases` whose
  content is a JSON array of `{id, query, expectNodeIds? | expectTitleIncludes?}`
  (the field name `expectNodeTitleIncludes` from `recall-cases.json` is accepted
  unchanged). Editable in the UI like any note, add a case the moment a recall
  miss annoys you.
- **`recall_eval` (builtin tool)** runs every case through the shipped
  retrievers as agents call them (hybrid `search_nodes` + hybrid passage
  `search_chunks`), scores
  recall@1/3/5/10 + MRR (pure helpers in `packages/search/src/eval.ts`),
  persists the run as a note tagged `recall-eval-run`, and reports drift vs
  the previous run, `alert: true` on MRR −0.05 or R@5 −0.10
  (`reason: 'quality_dropped'`). Run notes are ordinary nodes, so the
  history is searchable and chartable later.
- **Passages are scored on the hybrid path (since 2026-10-03).** Before,
  the `chunks` line called `searchChunks` with no query text, so it measured
  the vector arm alone while agents ran hybrid; the keyword-arm bug (above)
  hid for weeks behind that. Now `chunks` is the hybrid path (`chunksPath:
'hybrid'`), `chunksVector` keeps the vector-only number as a secondary
  line, and when the decider's `passage_scoring` has a `pool` set,
  `chunksScored` scores that pool with Jev and orders it as `live` would
  (whatever the use's mode), with its `requests` and `usd` (about USD 0.0007
  per 25 passages per case; the gold set bounds it). Chunks drift is read
  only against a run that also measured hybrid, so the switch raises no false
  alert. The capacity dial's `retrieval` number (the `chunks` R@10) now reads
  the arm agents use.
- **A gold set that matches nothing alerts on its own.** When EVERY case
  misses in both retrievers the run scores exactly 0/0, which drift reads as
  "no change" — that state sat silent for nine weekly runs on the dev brain
  (2026-07-20 → 2026-09-15; the set had been pasted in from another brain, so
  none of its node ids or titles existed). `recall_eval` now returns
  `alert: true, reason: 'gold_set_unmatched'` with `unmatchedCases` and a
  `detail` naming the fix (repair the `recall-eval-cases` note; prefer
  `expectTitleIncludes` for documentation nodes, whose ids churn on re-sync).
  Retrieval is unmeasured in that state, not degraded.
- **The `brain_health` heartbeat** ships in the system manifest, so every brain
  gets it — new ones at onboarding, existing ones on the next boot reconcile.
  It fires weekly ±6h with quiet hours, calls `brain_capacity` + `recall_eval`
  via the `brain_health_check` skill, and messages the user **only** when a
  capacity zone left green or the eval alerted; a green week is silence.
  A brain with no gold set is silence too: `recall_eval` returns
  `skipped: true` and the skill treats that as "unmeasured, not degraded".
- **Grants** are automatic: the persona holds the `brain-health` tool group
  (`brain_capacity`, `recall_eval`) by default, and `/debug/integrity` flags a
  heartbeat whose agent lost it.
- **Seeding is create-only.** Reconcile installs a missing heartbeat and never
  touches an existing one, so a heartbeat you paused stays paused and your
  schedule edits survive an upgrade.

The capacity half (zones vs the split policy: watch 10k docs / 100k passage
vectors, split 20k / 250k; the passage numbers are measured, see "Scale
curve" above) is `corpusCapacity` in
`packages/content/src/capacity.ts`, surfaced as the dashboard's **Brain
capacity** dial and the `brain_capacity` tool, one source, so the UI and the
alerts can never disagree.
