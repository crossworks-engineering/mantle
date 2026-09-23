# Decisions: the `decider` worker and `decide()`

A typed-decision model sits beside the chat models. It writes no prose. You
give it **state** (text or JSON) and **typed questions**; it returns typed
answers with probabilities in about 300 ms:

| Question type | You give                              | You get                                                                    |
| ------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| `choice`      | option key → description              | the key, a probability per key, a confidence                               |
| `score`       | an ordered list of level descriptions | a fractional position on the rubric, a probability per level, a confidence |
| `noul`        | a yes/no question                     | P(yes)                                                                     |

**Confidence** is the shape of the distribution (1 = all mass on one option,
0 = flat). It is the number code gates on. **Probability** says which option.

The model is TypeSafe **Jev** (`~typesafe/jev-latest` on OpenRouter — the auto-updating alias), reached
through OpenRouter's `POST /api/alpha/decisions` endpoint — not chat
completions. Input-only billing ($0.042 per 1M tokens, answers free), 32k
context. The endpoint is **alpha**; everything below is built so that it
going away breaks nothing.

## 1. The rules

1. **Jev decides, the LLM writes. When Jev is not sure, the LLM decides.**
2. **Optional at every level.** No `decider` worker, worker disabled, use
   switched off, no key, HTTP error, timeout, malformed answer → `decide()`
   returns `null` and the caller runs the path it always ran. A decision sits
   in front of work the caller does anyway; it never blocks and never breaks
   it. No retries: a retry spends the latency the caller wanted to save.
3. **Switched per use, in the UI.** The worker's `enabled` toggle is the
   master switch. Each use has its own switch in `params.uses` with a `mode`:
   `shadow` (Jev runs, the answer lands in the trace, behaviour does not
   change) or `live` (the answer is used). New uses ship in `shadow`. The
   manifest seeds the worker **disabled**; an upgrade never turns it on.
4. **Two confidence floors.** Below `defer_below` (0.6) the answer is recorded
   and not acted on. Only at or above `act_alone_at` (0.9) may a caller act
   with no second check. Both are worker-level with per-use `min_confidence`
   overrides.
5. **Jev ranks, groups and flags. Code applies dates, `superseded_by` and
   thresholds. Jev alone never retires, merges or overwrites data.** This came
   out of the fact-reconcile spike (below): a confident wrong `UPDATE` retires
   a true fact, and a confidence gate does not stop it.
6. **Keep in code:** counting, arithmetic, date comparison, numeric closeness.
   Jev treats all of these as text. **Filter state first:** unrelated state
   lowers accuracy and costs tokens; name the fields a question uses in
   backticks. **Write contrastive criteria** ("not for …"); the model reads
   literally. **Never let a Jev answer alone authorise a side effect:** text
   inside the state can steer it.
7. **The state leaves the box** (OpenRouter → TypeSafe). Every call carries
   `provider: { zdr: true, data_collection: 'deny' }` (`params.zdr`, default
   on; OpenRouter honours both on this endpoint). Keep the worker off on a
   brain whose owner has not opted in.

## 2. Where it lives

