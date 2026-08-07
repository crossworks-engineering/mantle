# Models: live provider model-catalog explorer

> **Status: BUILT.** A read-only Review-group page (`/models`) that, for a chosen
> provider, hits that provider's public "list models" API and shows pricing,
> context window, type, and modality per model, plus the **verbatim raw JSON**
> the API returned. "As much information as the API returns."

Pick a provider from the dropdown; the page fetches its catalog server-side
(using your stored API key, resolved via `@mantle/api-keys`) and renders a
master-detail list. Search/sort/type-filter happen client-side over the fetched
list. OpenRouter needs no key (its catalog is public) and is the richest source.

## Why this exists

The app already fetched OpenRouter's `/api/v1/models` for context windows +
vision ([`packages/tracing/src/model-context.ts`](../packages/tracing/src/model-context.ts)),
but that only kept two fields. This surfaces the full picture for **every**
supported provider so you can compare pricing/context/capabilities in one place.

## Layers

| Concern | Where |
|---|---|
| Per-provider fetch + parse + cache | [`apps/web/lib/model-explorer.ts`](../apps/web/lib/model-explorer.ts) |
| API route (`GET /api/models?provider=&refresh=1`) | [`apps/web/app/api/models/route.ts`](../apps/web/app/api/models/route.ts) |
| Server page (`?provider=` → SSR fetch) | [`apps/web/app/(app)/models/page.tsx`](../apps/web/app/(app)/models/page.tsx) |
| Master-detail UI + raw-JSON pane | [`apps/web/app/(app)/models/models-client.tsx`](../apps/web/app/(app)/models/models-client.tsx) |
| Nav entry (Review group) | [`apps/web/components/layout/sidebar-nav.tsx`](../apps/web/components/layout/sidebar-nav.tsx) |
| Provider catalog (ids = `api_keys.service`) | [`packages/voice/src/providers.ts`](../packages/voice/src/providers.ts) |

## Per-provider coverage

Provider ids are the canonical `@mantle/voice` `SUPPORTED_PROVIDERS` ids, which
double as the `api_keys.service` strings, so the key lookup is a 1:1 match.
Each provider exposes a different amount through its list API; the normalised
columns are best-effort and the raw pane always shows everything.

| Provider | Endpoint | Key? | Rich fields returned |
|---|---|---|---|
| OpenRouter | `/api/v1/models` | none | id, name, description, context, prompt/completion + extra pricing, modality, created |
| Google (Gemini) | `/v1beta/models` | key | displayName, description, input/output token limits, methods → type |
| Mistral | `/v1/models` | key | id, description, max_context_length, vision capability |
| Cohere | `/v1/models` | key | name, context_length, endpoints → type |
| xAI | `/v1/language-models` | key | id, modalities, per-token prices (surfaced verbatim) |
| Anthropic | `/v1/models` | key | id, display_name, created_at |
| OpenAI | `/v1/models` | key | id, created (sparse, no pricing/context via API) |
| DeepSeek | `/models` | key | id (sparse) |
| Hugging Face | router `/v1/models` | key | id (sparse) |
| Deepgram / ElevenLabs / AssemblyAI |, |, | voice/transcription only → reported "no catalog" |

## Notes

- **Caching:** successful fetches are cached per provider for 5 minutes
  (process-global; single-user app). The header **Refresh** button busts it
  (`?refresh=1`).
- **Pricing units:** OpenRouter prices are USD/token → shown as USD per 1M
  (input/output); other priced dimensions (image, web_search, cache) surface
  verbatim under "Other pricing". xAI's integer prices are shown as-is to avoid
  a wrong unit conversion.
- **Security:** the route is owner-scoped (`requireOwner`); stored API keys are
  resolved server-side and never reach the client.
- Adding a provider with a list API is one entry in `FETCHERS` + a pure parser
  (unit-tested in [`apps/web/lib/model-explorer.test.ts`](../apps/web/lib/model-explorer.test.ts)).
