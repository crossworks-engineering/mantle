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

The model is TypeSafe **Jev** (`typesafe/jev-1.13` on OpenRouter), reached
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
previous user message, nothing else. Skipped for messages under 8 words, for
surfaces that cannot delegate (team, forum), and when the roster is empty.

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
direct turns; the chat baseline delegated 29 of them. Next improvement: put
the open page/app title in the state (the UI knows it); most misses were
short instructions about what the user had open.

### Declared, not built

- `version_grouping`: nouls over the top hits, "do `p3` and `p7` state the same
  fact about the same subject", so code can keep the newest by date /
  `superseded_by`. Needs its own spike first.
- `fact_add_prefilter`: fact reconcile, let a Jev `ADD` at confidence ≥ 0.9
  skip the chat classifier (≈35% of slow-path calls in the spike, zero harmful
  misses). Never let it emit `UPDATE` / `DELETE`.
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
- **Read the shadow week:** `/traces` steps named `decide_<use>`; `/debug`
  spend-by-model row `typesafe/jev-1.13`; the `search_chunks` step's
  `passage_scoring_dropped` meta.
- **Go live:** set `mode: 'live'` on the one use. Everything else stays shadow.
- **Kill switch:** disable the worker. Every call site is back to today's
  behaviour within 30 s, with no restart.
- **Cost guard:** the decider only rides on calls that happen anyway (a search,
  a turn). It adds no trigger, cron or sweep, per the cost-safety rule.