| Piece                                                                                                                                         | File                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Worker kind `decider`, `DeciderParams`, `DecisionUse`                                                                                         | `packages/db/src/schema/ai-workers.ts` (migration 0158)                                   |
| Capability `decision`, `CAPABILITY_FOR_KIND.decider`                                                                                          | `packages/voice-client/src/providers.ts`                                                  |
| `DecisionDispatcher`, question/answer types                                                                                                   | `packages/voice-client/src/adapters/types.ts`                                             |
| Registry (`registerDecisionAdapter` / `getDecisionAdapter`, `WIRED_PROVIDERS.decision`)                                                       | `packages/voice-client/src/adapters/registry.ts`                                          |
| The one adapter                                                                                                                               | `packages/voice/src/adapters/openrouter-decision.ts` (+ wire-shape test)                  |
| **`decide()`**, `resolveUse`, per-owner resolution cache, in-process answer cache                                                             | `packages/decisions/src/decide.ts`, `cache.ts`                                            |
| Use: passage scoring                                                                                                                          | `packages/decisions/src/passage-scoring.ts`                                               |
| Manifest entry (optional, `enabled: false`)                                                                                                   | `server/web/lib/system-manifest/manifest.ts`                                              |
| Test button RPC + route                                                                                                                       | `server/web/lib/ai-worker-rpc.ts` `testDecision`, `app/api/ai-workers/[id]/test/decision` |
| Model pool `decider` (output modality `decisions`; a chat model is rejected here and Jev is rejected in every text pool) + one template entry | `packages/client-types/src/model-pools.ts`, `model-pools-data.json`                       |
| Pricing fallback rows                                                                                                                         | `packages/tracing/src/pricing.ts`                                                         |

`@mantle/decisions` depends on db, api-keys, voice, tracing. Both `@mantle/tools`
and `@mantle/runtime` depend on it (a tool cannot import runtime), which is why
it is its own package.

## 3. `decide()`

```ts
const outcome = await decide({
  ownerId,
  use: 'passage_scoring',
  state: { question, passages: { p1: {...}, p2: {...} } },
  questions: { p1: { type: 'score', instructions: '...', criteria: [...] }, ... },
  summarize: (answers) => ({ would_drop: 3 }),   // extra trace meta, optional
});
if (!outcome) { /* run the old path */ }
else if (outcome.mode === 'live') { /* act */ }
```

What one call does: resolve the owner's decider (worker + adapter + key,
cached 30 s, negative results too, so a brain without the worker pays one
query per half minute); read the use's switch; look the (use, model, state,
questions) tuple up in an in-process LRU (500 entries, 10 min); otherwise open
one `llm_call` trace step named `decide_<use>` and call the adapter with the
worker's `timeout_ms` (1500). Success: `recordChatUsage` (same meta keys as
every LLM step, so `/debug` spend-by-model shows Jev with no special case),
plus `meta.use`, `meta.mode`, `meta.decision_ms`, a compact `meta.answers`
(`"technical@0.75"`, `"2.99@0.99"`, `0.96`) and anything `summarize` adds.
Failure: `meta.failed`, the step is marked skipped (`decision_failed`, amber
in `/traces`), the caller gets `null`.

A shadow week is read from these steps: per use, how many calls, cache hits,
what the answers were, how many were under the floor, what it cost.

## 4. Uses

### `passage_scoring` (built; ships `shadow`)

After hybrid search returns its passages, one request scores each 0-3 on
"how well does this passage answer the question" (rubric in
`PASSAGE_LEVELS`). Code drops passages under `threshold` (1.5) and orders the
rest by score, ties in search order; passages past the per-request cap (25)
stay, unscored, at the end.

Wired at both passage sites:

- `search_chunks` tool (`packages/tools/src/builtins-search.ts`): when the use
  is on, the pool is `max(2×limit, 16)` capped at 25 instead of `limit`;
  `live` returns the top `limit` after pruning and adds `relevance` to each
  hit; `shadow` returns the first `limit` in search order (unchanged reply)
  and writes `passage_scoring*` meta on the tool step.
- Responder auto-context (`packages/runtime/src/agent/conversation.ts`): same
  pool rule; `live` prunes + reorders before the existing `selectChunkHits`
  budget cut; `shadow` leaves the list as it was.

Spike (dev brain, 2026-09-21, 40 synthetic questions × 20 passages): right
passage at rank 1 30% → 57%, MRR 0.41 → 0.63; dropping scores under 2.0 kept
16-29% of passage text and every gold passage; one batched request ≈ 430 ms,
≈ $0.0006 per search. Real questions are vaguer, so the shadow week measures
the true gain before anyone flips `live`. Freshness is **not** in the score:
a stale passage reads as a perfect answer; the supersede annotation stays in
charge.

