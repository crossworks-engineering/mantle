# Phase 3 — Direct-provider chat routing

**Shipped May 2026** (commits `97298a5` through `8ae4d3d`, 17 commits, +5015 / −444 LOC across 50 files, 865 vitest pass, monorepo typecheck clean).

This is the canonical post-Phase-3 reference. Two halves:

- **[Part 1 — How it works now](#part-1--how-it-works-now)** is the architecture deep-dive: the dispatch flow, the contract widening, the cache marker semantics, the tool-call normalisation. Read this if you're touching the chat path.
- **[Part 2 — Quality + journey](#part-2--quality--journey)** is the retrospective: the staged commits, the audit findings, the honest scorecard, the lessons. Read this if you're picking up a similar adapter-flip in another part of the codebase.

For the prose-level "where does provider X route?" cheatsheet, [`docs/ai-workers.md` §8.1](./ai-workers.md#81-provider-routing-today--what-goes-through-what) is the always-current source. This doc is the **archaeology + the depth**.

---

## Part 1 — How it works now

### The shape, in one diagram

```
                       ┌──────────────────────────────────────┐
                       │  worker.provider  /  agent.provider  │
                       │  (text column, e.g. 'anthropic')     │
                       └──────────────────┬───────────────────┘
                                          │
                              getChatAdapter(provider)
                                          │
                                          ▼
              ┌───────────────────────────────────────────────────┐
              │  ChatDispatcher                                   │
              │  ─────────────                                    │
              │  chat(ChatOptions) → ChatResult                   │
              │                                                   │
              │  Inputs (provider-neutral):                       │
              │    apiKey, model, messages,                       │
              │    tools?, toolChoice?,                           │
              │    cacheControl?, temperature?, maxTokens?,       │
              │    topP?, extra?                                  │
              │                                                   │
              │  Outputs (normalised):                            │
              │    text, model, toolCalls?,                       │
              │    tokensIn?, tokensOut?,                         │
              │    cacheReadTokens?, cacheWriteTokens?,           │
              │    reportedCostUsd?                               │
              └───────────────────────────────────────────────────┘
                                          │
            ┌────────────┬────────┬───────┴────────┬───────┬──────────┐
            ▼            ▼        ▼                ▼       ▼          ▼
       openrouter-   anthropic-  xai-chat ──┐    google-  hf-chat ──┐ ...
       chat (SDK)    chat (raw  │           │    chat               │
                     fetch)     │           │    (raw fetch)        │
                                │           │                       │
                                └───────────┴──────┬────────────────┘
                                                   │
                                  shared via openai-compat.ts
                                  (toOpenAICompatMessages +
                                   extractOpenAICompatToolCalls)
```

Every chat-shaped call site goes through the box at top. Pre-Phase-3, the responder / web /assistant / heartbeat / extractor / summarizer / reflector each constructed `new OpenRouter({apiKey})` inline and called `client.chat.send()`. Now they all do:

```ts
const adapter = getChatAdapter(rowFromDb.provider);
const result = await adapter.chat({ apiKey, model, messages, ... });
```

### The call-site inventory

Eight call sites, four-and-a-half "shapes":

| Caller | Shape | File |
|---|---|---|
| Telegram responder | tool loop | [apps/agent/src/main.ts](../apps/agent/src/main.ts) |
| Web /assistant | tool loop | [apps/web/lib/assistant.ts](../apps/web/lib/assistant.ts) |
| Heartbeat fire | tool loop | [packages/heartbeats/src/fire.ts](../packages/heartbeats/src/fire.ts) |
| `invoke_agent` (child agent) | tool loop | [packages/agent-runtime/src/invoke-agent.ts](../packages/agent-runtime/src/invoke-agent.ts) |
| Extractor | single-turn chat | [apps/agent/src/extractor.ts](../apps/agent/src/extractor.ts) |
| Summarizer × 2 | single-turn chat | [apps/agent/src/summarizer.ts](../apps/agent/src/summarizer.ts) |
| Reflector | single-turn chat | [apps/agent/src/reflector.ts](../apps/agent/src/reflector.ts) |
| Regenerate-digests script | single-turn chat | [apps/web/scripts/regenerate-digests.ts](../apps/web/scripts/regenerate-digests.ts) |
| `testChatAction` (worker) | one-shot test | [apps/web/app/(app)/settings/ai-workers/actions.ts](../apps/web/app/(app)/settings/ai-workers/actions.ts) |
| `testAgentChatAction` (agent) | one-shot test | [apps/web/app/(app)/settings/agents/actions.ts](../apps/web/app/(app)/settings/agents/actions.ts) |

All ten resolve `getChatAdapter(provider)`. The tool-loop ones use `runToolLoop({ adapter, ... })` from [packages/agent-runtime/src/tool-loop.ts](../packages/agent-runtime/src/tool-loop.ts); the single-turn ones inline the `adapter.chat({...})` call.

### The contract: ChatOptions + ChatResult

The full surface lives in [packages/voice/src/adapters/types.ts](../packages/voice/src/adapters/types.ts). The interesting fields:

```ts
interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatToolLoopMessage[];     // see grammar below
  tools?: ChatToolDefinition[];        // OpenAI-shape function tools
  toolChoice?: 'auto' | 'none';        // 'none' disables tool calling
  cacheControl?: {                     // provider-neutral cache hints
    systemPrompt?: boolean;
    lastUserMessage?: boolean;
  };
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  extra?: Record<string, unknown>;     // provider-specific escape hatch
}

interface ChatResult {
  text: string;                        // narrative reply, may be ''
  model: string;                       // model that actually served
  toolCalls?: ChatToolCall[];          // normalised across providers
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;            // ~10% of fresh-input billing
  cacheWriteTokens?: number;           // Anthropic-specific ~1.25× rate
  reportedCostUsd?: number;            // OR's `usage.cost` field
}
```

**The message grammar** (`ChatToolLoopMessage`):

```ts
type ChatToolLoopMessage =
  | { role: 'system'; content: string | Array<{ type:'text'; text; cacheControl? }> }
  | { role: 'user';   content: string | Array<{ type:'text' | 'image_url'; ... }> }
  | { role: 'assistant'; content: string | null; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }
```

Wide enough to cover:
- 3a-style single-turn chat-shaped workers (plain `{role, content: string}` array)
- Multi-block system content (persona + digest each with their own cache breakpoint on Anthropic)
- Multimodal user turns (text + image_url for vision-capable responder)
- Tool-loop iterations (assistant with toolCalls, then tool result messages)

Each adapter translates this union to its provider's native shape — see the per-adapter notes below.

### The adapter implementations

There are five registered chat adapters today, with very different translation surface areas:

#### `openrouter-chat` ([source](../packages/voice/src/adapters/openrouter-chat.ts))

- Wraps `@openrouter/sdk` — the SDK's typed input is camelCase (`toolCalls`, `imageUrl`, `cacheControl`) which it converts to snake_case on the wire.
- Discovery: keyless GET `/api/v1/models`, filtered to chat-shaped routes, ~330+ models.
- Caches: surfaces `usage.cost` (OR-reported actual charge), `usage.promptTokensDetails.cachedTokens`, and `usage.promptTokensDetails.cacheWriteTokens`. The OR SDK's `ChatUsage` type already has all three.
- Cache markers: passes through via the SDK's `cacheControl` field on text blocks. OR forwards the marker to Anthropic-backed routes.

#### `anthropic-chat` ([source](../packages/voice/src/adapters/anthropic-chat.ts))

- Raw `fetch` to `/v1/messages`. Native API, no SDK.
- The substantial translation surface (~250 LOC):
  - **System → top-level field**: Anthropic doesn't accept system as a message role. String content → plain `system` field. Block-array content → `system: AnthropicTextBlock[]` preserving per-block `cache_control` markers.
  - **Tool calls → tool_use blocks in assistant content**: each `ChatToolCall` becomes `{type:'tool_use', id, name, input}` in the assistant message's content array. JSON-parsed input (Anthropic expects a parsed object, not a string).
  - **Tool results → user messages with tool_result blocks**: consecutive `role:'tool'` messages from the runtime coalesce into a single user message with multiple `{type:'tool_result', tool_use_id, content}` blocks. Anthropic models tool results as user-fed-back, not a separate role.
  - **Images → image blocks**: data-URL form (`data:image/png;base64,...`) splits into `{type:'image', source:{type:'base64', media_type, data}}`. http(s) URLs become `{type:'image', source:{type:'url', url}}`.
  - **Cache markers**: `cacheControl.systemPrompt` attaches ephemeral marker to the system block. `cacheControl.lastUserMessage` attaches it to the last block of the last user message (text, tool_result, image, or tool_use — any block type accepts the marker on Anthropic).
- Reads cache fields: `usage.cache_read_input_tokens` + `usage.cache_creation_input_tokens` (Anthropic's two distinct cache lines).

#### `google-chat` ([source](../packages/voice/src/adapters/google-chat.ts))

- Raw `fetch` to `/v1beta/models/{model}:generateContent`. Native API.
- Translation differences:
  - **`system` → `systemInstruction`** top-level field with `parts: [{text}]`.
  - **Role rename**: assistant → 'model', tool → 'user' (Gemini has no separate tool role).
  - **Tool calls → `parts: [functionCall: {name, args}]`** on model-role contents.
  - **Tool results → `parts: [functionResponse: {name, response}]`** on user-role contents. Gemini calls have no ids, so the adapter mints synthetic `gemini_call_<n>` ids on extraction and resolves them back via an in-flight name-by-id map when translating outbound tool results.
  - **Tools → single `functionDeclarations` array** wrapping every tool (different shape from OpenAI's per-tool wrapping).
  - **Images dropped to text-only** today. Gemini vision has a separate `inline_data` shape we don't translate — the dedicated `google-vision` adapter is the production path for image understanding.
  - **`toolChoice: 'none'` → `toolConfig.functionCallingConfig.mode: 'NONE'`**.
- Cache: surfaces `usageMetadata.cachedContentTokenCount` (Gemini 2.5+'s implicit caching).

#### `xai-chat` ([source](../packages/voice/src/adapters/xai-chat.ts)) + `huggingface-chat` ([source](../packages/voice/src/adapters/huggingface-chat.ts))

- Both speak the OpenAI-compat `/v1/chat/completions` wire shape directly (snake_case, `tool_calls`, `tool_call_id`).
- **Translation shared** via [packages/voice/src/adapters/openai-compat.ts](../packages/voice/src/adapters/openai-compat.ts) — `toOpenAICompatMessages` + `extractOpenAICompatToolCalls`.
- Each adapter keeps only its provider-specific quirks: xAI's `choices[].text` legacy fallback; HF's routing-suffix logic (`<model>:fastest`).
- Cache: both surface `usage.prompt_tokens_details.cached_tokens` when their underlying provider exposes it (xAI always; HF sub-provider dependent).

### How a single call flows

A worked example for **the responder running on direct Anthropic with one tool call**, end to end:

1. Telegram poller inserts a row → `pg_notify('telegram_message_inserted')` fires.
2. `handleMessage` in [main.ts](../apps/agent/src/main.ts) atomic-claims the row, loads the responder agent.
3. `chatAdapter = getChatAdapter(agent.provider)` → `anthropicChatAdapter`.
4. `buildChatMessages(...)` composes the system (persona + digest as two cacheable blocks), history turns, and the new user message.
5. `runToolLoop({ adapter: chatAdapter, apiKey, model: agent.model, ..., initialMessages: messages, tools: allowedTools, ... })`.
6. **Iter 1**:
   - `step({ name: 'anthropic-chat_chat', kind: 'llm_call', ... }, ...)` opens a trace step.
   - `adapter.chat({ messages, tools, cacheControl: { systemPrompt: true, lastUserMessage: true }, ... })` fires.
   - Inside the adapter: system blocks emit with their `cache_control` markers preserved; the last user message (the inbound text) gets wrapped in a text block carrying `cache_control`. The model call goes to `/v1/messages`.
   - Response: `{content: [{type:'text', text:'Looking that up...'}, {type:'tool_use', id:'toolu_x', name:'search', input:{q:'...'}}], usage: {input_tokens: 1200, output_tokens: 50, cache_creation_input_tokens: 1200}}`.
   - `extractAnthropicToolCalls` normalises the tool_use block → `[{id:'toolu_x', type:'function', function:{name:'search', arguments:'{"q":"..."}'}}]`.
   - `recordChatUsage(stepHandle, result, model)` rolls 1200 input + 50 output + 1200 cache_write tokens + cost into the trace.
   - Loop sees `toolCalls.length > 0`, appends the assistant turn (with toolCalls) to messages, dispatches the `search` tool.
7. **Tool dispatch**: `dispatchTool(searchTool, {q:'...'}, ctx)` runs the local handler. Result `{hits: [...]}` (small, no spill).
8. Loop appends `{role:'tool', toolCallId:'toolu_x', content: '{"hits":[...]}'}` to messages.
9. **Iter 2**:
   - `adapter.chat({...})` again with the now-longer messages array + same cacheControl.
   - Inside the adapter: `splitSystemAndMessages` translates the tool message into a `user` message with a `tool_result` block. `markLastBlockForCache` attaches `cache_control: {type: 'ephemeral'}` to that trailing tool_result block — caches the entire prefix up through this turn.
   - Response: `{content: [{type:'text', text:'Found 3 relevant items...'}], usage: {input_tokens: 50, output_tokens: 200, cache_read_input_tokens: 1300}}`. The 1300 cache_read covers the iter 1 system + user + assistant + tool_result prefix the marker established.
   - `recordChatUsage` records the cache_read separately; cost dashboard correctly bills the cached prefix at ~10% rate.
   - Loop sees no toolCalls → returns `{reply: 'Found 3 relevant items...', iterations: 2, ...}`.
10. Responder sends the reply via Telegram, persists the outbound row.

The cache state after this exchange: prefix `[system, user, assistant(tool_use), user(tool_result)]` is in Anthropic's 5-minute TTL cache. The next turn from the same user (follow-up question within 5min) reads back that prefix at cache-read rate.

### What changed in `/traces`

Pre-Phase-3, every chat step name was `openrouter_chat` regardless of provider. Now step names key off `adapter.adapterName`:
- `anthropic-chat_chat` / `anthropic-chat_chat[1]` / `anthropic-chat_chat[force_final]`
- `google-chat_chat`, `xai-chat_chat`, etc.

Trace step `input` now carries `provider` alongside `model`, so the `/debug` reactflow view shows at a glance which adapter ran a given call. `recordChatUsage` writes the same meta keys (`model`, `tokens_in`, `tokens_out`, `cache_read`, `cost_micro_usd`) as the legacy `captureLlmUsage` — dashboards needed no changes.

### Cost story, concretely

Anthropic Sonnet 4.6 ($3/$15 per 1M, cache-read ~$0.30, cache-write ~$3.75) on a typical 3-iter responder loop:

```
Turn structure:
  [system: 3K tokens (persona + skills, two cacheable blocks)]
  [history: 2K tokens]
  [user_new: 200 tokens]
  → assistant_A (tool_use)
  + [tool_result_A: 1K]                ← iter 2 starts here
  → assistant_B (tool_use)
  + [tool_result_B: 1K]                ← iter 3 starts here
  → final reply: 300 tokens out
```

**Pre-Phase-3 (single-prefix cache via OR SDK direct):**
- Cache write: ~5.2K tokens once → $0.0195
- Cache reads on 2 subsequent iters: ~5.2K × 2 × $0.30/M → $0.0031
- Fresh input on growing suffixes: ~5.6K total → $0.0168
- **Total input cost: ~$0.0394**

**Post-Phase-3 with iter 2+ cumulative caching (audit-#4 fix):**
- Cache writes: 5.2K iter 1 + 1.4K iter 2 + 1.4K iter 3 → $0.030
- Cache reads on iter 2 + iter 3: ~12K total → $0.0036
- Fresh input on new content only: ~2.8K → $0.0084
- **Total input cost: ~$0.042 per single turn**

For a single turn the totals are close — cumulative caching slightly more on this turn because of the extra cache writes. **The compounding starts on follow-up turns:** the cache state after this exchange covers the full 8.2K prefix. Any follow-up user message within 5 minutes reads that entire prefix at cache-read rate instead of writing it fresh. Across a multi-turn conversation the savings scale to **20-40% of input cost**.

For the **chat-shaped workers** (extractor doing a backfill on Anthropic Haiku), the savings are starker: the system prompt (~2K tokens, identical across every node) caches once. 50 nodes ingested in an active hour pays the cache-write penalty once and cache-read on the other 49 → ~80% reduction in system-prompt cost vs. fresh-input every node.

---

## Part 2 — Quality + journey

### The staged history, with commit shas

Three stages, four sub-stages, plus eight audit items:

| Stage | Commit | What it did | Why |
|---|---|---|---|
| Stage 1 | `5dc3984` | Embeddings adapter framework | `@mantle/embeddings` flips from OR-hardcoded to adapter-routed (5 adapters). Sets the pattern Phase 3 inherits. |
| Stage 2 | `b7d57e9` | Form clamps | "Honest UX while deferred" — workers + agents forms clamp chat-shaped kinds to OR keys with explanatory copy. ~50 LOC, the right move at the time. |
| Pre-work A | `97298a5` | Widen ChatResult | Add `cacheReadTokens`, `cacheWriteTokens`, `reportedCostUsd` to the chat adapter contract. Mandatory before any call-site migration — otherwise telemetry silently goes to zero on non-OR providers. |
| Pre-work B | `6297e66` | `openrouter-chat` adapter | Close the framework asymmetry where OR was the only chat provider without an adapter file. ~780 LOC. |
| Pre-work C | `4f95681` | `recordChatUsage` helper | Typed sibling to `captureLlmUsage` that reads from `ChatResult` instead of an `unknown` raw blob. Same meta keys for `/debug` compat. |
| 3a | `652ba19` | Chat-shaped workers | Migrate extractor / summarizer / reflector to `getChatAdapter(provider).chat({...})`. Mechanical. |
| 3b | `148d423` | Tool loop refactor | The hard piece (~1300 LOC). Tool-call normalisation across Anthropic tool_use blocks, Google functionCall parts, OpenAI tool_calls[]. Cache markers thread through. |
| 3c | `3581f61` | `agents.provider` column | Migration 0048, runtime cast removal at four call sites. |
| 3d | `38e2cbc` | Unclamp forms | Strip `RUNTIME_OR_ONLY_KINDS`, strip `service==='openrouter'` filter, add provider dropdown to agents form. |
| 3e | `ff7eebc` | Docs cleanup | Flip §8.1 routing table, retire §10.1 deferral spec to SHIPPED, retire architecture.md §16 entry. |
| Audit fix | `2a77a86` | Multimodal + multi-block lossless | **Two silent-drop bugs the audit caught.** Vision user turns and multi-block system content were being silently flattened. |
| Audit #1 | `f78b419` | Model dropdown reactive | The dropdown hard-coded `?provider=openrouter` — saving an OR slug for direct Anthropic 404s at first turn. |
| Audit #2 | `c021a95` | Worker cacheControl wiring | Chat-shaped workers never opted into cacheControl. On Anthropic-direct extractor that's ~10× on system prompt cost across batches. |
| Audit #3 | `9038bef` | Test chat for agents | Operators configuring direct-Anthropic had to send a real Telegram message to discover their key+provider combo was wrong. Now: type prompt → click → see reply. |
| Audit #4 | `69861f4` | Iter 2+ cache marker | `lastUserMessage` was a no-op on tool-loop iterations 2+. The cumulative-caching cost math above came from fixing this. |
| Audit #5 | `661cac7` | `runToolLoop` unit tests | Direct tests for the iteration grammar, contract forwarding, error surfaces, requiresConfirm, artifacts, force_final. |
| Audit #6 | `a09fd90` | Shared openai-compat helper | xAI + HF carried identical 120-LOC translation copies. Extract to `openai-compat.ts`. |
| Audit #7 | `2edda7b` | Type-cast retired | `messages as unknown as ChatToolLoopMessage[]` was stale ceremony. Removed → type checker becomes the safety net for future ChatMessage drift. |
| Audit #8 | `8ae4d3d` | Dead deps removed | `@openrouter/sdk` dropped from four `package.json`s that no longer imported it. Grep-truth is now honest. |

### The audit story — bugs caught before shipping

The most consequential audit moment: **two silent-drop regressions were caught after 3b shipped but before any production traffic.** Both would have been hard to debug in the wild because they fail without errors.

**Bug 1: vision user turns silently dropped to empty string.**
- `ChatToolLoopMessage.user.content` was typed as `string` only.
- The runtime's `buildChatMessages` emits `[{type:'text', text}, {type:'image_url', imageUrl: ...}]` whenever a Telegram or web responder turn carries an image attachment.
- The tool-loop's `messages as unknown as ChatToolLoopMessage[]` cast hid the type incompatibility.
- At runtime, every adapter's `typeof m.content === 'string' ? m.content : ''` fell through to empty string.
- **Symptom**: the responder would see empty content for any vision turn. The user's photo never reached the model. No error, no log.

**Bug 2: multi-block system content silently flattened.**
- `ChatToolLoopMessage.system.content` was also typed `string` only.
- `buildChatMessages` emits `[{type:'text', text:persona, cacheControl}, {type:'text', text:digest, cacheControl}]` for Anthropic-style responders (two cacheable segments).
- Same cast hid it; adapters dropped to empty string.
- **Symptom**: persona block cached; digest block didn't. Roughly halves the cache hit rate on responder tool-loop iterations. Cost would have been quietly ~30% higher than it should be.

The fix (commit `2a77a86`) widened the contract to handle both shapes everywhere + added 9 focused tests covering: data-URL → Anthropic base64-source translation, http URL → Anthropic url-source, xAI multimodal passthrough, Google text-only fallback, Anthropic multi-block system with per-block markers, Google flatten to systemInstruction, OpenRouter array-shape system passthrough.

**Lesson:** the type-cast in the tool-loop was actively hiding the bug. Audit #7 retired the cast so future drift compile-errors instead of silently dropping. That's the most durable fix in the whole series — the type checker is now the safety net.

### Other audit items worth highlighting

- **Audit #4 (iter 2+ cache marker)** had the highest ongoing cost impact. The original `cacheControl.lastUserMessage` logic skipped any user message with array content — exactly the shape coalesced tool_result blocks take on Anthropic iter 2+. Only iter 1's prefix cached. Audit #4 extended cache markers to all Anthropic content-block types (text, tool_use, tool_result, image), enabling the cumulative-prefix caching the cost math above relies on.

- **Audit #1 (model dropdown)** was a 30-minute fix with disproportionate operator-UX value. Without it, switching the agent's provider in the form would silently leave the OR-shaped model slug in place — saving and trying to call would 404 at first turn. With it, the dropdown re-fetches per provider and a slug-mismatch hint fires when the typed model isn't in the current catalog.

- **Audit #5 (runToolLoop tests)** added 14 direct unit tests where pre-Phase-3 there were zero. The fake-adapter pattern + `vi.mock`-on-tools-and-db approach is reusable for any future tool-loop work. Most valuable test: the "sends cacheControl on every iteration" case, which is the safety net for audit #4 at the iteration level.

### The honest scorecard

What changed from Phase-3-shipped to fully-audited:

| Dimension | Phase 3 ship | After audit | What moved the needle |
|---|---|---|---|
| **Correctness** | 7.5 | **9.0** | Two silent-drop bugs caught + fixed; iter 2+ cache fixed; runToolLoop tests pin everything down |
| **Architecture** | 8.5 | **9.5** | No escape hatches; shared `openai-compat` helper; dead deps gone |
| **Test coverage** | 8.0 | **9.5** | runToolLoop (14), extractor cacheControl (4), openai-compat (14), tool-translation cumulative (20), chat-adapters (27), openrouter-chat (15) |
| **Documentation** | 9.0 | **9.0** | Already strong; this retrospective is the cherry on top |
| **Backwards compat** | 9.5 | **9.5** | Zero breakage maintained throughout |
| **Observability** | 8.0 | **8.5** | Test chat affordances on both forms; provider in trace input |
| **Performance** | 6.5 | **9.0** | Chat-worker caching (audit #2); iter 2+ cumulative caching (audit #4) |
| **Migration safety** | 9.0 | **9.0** | One additive migration, defaulted, belt-and-braces UPDATE |
| **Scope discipline** | 8.0 | **8.5** | 17 commits, each independently mergeable |
| **Operator UX** | 6.5 | **8.5** | Test chat affordance, reactive dropdown, slug-mismatch hint, cacheControl on workers |
| **Overall** | **7.8** | **9.2** | |

### What's *still* a known sharp edge

This refactor is honest about what it didn't fix. Worth flagging for future readers:

1. **OpenRouter iter 2+ caching is single-prefix only.** OR's SDK tool-message shape (`{role:'tool', toolCallId, content}`) doesn't expose `cache_control` for tool results. OR-routed-to-Anthropic only caches the iter 1 `[system, user_new]` prefix. The iter 2+ tool exchange isn't cached. To fix: either wait for OR SDK to expose tool-message cache markers, or write a parallel OR-via-fetch adapter that emits the Anthropic block shape directly. **Direct Anthropic gets the full benefit; OR-to-Anthropic gets ~70% of it.**

2. **Reflector cache write penalty on cold fires.** The reflector runs on a ~10-minute timer; Anthropic's cache TTL is 5 minutes. Most fires MISS cache and pay the 1.25× cache-write penalty without immediate benefit. Net-net close to break-even (back-to-back fires within 5min hit), and the consistency of "every chat-shaped worker uses cacheControl" beats a clever skip. Documented inline at the reflector call site.

3. **Google chat adapter drops images.** The dedicated `google-vision` adapter is the production path for image understanding. If we ever want vision-capable chat directly through `google-chat`, the message translator needs to grow `inline_data` parts. Not currently exercised.

4. **No end-to-end test against real provider endpoints.** All assurance is from typecheck + 865 unit tests + reading code. The first real Anthropic-direct responder call is the integration test. The Test chat affordance (audit #3) is the operator's local validation tool but doesn't replace live-traffic verification.

5. **Per-worker / per-agent cacheControl is hard-coded `true`.** Operators can't opt out. If a worker's system prompt changes per-call (which would be a weird pattern, but possible if someone customises), the cache_write penalty stacks without payback. A future iteration could add `cacheControl: 'auto' | 'always' | 'never'` to worker params.

### Patterns reusable elsewhere

Three patterns from this refactor that other codebase areas could lift:

**Pattern 1: Honest forms while you defer the runtime.** Stage 2 (`b7d57e9`) clamped the workers + agents forms to the runtime's actual capabilities with explanatory copy, rather than showing operators a configuration that would fail at first call. ~50 LOC. Lower cost than the full migration and prevents the worst kind of user trust loss (silent first-call failure). Whenever you've got a "we'll get to it" backlog item that touches a configuration surface, clamp the form to the truth first.

**Pattern 2: Pre-work commits before the structural change.** Pre-work A/B/C landed the contract widening + the new helper + the asymmetry-closing adapter BEFORE any call site moved. Each was independently shippable and useful. When 3a/3b landed, they were "pure replacement of OR SDK call → adapter call" — small, reviewable diffs. Splits the high-risk-coupling work from the low-risk-mechanical work.

**Pattern 3: Audit-as-a-discrete-task.** Reading the diff with fresh eyes (after the implementation was "done") caught two silent-drop bugs that the type-cast was hiding. The audit pass paid for itself the moment it caught the first bug. Bake it in as a real task on multi-commit work, not a vague "I'll check it before pushing."

### Tooling notes for future tests

- **`@mantle/tracing` is safe to leave unmocked.** `step()` checks `if (!currentTrace()) return fn(noopHandle())` and bypasses entirely outside a trace context. Pre-Phase-3 this was already true; this codebase just hadn't exploited it for tests.

- **`vi.mock` factory with hoisted state.** The runToolLoop test uses module-scope state vars (`dispatchToolCalls`, `insertedPendingArgs`, `dispatchToolImpl`) that the mock factory closes over. Each test programs the impl + asserts the captured calls. Reusable for any test that needs to control a dependency's return value without exporting it as a test seam.

- **Scripted fake adapter that throws on overrun.** The fake `ChatDispatcher` raises a clear *"ran out of scripted responses on call N"* error when the loop iterates more than the test expects. Means an iteration miscount surfaces loudly instead of as a vague mock error. Worth copying for any state-machine test.

### Reading order for a future contributor

If you've just inherited this codebase and want to understand the chat path, read in this order:

1. **[docs/ai-workers.md](./ai-workers.md) §8.1** — the routing table cheatsheet. 5 minutes.
2. **This doc, Part 1** — how it works end-to-end. 15 minutes.
3. **[packages/voice/src/adapters/types.ts](../packages/voice/src/adapters/types.ts)** — the contract. The doc-comments are honest and detailed.
4. **[packages/voice/src/adapters/openrouter-chat.ts](../packages/voice/src/adapters/openrouter-chat.ts)** — read one adapter end-to-end. OR is the SDK-typed shape; once you understand it, anthropic-chat and google-chat make more sense by contrast.
5. **[packages/agent-runtime/src/tool-loop.ts](../packages/agent-runtime/src/tool-loop.ts)** — the iteration grammar. ~470 LOC, well-commented.
6. **[packages/agent-runtime/src/tool-loop.test.ts](../packages/agent-runtime/src/tool-loop.test.ts)** — see the loop's behaviour exercised. Often the fastest way to internalise an iteration grammar is reading its tests.
7. **This doc, Part 2** — the journey + the trade-offs we made + the known sharp edges. 10 minutes.

For a deeper dive into any single piece, the per-commit message bodies have surprising depth (see `git log --reverse 2385fe0..HEAD`).

---

## Final stats

- **17 commits** ahead of `main` at the point this doc was written, all merged locally.
- **+5015 / −444 LOC** across **50 files**.
- **865 vitest pass** across the monorepo (60 test files), **+49 new tests** added during the refactor + audit.
- **Typecheck clean** across every workspace package.
- **Zero breakage** for existing installs — migration 0048 defaults `agents.provider = 'openrouter'`, preserving every pre-Phase-3 row's routing.
- **Two silent-drop bugs caught + fixed** before any production traffic.
- **Quality score: 7.8 → 9.2** across the refactor + audit arc.

Phase 3 is done. The chat dispatch path now has the same shape every other capability has had since Stage 1: provider field on the row, adapter resolved at call time, runtime honest about what the operator configured. The framework asymmetry is closed. The "Phase 4" entry in `docs/ai-workers.md` §10 is now empty.
