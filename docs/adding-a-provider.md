# Adding a new model provider

Cookbook for adding a new provider (or a new capability to an existing one) to Mantle's adapter framework. Written for AI agents — every step is "edit this exact file" with a copy-from-this-existing-adapter pointer.

For the conceptual deep-dive on how dispatch works, read [`docs/phase-3-retrospective.md` Part 1](./phase-3-retrospective.md) first (15 minutes — it'll save you from grepping). For the per-capability routing table, [`docs/ai-workers.md` §8.1](./ai-workers.md#81-provider-routing-today--what-goes-through-what).

---

## The five steps

In order. Skipping or reordering causes silent runtime mismatches.

1. **Catalogue the provider** in [`packages/voice/src/providers.ts`](../packages/voice/src/providers.ts) — adds it to dropdowns.
2. **Write the static model catalogue** in `packages/voice/src/catalogs/<provider>.ts` — what the UI shows before live discovery completes.
3. **Write the adapter** in `packages/voice/src/adapters/<provider>-<capability>.ts` — the runtime translator.
4. **Register the adapter** in [`packages/voice/src/adapters/index.ts`](../packages/voice/src/adapters/index.ts) — one line.
5. **Add wire-shape tests** in `packages/voice/src/adapters/<provider>-<capability>.test.ts` — lock down what the adapter actually sends.

After all five, run `pnpm --filter @mantle/voice exec tsc --noEmit` + `pnpm exec vitest run packages/voice` from the repo root. Both must pass cleanly before commit.

---

## Step 1 — Catalogue the provider

[`packages/voice/src/providers.ts`](../packages/voice/src/providers.ts). Two places to edit:

```ts
// 1. Add to the ProviderId union:
export type ProviderId =
  | 'openrouter'
  | 'openai'
  | ...
  | '<new-provider>';   // ← NEW

// 2. Add an entry to SUPPORTED_PROVIDERS:
{
  id: '<new-provider>',
  label: '<Display Name>',
  description: 'One sentence — what they do, why pick them over OR.',
  capabilities: ['chat', 'embedding'],  // only the ones you'll ship adapters for
  signupUrl: 'https://...console.../api-keys',
  docsUrl: 'https://docs....',
  isAggregator: false,    // true for OR-like proxies
}
```

**Critical rule**: only list capabilities you'll actually ship an adapter for in this PR. A catalogued capability with no adapter shows as "not yet wired" in the UI and is a known sharp edge ([catalog-consistency.test.ts](../packages/voice/src/adapters/catalog-consistency.test.ts) checks the reverse — adapter without catalog — but the forward direction is intentional). If you list `chat` but skip the adapter, the form lets operators pick the provider, save the worker, and discover at first call that it doesn't work.

---

## Step 2 — Write the static model catalogue

`packages/voice/src/catalogs/<provider>.ts`. This is what the UI's model dropdown shows BEFORE live discovery returns. Copy from an existing catalogue that's roughly the right shape:

- **For chat**: copy from [`anthropic.ts`](../packages/voice/src/catalogs/anthropic.ts) (small focused list) or [`openrouter.ts`](../packages/voice/src/catalogs/openrouter.ts) (broader curated headline list).
- **For TTS**: copy from [`google.ts`](../packages/voice/src/catalogs/google.ts) which has the voice + audio-tag shape too.
- **For STT**: copy from [`deepgram.ts`](../packages/voice/src/catalogs/deepgram.ts).
- **For vision / image-gen**: copy from [`openai-vision.ts`](../packages/voice/src/catalogs/openai-vision.ts) / [`openai-image.ts`](../packages/voice/src/catalogs/openai-image.ts).

Shape per chat model:

```ts
{
  id: 'bare-model-id',  // what the provider's API accepts (NOT the OR-style 'provider/model' slug)
  label: 'Display Name',
  description: 'Short hint — context window, strengths, when to pick this.',
  contextTokens: 200_000,
  capabilities: ['reasoning', 'function_calling', 'vision'],
  // Pricing OPTIONAL. The /models page explorer is the canonical pricing surface.
  // If you include it, keep it in lock-step with packages/tracing/src/pricing.ts.
  inputPricePer1M: 3,
  outputPricePer1M: 15,
}
```

Also export the API base URL + any auth-header conventions (`<PROVIDER>_BASE_URL`, `<PROVIDER>_API_VERSION` if applicable) — the adapter imports these from the catalogue file so the URL lives in one place.

---

## Step 3 — Write the adapter

**This is the big decision.** Pick the right starting template based on what the provider's wire shape looks like:

### Decision tree

```
Does the provider speak the OpenAI-compatible /v1/chat/completions wire shape?
  (snake_case, tool_calls array, tool_call_id, image_url with snake_case)

├── Yes → copy from xai-chat.ts or huggingface-chat.ts
│         You get ~80% of the work for free via openai-compat.ts:
│           - toOpenAICompatMessages() translates ChatToolLoopMessage[]
│           - extractOpenAICompatToolCalls() normalises tool calls
│         Your adapter handles: HTTP call + auth + provider quirks.
│
├── Native shape (Anthropic /v1/messages, Google generateContent, etc.)
│       → copy from anthropic-chat.ts or google-chat.ts
│         Substantial translation work — see the per-shape notes below.
│
└── SDK-based (you'd use an official SDK rather than raw fetch)
        → copy from openrouter-chat.ts
          The SDK handles most encoding; your adapter handles ChatToolLoopMessage
          → SDK-typed-input translation.
```

### Per-capability minimum surface

Whichever capability you're shipping, the adapter file MUST export a `Dispatcher` object matching the interface in [`packages/voice/src/adapters/types.ts`](../packages/voice/src/adapters/types.ts):

| Capability | Interface | Required method | Reference adapter |
|---|---|---|---|
| Chat | `ChatDispatcher` | `chat(opts) → ChatResult` | `openrouter-chat.ts` (SDK), `anthropic-chat.ts` (native), `xai-chat.ts` (OAI-compat) |
| Embedding | `EmbeddingDispatcher` | `embed(req) → EmbedResult` | `openai-embedding.ts` |
| TTS | `TtsDispatcher` | `synthesize(opts) → SynthesizeResult` | `openai-tts.ts` (basic), `elevenlabs-tts.ts` (live voice fetch) |
| STT | `SttDispatcher` | `transcribe(audio, opts) → TranscribeResult` | `openai-stt.ts`, `deepgram-stt.ts` |
| Vision | `VisionDispatcher` | `extract(opts) → VisionExtractResult` | `openai-vision.ts`, `anthropic-vision.ts` |
| Image-gen | `ImageGenDispatcher` | `generate(opts) → GenerateImageResult` | `openai-image.ts`, `xai-image.ts` |

Every dispatcher also carries `providerId` + `adapterName` (the `<provider>-<capability>` convention for logs/traces) and SHOULD implement `discoverModels(apiKey)` + `staticCatalog()` so the UI's model dropdown lights up.

### Chat-specific: the four required translations

If you're adding a CHAT adapter, your `chat()` function must handle all four message-grammar shapes the runtime sends:

1. **`system` content**: string OR `Array<{type:'text', text, cacheControl?}>`. Multi-block form is for Anthropic-style cache breakpoints. If your provider doesn't support per-block cache markers, flatten with `'\n\n'.join` — see [`openai-compat.ts`'s `toOpenAICompatMessages`](../packages/voice/src/adapters/openai-compat.ts) for the pattern.