### `delegation_hint` (built; ships `shadow`)

Before a responder turn, one `choice` over the agent's `delegate_to` roster
plus `none`, with each agent's description as the criterion (`remy` and
`none` carry tightened contrastive wording). State: the message and the
previous user message, and `open_surface: { kind, title }` when the user has
something open. Skipped for messages under 8 words (3 when a surface is
open), for surfaces that cannot delegate (team, forum), and when the roster
is empty.

`open_surface` (v2) is read off the note the web UI appends to a sent message
("On screen right now … - page "Title" (node …)", jackdaw
`buildContextPreamble`): `splitOnScreenNote` cuts the message at the note's
markers (the same three jackdaw's own transcript view splits on), so
`message` is what the user typed and the surface is a named field. No wire
change: surfaces that send no note (Telegram, mobile) simply have no
surface. The `none` criterion matches how the responder works today: it
edits pages and tables itself (the open one included) and hands a specialist
large jobs, work inside an app, and work on a specialist's own data source.
The trace data carries `surface` (the kind) next to the pick.

Re-run (NATREF, 2026-09-23, 130 web turns, 104 with an on-screen note): v2's
state beat today's on exact match (67 vs 63) and correct `none` (37 vs 33),
but hint precision stayed ~45% at 0.6 for every variant, because the labels
are stale: the responder stopped delegating page edits on 2026-08-12, and
`pcms-analyst` only exists since 2026-09-03. **Do not go live on the old
numbers**; the shadow week scores it against current behaviour.

Wired in `assembleResponderTurn` (`packages/runtime/src/assistant/assemble-turn.ts`),
so every delegating surface gets it through the same door; the web turn
passes the previous user message, Telegram passes the message only.

- `shadow`: the pick and confidence land on the `decide_delegation_hint`
  step; the same trace shows what the responder then did (`invoke_agent`
  steps), so the shadow week reads "hint given / right / wrong" per agent.
- `live`: when the pick is not `none` and confidence ≥ `defer_below`, one
  line joins the **volatile** system context: "Delegation hint: this message
  looks like work for `pages` (confidence 84%). Use your own judgment…". It
  is a hint. The tool loop's allowlist is still what delegation is checked
  against, and the responder can ignore it.

Spike (NATREF, 2026-09-22, 83 real turns): with that policy, 36 hints, 31
right, 4 wrong (2 arguable), 1 on a turn the responder answered itself —
86% precision, 296 ms, ~$0.00004 per turn. Jev said `none` on 15 of 30
direct turns; the chat baseline delegated 29 of them. Most misses were short
instructions about what the user had open, with the note still inside the
message: the reason for v2.

### `context_pruning` (built; ships `shadow`)

Once per responder turn, after retrieval and the supersede pass, ONE request
scores every injected item — facts, content hits, passages — 0-3 for "does
this help answer the question" (`packages/decisions/src/context-pruning.ts`,
wired in `loadConversationContext`). Code drops items under `threshold`
(default **1.0**) and keeps the rest best-first; each block keeps a floor
(2 facts, 1 hit, 2 passages); **preference facts are exempt**; history, the
corpus map, digests and relations are never touched. When this use is on,
the auto-context's separate `passage_scoring` call is skipped — the one
request covers the passages too (the `search_chunks` tool keeps its own).

- `shadow`: the `/debug/context` snapshot gains `pruning: { mode, threshold,
wouldDrop: {facts, contentHits, chunkHits}, charsSaved, ms, cached }`.
  Lists unchanged. A shadow week reads the cut per turn from there.
- `live`: the lists are pruned before the prompt is built, and the snapshot's
  `sent` / `dropped` rows move with them, so `/debug/context` shows what the
  model really received.

