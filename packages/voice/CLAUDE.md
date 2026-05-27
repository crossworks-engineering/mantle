# packages/voice — adapter framework

**Before adding/modifying a provider or capability adapter, read [`docs/adding-a-provider.md`](../../docs/adding-a-provider.md).**
Five-step cookbook with per-capability templates, the OpenAI-compat-vs-native decision tree, and the audit-caught silent-drop patterns to avoid.

For the conceptual deep-dive: [`docs/phase-3-retrospective.md`](../../docs/phase-3-retrospective.md) Part 1.

Non-negotiables when touching this directory:

- **Provider catalogue + adapter registration must stay in sync.** [`catalog-consistency.test.ts`](src/adapters/catalog-consistency.test.ts)
  enforces "adapter registered → capability listed in providers.ts" at CI time. The reverse direction
  ("catalogue says X but no adapter") is intentional — it surfaces as "not yet wired" in the UI.
- **Adapter interfaces are stable contracts.** Don't widen `ChatOptions` / `ChatResult` / the dispatcher
  interfaces in [`src/adapters/types.ts`](src/adapters/types.ts) without considering every existing
  adapter — five chat adapters + four vision + four image-gen + many embedding/tts/stt. Each new
  optional field is fine; each new required field is a breaking change.
- **OpenAI-compat providers share translation.** xAI + HuggingFace both go through
  [`openai-compat.ts`](src/adapters/openai-compat.ts) (`toOpenAICompatMessages` +
  `extractOpenAICompatToolCalls`). Don't recreate per-adapter copies — that was the audit-#6 retirement.
- **Cache markers (`opts.cacheControl`) are provider-neutral.** Providers without prompt caching ignore
  the field; never throw or warn. Providers WITH caching must attach markers to the right wire-shape
  block (see [`anthropic-chat.ts`](src/adapters/anthropic-chat.ts) `markLastBlockForCache` for the
  reference — works for text, tool_use, tool_result, image alike).
- **Tests sit next to adapters.** Wire-shape lock-down in `<adapter>.test.ts`; registration smoke in
  [`chat-adapters.test.ts`](src/adapters/chat-adapters.test.ts) (or the per-capability equivalent).
  Use `captureFetch` (native fetch) or `vi.mock` (SDK-wrapped) — both patterns are in
  [`tool-translation.test.ts`](src/adapters/tool-translation.test.ts) /
  [`openrouter-chat.test.ts`](src/adapters/openrouter-chat.test.ts) respectively.
- **Workflow**: `pnpm --filter @mantle/voice exec tsc --noEmit` before commit; run
  `pnpm exec vitest run packages/voice` from repo root.

The two silent-drop bug classes you must avoid (caught in the Phase 3 audit):

1. **User content as array, not string** — vision turns carry `[{type:'text'}, {type:'image_url'}]`.
   `typeof m.content === 'string' ? m.content : ''` silently drops the image. Always handle the
   array case explicitly, even on non-vision providers (extract text parts at minimum).

2. **System content as array, not string** — Anthropic-style responders carry
   `[{type:'text', text:persona, cacheControl}, {type:'text', text:digest, cacheControl}]` for
   per-block cache breakpoints. `String(m.content)` flattens to `'[object Object],...'`. Use
   `m.content.map(p => p.text).join('\n\n')` if your provider doesn't support multi-block.