2. **`user` content**: string OR `Array<{type:'text', text} | {type:'image_url', imageUrl: {url, detail?}}>`. Multimodal arrays come from vision-capable responder turns. Translate `image_url`/`imageUrl` to whatever your provider expects (Anthropic uses `image` blocks with `source: {type:'base64'|'url', ...}`; Google uses `inline_data` parts; OpenAI-compat uses `image_url` snake_case).

3. **`assistant.toolCalls`**: re-send the model's prior tool-call requests so subsequent iterations see them paired with the tool_result. Each provider serialises tool calls differently — Anthropic emits `tool_use` blocks inside `content[]`, Google emits `functionCall` on `parts[]`, OpenAI emits `tool_calls` array. Refer to the canonical adapter for your shape.

4. **`role: 'tool'` messages**: tool results from the runtime. Anthropic models these as USER messages with `tool_result` blocks (coalesce consecutive tool messages into one user message). Google models them as user messages with `functionResponse` parts. OpenAI-compat keeps the dedicated `tool` role with `tool_call_id`.

If you skip any of these four, ONE of: (a) the runtime sends an unsupported shape and the provider 400s with a cryptic error, OR (b) the field gets silently dropped and you get a hard-to-debug behaviour bug. Both bug classes were caught in the [Phase 3 audit](./phase-3-retrospective.md#the-audit-story--bugs-caught-before-shipping).

### Chat-specific: cache markers

`ChatOptions.cacheControl` carries `{ systemPrompt?: boolean, lastUserMessage?: boolean }`. If your provider supports prompt caching, honour both. If it doesn't, ignore the field — provider-neutral by design. Anthropic is the deep example: see `markLastBlockForCache` in [`anthropic-chat.ts`](../packages/voice/src/adapters/anthropic-chat.ts) for how to attach `cache_control: {type:'ephemeral'}` to whatever block type sits at the tail of the last user message.

### Chat-specific: usage + cost

Every chat adapter MUST populate `tokensIn` + `tokensOut` on `ChatResult` when the provider returns them. Optionally populate:
- `cacheReadTokens` — billed at the reduced cache-read rate. Anthropic: `usage.cache_read_input_tokens`. OpenAI/xAI/HF: `usage.prompt_tokens_details.cached_tokens`. Google: `usageMetadata.cachedContentTokenCount`.
- `cacheWriteTokens` — only Anthropic distinguishes this (`usage.cache_creation_input_tokens`, billed ~1.25× input).
- `reportedCostUsd` — only OR has this (`usage.cost`, includes vendor surcharges).

Direct providers leave `reportedCostUsd` undefined; the trace's `recordChatUsage` helper falls back to the static price table in `packages/tracing/src/pricing.ts`. The fallback path is fine — pricing accuracy is "best effort" outside OR.

---

## Step 4 — Register the adapter

[`packages/voice/src/adapters/index.ts`](../packages/voice/src/adapters/index.ts). Two edits:

```ts
// 1. Import your new adapter:
import { newProviderChatAdapter } from './newprovider-chat';

// 2. Register it (one line, near the other registerChatAdapter calls):
registerChatAdapter(newProviderChatAdapter);

// 3. Re-export it for tests + any direct consumers:
export { newProviderChatAdapter } from './newprovider-chat';

// 4. Re-export your catalogue from `../catalogs/newprovider`:
export {
  NEWPROVIDER_CHAT_MODELS,
  NEWPROVIDER_BASE_URL,
} from '../catalogs/newprovider';
```

After save: the `findAdapterCatalogDrift` check at the bottom of the same file fires on next import. If your catalogue entry in `providers.ts` (step 1) doesn't list the right capability, you'll get a warning at module load + a CI test failure in [`catalog-consistency.test.ts`](../packages/voice/src/adapters/catalog-consistency.test.ts).

---

## Step 5 — Tests

Two test files, both in `packages/voice/src/adapters/`:

### Wire-shape lock-down

`<provider>-<capability>.test.ts`. Mock `fetch` (or the SDK) and assert the wire body / outbound URL is exactly what the provider expects.

Copy from [`openrouter-chat.test.ts`](../packages/voice/src/adapters/openrouter-chat.test.ts) (vi.mock pattern for the SDK) or [`tool-translation.test.ts`](../packages/voice/src/adapters/tool-translation.test.ts) (`captureFetch` helper for native-shape providers).

For a CHAT adapter, the minimum tests:
- Tools array is forwarded in the provider's native shape
- `assistant.toolCalls` round-trips back to the wire shape (e.g. assistant message with `tool_use` blocks on Anthropic)
- Tool result messages translate correctly (assistant + paired tool result blocks)
- `cacheControl: { systemPrompt: true }` produces the right wire shape
- `cacheControl: { lastUserMessage: true }` marks the trailing block (including tool_result blocks for the iter-2+ tool-loop case)
- Multimodal user content (text + image_url) translates without dropping the image
- Usage round-trip: every `ChatResult.*` field maps from the provider's usage shape

### Registration smoke

Add a case to [`chat-adapters.test.ts`](../packages/voice/src/adapters/chat-adapters.test.ts) (or the equivalent for your capability):

```ts
it('registers <provider>-chat on import', () => {
  const a = getChatAdapter('<provider>');
  expect(a).not.toBeNull();
  expect(a?.adapterName).toBe('<provider>-chat');
  expect(a).toBe(newProviderChatAdapter);
});
```

---

## Optional: extras worth knowing about

These are NOT required to ship a working provider — they're polish that improves the operator experience.

### Pricing table

[`packages/tracing/src/pricing.ts`](../packages/tracing/src/pricing.ts). The fallback cost calculation when `reportedCostUsd` is undefined. Add an entry per model:

```ts
'<your-provider-or-slug>/<model>': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003 },
```

Without this, `recordChatUsage` writes `cost_micro_usd: 0` for your provider — the trace still has token counts, but the cost dashboard won't reflect spend.

**Per the user's guidance, this is optional and best-effort.** The `/models` page explorer is the canonical pricing surface; static-table pricing is just a fallback for the trace. Don't go out of your way to keep it perfectly accurate.

### Model context limits

[`packages/tracing/src/model-context.ts`](../packages/tracing/src/model-context.ts). Drives the responder's context-window-percent bars. Same shape as pricing — add an entry per model:

```ts
'<your-provider-or-slug>/<model>': 200_000,
```

### Model-explorer parser

[`apps/web/lib/model-explorer.ts`](../apps/web/lib/model-explorer.ts). The `/models` page parses `/v1/models` from each provider. If your provider's response shape doesn't fit one of the existing parsers (`parseOpenAiLike`, `parseAnthropic`, `parseGoogle`, etc.), add a new one. Only matters if you want full-catalog browsing on `/models`; the worker form gets its catalog from `discoverModels` on the adapter directly.

### Voices (TTS-specific)

If you're adding a TTS provider, implement `voicesForModel(modelId, apiKey?)` on the dispatcher so the worker form's voice picker populates. ElevenLabs is the canonical example — live `/v1/voices` fetch that includes the user's cloned voices.

### Audio tags (TTS-specific)

If your TTS model honours inline tags (`[laughs]`, `[whispers]`, `<whisper>...</whisper>`), implement `supportedAudioTags(model)` and `supportedWrappingTags(model)`. The runtime composes these into Saskia's system prompt so she only emits tags your model renders. See [`packages/voice/src/catalogs/xai.ts`](../packages/voice/src/catalogs/xai.ts) `XAI_AUDIO_TAGS` for the convention.

---

## Verification checklist

After all the above, before commit:

- [ ] `pnpm --filter @mantle/voice exec tsc --noEmit` — clean
- [ ] `pnpm exec vitest run packages/voice` — all green
- [ ] `pnpm exec vitest run` from repo root — full monorepo, no regressions
- [ ] [`catalog-consistency.test.ts`](../packages/voice/src/adapters/catalog-consistency.test.ts) passes — your provider's capabilities array matches what adapters you registered
- [ ] The provider appears in `/settings/ai-workers` (or `/settings/agents`) dropdown after a dev-server restart
- [ ] The Test affordance ([chat-test-button.tsx](../apps/web/app/(app)/settings/ai-workers/chat-test-button.tsx), or the equivalent for TTS / vision / etc.) returns a reply when clicked with a real key for your provider

The last bullet is the **only verification you can't do at the unit-test level** — it requires a real API key + a dev server. Worth doing before claiming the work is finished.

---

## Common gotchas (learned from past providers)

1. **OpenAI-compat ≠ "everything works"**. Most providers claim OpenAI compatibility, but tool-call serialisation, image-content shape, and cache-marker support all vary. Test with tools + an image + cacheControl before declaring success.

2. **`discoverModels` MUST soft-fail to `staticCatalog`**. Network errors during a key-validation call can't blank the UI dropdown. Return `{ available: [...catalog], filtered: false, error: 'message' }` rather than throwing.

3. **Provider that doesn't expose tool calling**: leave `tools` field absent from the request body when `opts.tools` is empty or undefined. Some providers (looking at you, older Mistral models) reject an empty `tools: []` rather than ignoring it.

4. **Cache markers on providers that don't support them**: ignore `opts.cacheControl` silently. Don't try to emulate the marker by, e.g., reordering messages or stripping content. The runtime sets the flag every iteration — the assumption is "set + provider-decides".

5. **Don't add the SDK as a dep unless you use it**. Phase 3 ended with four packages carrying `@openrouter/sdk` in their `package.json` despite no imports. Audit found it. Adding a provider with an SDK? Only add the SDK to `packages/voice/package.json` (or wherever the adapter lives) — never to `apps/agent` / `apps/web` / `packages/agent-runtime` / `packages/heartbeats`. Those go through the adapter interface.

6. **Vision content is the audit-#1 silent-drop pattern**. The runtime's `buildChatMessages` emits multimodal user content `[{type:'text', text}, {type:'image_url', imageUrl: ...}]` whenever a Telegram/web responder turn carries an image. If your adapter's user-message translator does `typeof m.content === 'string' ? m.content : ''`, you'll silently drop the image. Always handle the array case explicitly — even for non-vision-capable providers, you should at minimum extract the text parts.

7. **Multi-block system content is the audit-#2 silent-drop pattern**. Same shape — `buildChatMessages` emits `[{type:'text', text:persona, cacheControl}, {type:'text', text:digest, cacheControl}]` for cache-aware responders. If your adapter flattens with `String(m.content)` you lose both blocks. Handle the array case via `'\n\n'.join` at minimum.

---

## When you're done

Add a one-line entry to [`docs/ai-workers.md` §3.3](./ai-workers.md#33-currently-shipped-adapters) (the per-provider capability matrix) so the routing table stays current. Then commit per the [worktree workflow](../CLAUDE.md) (or [the user's commit convention](../CLAUDE.md) if working in a non-worktree session).