Spike (NATREF, 2026-09-22, 60 real turns, 1 524 items, dev-brain page
29a6b411): the answer relied on **13%** of injected context (facts 9%, hits
18%, passages 17%). Jev ranked a needed item above a not-needed one 82% of
the time. Cut under 1.0: 51% of characters kept, 10% of needed items lost;
under 1.5: 30% kept but 30% lost. A plain threshold beat every top-k mix.
One request per turn: ~26 items, 356 ms, $0.0002. Those were 240-character
snippets; production sends fuller text, so tighten only after a shadow week
on full items.

### `version_grouping` (built; ships `shadow`)

Once per responder turn, after context pruning, in `loadConversationContext`
(`packages/decisions/src/version-grouping.ts`). Stops two versions of one
passage from both reaching the prompt. Two parts:

- **Part A, code, no model.** A hit (content hit or passage) whose node is
  superseded, and whose living successor is also in the pool, goes. The
  supersede pass already resolved each stale hit to the living end of its
  chain, so this is a set lookup. It counts even when the model call fails.
- **Part B, the model, on what code cannot resolve.** Passage pairs from
  DIFFERENT nodes, not linked by `superseded_by`, with embedding similarity
  ≥ 0.75 (`chunkPairSimilarities` in `@mantle/search`: one query, the
  vectors stay in Postgres), at most 60 per request. One noul per pair:
  "are these two versions of the same passage", with the contrastive
  criteria from the spike. A direct yes at `threshold` (default **0.9**)
  drops the LOWER-RANKED passage. Never chained (a dropped passage causes no
  further drop); two sections of one node are never compared; the model
  never picks the newer copy (search rank keeps salience and recency).

- `shadow`: the `/debug/context` snapshot gains `versionGrouping: { mode,
threshold, wouldDrop: {superseded, versions}, pairs, ms, cached }`.
- `live`: the lists shrink before the prompt is built; the snapshot's
  `sent` / `dropped` rows move with them.

Spike (dev, 2026-09-22, dev-brain page b564522b): 30 real superseded pairs,
26 search pools, 47 stale passages. Part A alone: 0 stale passages above
their successor, 0 other drops. The wording above: precision 1.00 at 0.8 and
0.9 on 33 labelled negatives (the older "same fact about the same subject"
wording grouped 14 of 33 at 0.5); at 0.9 every grouping in real pools was a
genuine unlinked copy. ~400 ms, ~$0.0005 per request.

### `fact_add_prefilter` (built; ships `shadow`)

