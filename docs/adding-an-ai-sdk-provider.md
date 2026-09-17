# Adding an AI SDK provider

Companion to [`docs/adding-a-provider.md`](./adding-a-provider.md), which covers
hand-writing an adapter against a provider's HTTP API. This one covers the other
route: wrapping a `@ai-sdk/*` package so the Vercel AI SDK does the wire
translation and we keep the `ChatDispatcher` contract.

Both routes are legitimate. Read "Which route" below before picking.

---

## Current state

**No AI SDK package is installed.** The pilot adapter
(`packages/voice/src/adapters/anthropic-chat.ts` (the AI-SDK variant was retired), a complete unwired
`ChatDispatcher` on `@ai-sdk/anthropic`) was **removed on 2026-08-04**, along
with the `ai` and `@ai-sdk/anthropic` deps, once it had produced its findings.
Recover it with `git show <commit>^:packages/voice/src/adapters/anthropic-chat-aisdk.ts`
if you want the reference implementation back; the five frictions below are all
commented inline in that file.

It was deleted rather than kept because an unwired parallel adapter is a second
thing to maintain: it drifted out of date the moment `ChatResult` gained
`finishReason`, and a reference implementation nobody runs decays silently.

**What the pilot actually bought us.** Beyond proving the wire bodies match, the
comparison surfaced one live bug in our own hand-written adapter. Anthropic
rejects `temperature`/`top_p` as a property of the **model**, not of whether
thinking was requested; ours dropped them only while thinking was on, so every
tool-continuation round (where `wantGuardedThinking` suppresses thinking) put
temperature back on the wire for `claude-opus-4-7` and `claude-sonnet-5`, both
in our catalogue. Fixed in `anthropicRejectsSamplingParams`. Reading a mature
SDK's capability table against our own is a cheap, repeatable audit, see
"Mining the SDK without adopting it" below.

The research that led here, including the case _against_ wholesale adoption, is
dev-brain page `e75bfbe5-35eb-4ac6-9909-6ed233ac42cd`.

---

## Mining the SDK without adopting it

You do not need the package installed to learn from it. Both of these read the
published artefacts directly:

```sh
# The provider's own capability table + option schema (readable, unminified).
curl -sL https://cdn.jsdelivr.net/npm/@ai-sdk/<provider>/dist/index.js

# The typed surface, including which model factories the provider implements.
curl -sL https://cdn.jsdelivr.net/npm/@ai-sdk/<provider>/dist/index.d.ts
```

Read the provider's own `*Provider` interface rather than grepping the whole
file: the shared `ProviderV4` base declares every modality, so a bare grep for
`textEmbeddingModel` "finds" embeddings on providers that return `never`.

What is worth harvesting: per-model capability flags (which params a model
rejects), the full stop-reason enum, and documented mitigations for provider
quirks. What is not: wire translation we already have working and tested.

### What the sweep has caught so far

Each of these was a live defect that no test, error or log would have shown you,
because none of them fails loudly. That is the shape of what this audit is good
at: not crashes, but a wrong number or a stale knob that nothing contradicts.

| Found in            | The defect                                                                                                                                                                                     | Fixed in                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `@ai-sdk/anthropic` | `temperature`/`top_p` are rejected as a property of the MODEL; we dropped them only while thinking was on, so every tool continuation put one back on the wire                                 | `anthropicRejectsSamplingParams`           |
| `@ai-sdk/google`    | `thoughtsTokenCount` is reported separately from `candidatesTokenCount` and the response is priced on the SUM. We read only the latter, under-reporting every thinking turn                    | `googleOutputTokens`                       |
| `@ai-sdk/google`    | Gemini 3 takes `thinkingLevel`, not `thinkingBudget`. The old field is still accepted, so this never 400'd, Google documents it as "unexpected performance" on Pro instead                    | `geminiThinkingLevel`                      |
| `@ai-sdk/deepseek`  | (by comparison, not from the SDK) `chat()` read DeepSeek's `prompt_cache_hit_tokens`; `chatStream()` used the shared streamer's default lookup and lost it. Streaming is the responder's path  | `OpenAICompatStreamConfig.cacheReadTokens` |
| `@ai-sdk/xai`       | `reasoning_effort` is honoured on `grok-4.5` and `grok-4.20-multi-agent` (where it sets agent COUNT), not on the `-reasoning`/`-non-reasoning` pair. Our catalogue told operators the opposite | `catalogs/xai.ts`                          |

