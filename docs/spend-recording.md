# Spend recording

How a provider call's usage (tokens, units, cost) gets onto the trace, the
step and the rollups that read them. One recorder, one recording point, one
usage shape (architecture plan A10 #5).

## The rule

Every provider call goes through the `@mantle/voice` adapter registry, and
every adapter the registry hands out is wrapped to record its own call. No
caller records spend by hand, and no caller adds a cost or a token count to
a total. A caller that needs a total reads it from the trace in context.

| Piece            | Where                                                                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recording point  | [`packages/voice/src/adapters/spend.ts`](../packages/voice/src/adapters/spend.ts), wired in [`registry.ts`](../packages/voice/src/adapters/registry.ts) | `getChatAdapter`, `getDecisionAdapter`, `getEmbeddingAdapter`, `getVisionAdapter`, `getImageGenAdapter`, `getTtsAdapter`, `getSttAdapter` (and the `list*Adapters`) hand out the adapter wrapped: each call that returns writes its usage. Chat and stream record outside the retry wrapper, so a retried call is one recording. A call that throws records nothing. |
| The one recorder | [`packages/tracing/src/spend.ts`](../packages/tracing/src/spend.ts)                                                                                     | `recordUsage(usage)`: prices the call and hands it to the attribution. `captureLlmUsage(raw, model)` reads a raw provider response for the one call outside an adapter (below) and writes through `recordUsage`.                                                                                                                                                     |
| Attribution      | [`packages/tracing/src/store.ts`](../packages/tracing/src/store.ts) `attributeUsage`                                                                    | Reads the trace, step and prelude from `AsyncLocalStorage`.                                                                                                                                                                                                                                                                                                          |

### The usage shape

`ProviderUsage` (`@mantle/tracing`):

- `capability`: chat, decision, embedding, vision, image_gen, tts, stt, research;
- `provider`: the adapter's provider id;
- `model`: the id the trace shows. Chat and decisions show the id the provider
  served (as they always did); vision shows the configured id; embeddings the
  requested id; image, speech and transcription the id the adapter echoes;
- `priceAs`: the ids the price table is tried on, in order: the requested id,
  then the served one;
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`;
- `units`: for a call not billed by the token: `images` (1 per image),
  `characters` (speech: the text length), `audio_seconds` (transcription: the
  duration the provider reports);
- `reportedCostUsd`: the provider's quoted cost (OpenRouter `usage.cost`).

### Where it lands

- **The trace totals** (`traces.tokens_in`, `tokens_out`, `tokens_cache_read`,
  `cost_micro_usd`): input includes the cache-write tokens. Written when the
  trace closes. These feed the dashboards, the per-agent and per-kind
  rollups, the member token budget and a run item's cost.
- **The running step's meta** (`model`, `provider`, `tokens_in`, `tokens_out`,
  `cache_read`, `cache_write`, the unit key, `cost_micro_usd`): numbers are
  summed over the step's calls, `model` and `provider` name the last one.
  Spend-by-model reads these. Only a step of the same trace takes it: a
  delegated agent's trace never writes onto its parent's tool step.
- **A prelude step** when no trace is open yet (a responder turn's context
  load and decider calls): the trace that opens next takes it.
- **A charged trace** (`chargeTo(target, fn)`): the totals only, never a
  step. For work beside a step rather than inside it (a narrated status line,
  `server/api/src/turn-narration.ts`) and work after the trace closed (the
  follow-up suggestion, `server/api/src/turn-suggestion.ts`, given the turn's
  `spendTarget()` by `packages/runtime/src/assistant/run-turn.ts`).
- **A trace that already closed**: an increment on its row, written after its
  close write so the absolute close values cannot land on top of it.
- **No trace, no prelude, no target**: nowhere. The call still runs; its
  usage is not kept (a route with no trace, a background embed outside one).

### Cost

The provider's reported cost when it gave one; else the static table in
[`packages/tracing/src/pricing.ts`](../packages/tracing/src/pricing.ts), tried on
`priceAs` in order. Recording spend never makes a network call: no price
lookup per request. Units have no price in the table, so an image, speech or
transcription call records its units at `$0` unless the provider quoted a cost.

## The one call outside an adapter

The research tools (`web_search`, `web_search_pro`,
[`packages/tools/src/builtins-research.ts`](../packages/tools/src/builtins-research.ts))
call OpenRouter through its SDK directly, because the request carries
Perplexity parameters the chat adapter does not model. Its raw response goes
through `captureLlmUsage`, which reads camelCase and snake_case usage, cache
reads and cache writes.

## Reading a total

- A run item's cost (its row, and so the run budget) is its own `run_item`
  trace's totals, read by `server/web/lib/runs/execute-item.ts` once the tool
  returns. A worker step does the same in
  `server/api/src/workflows/runs-worker-turn.ts`.
- A delegated agent's cost is its child trace's totals
  (`packages/runtime/src/agent/invoke-agent.ts`).

## Pins

`eslint-rules/spend-recording.mjs` counts two patterns, each 0 outside its
named list (the scoreboard, `pnpm arch:check`, pins the numbers; the lint
flags a file outside the list):

- `spend_handSpend`: a call of `recordUsage`, `captureLlmUsage` or
  `attributeUsage`, or a hand addition to a usage total (`costMicroUsd +=`,
  `tokens.in +=`, ...). Named: the recorder, the attribution, the recording
  point, the research tool.
- `spend_providerBypass`: an import of the unwrapped contract registry
  (`@mantle/voice-client/adapters/registry`), a `registeredChatAdapter(` call,
  `new OpenRouter(`, or the OpenAI speech calls (`transcribeAudio`,
  `synthesizeSpeech`) outside their adapters. Named: the registry wrapper, the
  OpenRouter chat adapter, the two OpenAI speech adapters, the research tool.

`eslint-rules/spend-recording.test.ts` also checks that every lookup the
contract package exports has a recording twin in `@mantle/voice`.

## Named changes (A10 #5)

Recorded per call path in
[`packages/runtime/src/agent/spend-recording.test.ts`](../packages/runtime/src/agent/spend-recording.test.ts):
its first commit recorded main, the move changed only the cells below.

Paths that newly record spend (main recorded nothing on the trace):

- `summarize_text` and `extract_from_image` tools: their chat and vision
  calls (main put hand `tokens_in`/`tokens_out` on the step, no cost);
- `generate_image`, speech (`synthesize_speech`, Telegram voice replies),
  transcription (Telegram voice notes, `video_ingest`): units and `$0` on the
  step (no unit prices), nothing on the trace totals;
- embeddings inside a trace (the `embed_batch` step: query embeds of a turn's
  context load and search tools, an extractor run's chunk embeds): input tokens
  on the trace, cost where the model is in the price table
  (`openai/text-embedding-3-*`), `$0` for the local embedder;
- narration (one cheap chat call per narrated status line) and the follow-up
  suggestion: on the turn's trace totals;
- the research tools called with no step handle (an MCP or `/api/v1` call
  inside a trace).

Caps and budgets that now see spend they did not see:

- **Member token budget** (`packages/content/src/member-turn-ledger.ts`, tokens
  in + out of a login's team `responder_turn` traces per day): now also counts
  the turn's embedding input tokens (tens per query) and, when the team turn
  is streamed with narration on, the narrator's calls (about 100 in + 32 out
  per narrated step). A member near the budget can hit it a few turns earlier.
- **Run budgets** (`runs.budget_micro_usd`, `spent_micro_usd`): a run item's
  cost now includes every priced provider call its tool makes (summaries,
  vision, image generation, embeddings), where main counted only the research
  tools' Sonar spend. A run with such items pauses for "raise or cancel?"
  sooner. Units-only calls stay `$0`.
- The daily turn cap counts turns, not spend: unchanged. The decider's pools
  and breaker count calls, not spend: unchanged (the decider's recorded
  numbers are the same).

Rollups and views whose numbers change:

- Spend by day, by agent, by trace kind (`server/web/lib/metrics.ts`): higher by
  the newly recorded paths above; `extractor_run` and `content_ingest` traces
  gain embedding tokens.
- Spend by model (step meta): new rows for embedding, image, speech and
  transcription models (their calls, units, and cost where priced); every LLM
  step's meta names its `provider`; a step with several calls (a multi-page
  vision step, an embed step with several batches) shows their sum, where main
  showed the last call's.
- Fallback pricing tries the requested id, then the served one: main priced
  the tool loop and the decider on the requested id only, and the summarizer,
  reflector, archive and extractor on the served id only. A call whose served
  id is missing from the table but whose requested id is in it (a direct
  provider answering under a dated id) now prices, where it read `$0`.
- Research: the cache-write tokens are counted into the trace input total and
  shown as `cache_write` on the step (Sonar reports none today).