On the extractor's slow path (a candidate fact with close neighbours,
`server/api/src/agent/extract/facts.ts`), before the chat classifier: one
four-way choice, add / update / delete / noop
(`packages/decisions/src/fact-add-prefilter.ts`). The `add` and `update`
criteria spell out the multi-valued case ("a project uses many line
classes") because that is where the spike saw Jev go wrong.

- The ONE rule: a Jev `add` at or above the gate (the use's `threshold`, else
  the worker's `act_alone_at`, 0.9) skips the chat call in `live`. Every
  other answer (any update / delete / noop, or a low-confidence add) goes to
  the chat classifier as today. Jev never retires or rewrites a fact.
- Evidence: a `fact_add_prefilter_verdict` step in the `extractor_run` trace
  per slow-path fact: `meta.jev` (`add@0.93`), `gate`, `would_skip`, `chat`
  (the classifier's decision, null on a live skip) and `agree`. The shadow
  week reads: of the steps with `would_skip: true`, how many have `chat: ADD`
  (target ≥ 95%).

Spike (NATREF, 2026-09-21, 60 real slow-path cases, dev-brain page
f28a25cf): Jev ADD at ≥ 0.9 on 22 of 60 cases (37%), the chat model also
said ADD on 22 of 22. Jev's UPDATE was wrong once at 0.99, so no confidence
makes its update / delete safe. The shipped wording is new (the spike's exact
round-2 text was not kept); the shadow week is its test.

### Declared, not built

- `model_routing`: per-request complexity score + needs-tools / needs-code /
  sensitive nouls + language choice; code picks a route from the model pool;
  short conversational replies skip the router; under the floor the current
  route stays. Mantle owns the adapter call, so it can switch routes for real
  (shadow = the verdict is only a trace note).

## 5. Spike results (what decided the order)

- **Fact reconcile `ADD/UPDATE/DELETE/NOOP`** (60 real cases): Jev 3× faster,
  4.3× cheaper, but only ~70% agreement with the chat classifier, and on the
  adjudicated disagreements the chat model was right 10-4. Jev reads a
  multi-valued attribute ("project uses line class A" vs "… B") as a conflict
  and says `DELETE` / `UPDATE`, once at confidence 0.99. **Not a replacement.**
- **Stale vs fresh from text alone** (60 old/new fact pairs): 68% right (chat
  60%). Superseded passages scored 2.5-2.9 for relevance and ~0.03 on "says it
  is outdated". **Text cannot tell Jev what is current; code has the dates.**
- **Passage scoring:** see above. **Build first.**

Full write-ups: dev-brain pages `cdf6a97c-5b84-485e-8698-9c266614318c`
(study + integration rules), `f28a25cf-8911-43a3-a9e9-f10e40e90a38` (spike 1),
`bb01f5dd-e0e9-4c22-b712-1ee81dacc560` (spike 2 + switch design).

## 6. Adding a use

1. Add the name to `DecisionUse` (`packages/db/src/schema/ai-workers.ts`).
2. Write the use beside `passage-scoring.ts`: build a focused state, atomic
   questions with contrastive criteria, call `decide()`, and give the caller a
   **pure** apply function it can run in `live` and merely count in `shadow`.
3. At the call site: `decisionUseEnabled()` if the pool size depends on it,
   `null` → old path, honour `outcome.mode`.
4. Add the use to the manifest `params.uses` as `{ enabled: false, mode:
'shadow' }`, and to the jackdaw worker form under "Experimental".
5. Check the question against the weak-spot list (rule 6) and make sure no
   answer alone can retire, merge or overwrite anything.
6. Document it here.

## 7. Operating it

- **Turn on:** Settings → AI Workers → Decider: enable the worker, then enable
  a use in `params.uses` (mode `shadow`). Until the jackdaw form ships the
  toggles, edit `params` as JSON. The resolution cache means a flip takes up
  to 30 s to reach a running process.
- **Read the shadow week.** Every use leaves a `decide_<use>` step in the
  turn's trace, with its cost. On the web, MCP sim, forum and team surfaces
  the context load and the turn assembly run BEFORE the trace opens (the
  trace's subject is the inbound row, written only after the load so history
  cannot contain the new message). Those steps are held in a trace prelude
  (`createTracePrelude` / `withTracePrelude` in `@mantle/tracing`) and
  written as the trace's first steps, marked `meta.prelude: true`, with their
  tokens and cost added to the trace total. Telegram and the runs resume
  already run inside their trace. Per use, also read:
  - `passage_scoring`: the `decide_passage_scoring` step inside each
    `search_chunks` tool call, plus the tool step's `passage_scoring_*` meta.
  - `context_pruning`: the `load_context` step's output →
    `snapshot.pruning` (`mode`, `threshold`, `wouldDrop`, `charsSaved`, `ms`).
  - `delegation_hint`: the turn's `traces.data.delegation_hint` (`pick`,
    `confidence`, `mode`), read against the same trace's `invoke_agent` steps.
  - Cost: `/api/debug/spend` splits each decision model's row by use
    (`modelSpend[].uses`: calls, failed, cost, tokens in, mean ms). Cache hits
    make no call and leave no step. A failed call is logged under the model
    id the worker asked for (`~typesafe/jev-latest`), not the served one.
- **Go live:** set `mode: 'live'` on the one use. Everything else stays shadow.
- **Kill switch:** disable the worker. Every call site is back to today's
  behaviour within 30 s, with no restart.
- **Cost guard:** the decider only rides on calls that happen anyway (a search,
  a turn). It adds no trigger, cron or sweep, per the cost-safety rule.