Two patterns to carry forward. **Usage accounting is the richest seam**: every
provider splits its counters differently and a missed field is silent money.
**Check `chat()` against `chatStream()` while you are in there**: the SDK
comparison keeps surfacing our own two paths disagreeing, which is a defect
class the SDK does not have (it has one path) and our tests mostly did not
cover.

---

## Which route: SDK or hand-written?

The SDK removes **wire translation**. It does not remove **model-capability
knowledge**, catalogues, or discovery. That split decides the question.

Prefer the **AI SDK** when:

- The provider's auth is genuinely hard to hand-write. Bedrock needs SigV4
  request signing; Azure needs Entra ID plus deployment-name routing rather than
  model ids. That is the strongest case in the whole discussion; it is real work
  with no Mantle-specific value.
- The provider's wire shape is materially different from anything we already
  speak, so `openai-compat.ts` gives us nothing.

Prefer **hand-writing** when:

- The provider speaks the OpenAI-compatible dialect. Six of our adapters already
  share `openai-compat.ts`; adding a seventh is a catalogue file and a thin
  adapter. The SDK would replace ~360 lines of shared, working, understood code.
- The provider is OpenRouter. It is the default path, already on its own vendor
  SDK, and 880 lines that are mostly cache-breakpoint placement and discovery,
  none of which the AI SDK subsumes. Swapping it trades one vendor SDK for
  another.

---

## What the SDK does NOT give you

Budget for these regardless of route. They are roughly half the per-provider cost.

| Concern                               | Who owns it                               |
| ------------------------------------- | ----------------------------------------- |
| Wire translation, auth                | **SDK**                                   |
| Streaming deltas                      | **SDK**                                   |
| Prompt-cache breakpoints              | SDK carries them; placement is still ours |
| Per-model capability guards           | **Ours**: see below                      |
| Static catalogue + pricing            | **Ours** (`packages/voice/src/catalogs/`) |
| `discoverModels`                      | **Ours**                                  |
| Registry wiring, `providers.ts` entry | **Ours**                                  |
| Retry / error enrichment              | **Ours**                                  |

The capability guard is the one people miss. `anthropicEffort()` in
`anthropic-chat.ts` stops an effort tier reaching Sonnet 4.5 and Haiku 4.5, which
**reject the parameter and 400**, and steps `xhigh` down on models that predate
it. The AI SDK has no equivalent and will happily send a tier a model refuses.
The pilot imports that function rather than reimplementing it, do the same.

---

## The five frictions, and what to do about each

All five were hit during the Anthropic pilot. None is fatal; all cost time if you
meet them cold.

### 1. `tool-result` requires `toolName`; our message shape has only `toolCallId`

Anthropic's wire format keys `tool_result` purely by id. The SDK's part type
demands the tool's _name_ as well, which lives on the assistant turn that
requested the call.

**Do:** walk messages forward building an `id → name` map, as the pilot's
`toModelMessages()` does. Fall back to a placeholder when the pairing assistant
turn is outside the window; our shape does not guarantee one is present.

**Note:** this is complexity the abstraction _adds_. Do not be surprised by it.

### 2. Multi-block system prompts need `allowSystemInMessages`

The responder splits the system prompt into persona + digest, each independently
cache-marked. The SDK's `instructions` field is a single string, which flattens
them and **silently destroys the per-block cache breakpoints**: the single
biggest cost lever we have.

**Do:** set `allowSystemInMessages: true` and emit one `{role:'system'}` message
per block, each carrying its own `providerOptions`. Verify with a wire diff (below).

### 3. `.text` vs `.delta` on stream parts

The high-level `stream` parts carry `.text`. The low-level provider union spells
the same field `.delta`. Both are in the same `.d.ts`.

**Do:** read `.text` when iterating `result.stream`. Keep the path cast-free, the
type checker catches this, but a stray `any` ships a stream that emits nothing and
looks exactly like a model that returned no text.

### 4. Not every type is exported

`ProviderOptions` is declared but not exported from `ai`, so the cache-control
blob has no nameable type. Restate it inline with `as const`.

**Do:** when a type will not import, check the `.d.ts` before assuming you have
the name wrong. Some genuinely have no public name.

### 5. The v7 renames

v6 → v7 renamed `system` → `instructions`, `fullStream` → `stream`, `onFinish` →
`onEnd`, and moved OpenTelemetry out of core. Two of those bit the pilot.

**Do:** read the installed `.d.ts` rather than trusting a tutorial or memory. The
option names are greppable:

```sh
grep -oE "^\s+(instructions|messages|maxOutputTokens|providerOptions|toolChoice)\??:" \
  node_modules/.pnpm/ai@*/node_modules/ai/dist/index.d.ts | sort -u
```

---

## Steps

1. **Catalogue the provider** in `packages/voice/src/providers.ts`, and add a
   static model catalogue in `packages/voice/src/catalogs/`. Unchanged from the
   hand-written route; the SDK does not supply either.
2. **Install the provider package** into `packages/voice` with a **caret** range
   (`pnpm add @ai-sdk/<provider>@^x.y.z`). A bare `pnpm add pkg@version` pins
   exact, which freezes you out of in-range fixes.
3. **Write the adapter.** The removed `anthropic-chat-aisdk.ts` is the worked
   example, recover it from git history (see "Current state") and copy from
   there. Keep `buildArgs()` shared between `chat` and `chatStream` so the two
   cannot drift.
4. **Do not give tools an `execute` function.** Our `runToolLoop` dispatches.
   Omitting `execute` is what stops the SDK's own agent loop from taking over.
5. **Write the capability guard** if the provider rejects any parameter on any
   model. Model it on `anthropicEffort()`: an explicit deny set, an explicit
   step-down set, and full support as the default for unknown models.
6. **Diff the wire body against a known-good adapter** (see below). This is the
   step that turns "it compiles" into "it is correct".
7. **Register** in `packages/voice/src/adapters/index.ts` and add wire-shape tests
   next to the adapter.

---

## The verification technique

This is the part worth keeping. It is what made the pilot conclusive instead of
anecdotal, and it generalises to any adapter.

Push **identical `ChatOptions`** through the new adapter and a known-good one,
capturing the emitted request by swapping `globalThis.fetch`, then compare:

```ts
async function wire(adapter, opts) {
  let body = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify(FIXTURE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await adapter.chat(opts);
  } finally {
    globalThis.fetch = real;
  }
  return body;
}
```

Cover at minimum:

- a plain request (model, max_tokens, tools, sampling params)
- a **tool-call round-trip** (assistant with `toolCalls`, then a `tool` result)
- **cache breakpoints**: multi-block system with per-block markers, plus
  `lastUserMessage`
- **streaming**: feed a canned SSE body and compare the delta sequence, the
  resolved text, and `tokensIn`/`tokensOut`

The Anthropic pilot matched on all four: tool round-trip and cache breakpoints
were byte-identical, streaming was identical, and the plain request differed only
cosmetically (block arrays instead of plain strings, explicit `tool_choice`).

**Assert on the serialised body, never on the object handed to the SDK.** That
distinction is not pedantic: `openrouter-chat` shipped two fields for the life of
the adapter that were silently discarded during serialisation, green tests
throughout, because the tests asserted intent rather than output.

---

## Cost of ownership

The AI SDK shipped two breaking majors in roughly fifteen months (v6 in May 2026,
v7 after). Codemods cover most of it, but the schedule is Vercel's, not ours.
Each provider package versions independently, so adoption is genuinely
incremental (you can take Bedrock and skip Google) but every package you take is
another line on that bill.

`deps-drift` will tell you when you have fallen behind in range. It will not tell
you when a major is worth taking; that stays a judgement call.
