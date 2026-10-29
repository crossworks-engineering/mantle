# Microsoft Foundry (Azure AI Foundry, Azure OpenAI)

Microsoft Foundry is a chat provider with the id `foundry`. It covers Azure
OpenAI deployments and the other Foundry models (DeepSeek, Grok, Llama,
Mistral and more) that the v1 chat completions API serves. It sits beside
OpenRouter in every place a chat provider goes: the provider catalogue, the
adapter registry, the key vault, primary and backup routes, the provider
HTTP pool, the retry and failover rules, the outage alerts, the model
catalog tool and the model pools.

Code: `packages/voice/src/adapters/foundry-chat.ts` (the adapter) and
`packages/voice-client/src/catalogs/foundry.ts` (the endpoint rules and the
static seed).

## What the API looks like (checked 2026-10-29)

Sources: the Microsoft Learn page "Azure OpenAI in Microsoft Foundry Models
v1 API", the "Manage Azure OpenAI quota" page, the REST reference, and the
v1 OpenAPI file in `Azure/azure-rest-api-specs`
(`specification/ai/data-plane/OpenAI.v1`).

**Endpoint.** One resource, two host forms. Both accept the same v1 path:

```text
https://<resource>.openai.azure.com/openai/v1/
https://<resource>.services.ai.azure.com/openai/v1/
```

The v1 API (GA since August 2025) needs no `api-version`. The query
parameter is optional and defaults to `v1`; `preview` opts in to preview
features. The older dated API is still served:

```text
POST <endpoint>/openai/deployments/<deployment>/chat/completions?api-version=2024-10-21
```

`2024-10-21` is the last GA date version. New work goes on v1.

**Auth.** Three schemes, from the OpenAPI file:

| Scheme | Header | Notes |
| --- | --- | --- |
| API key | `api-key: <key>` | The documented key header. Mantle sends this one. |
| API key as bearer | `Authorization: Bearer <key>` | What the stock OpenAI client sends on v1. Works, not used. |
| Entra ID | `Authorization: Bearer <token>` | Scope `https://ai.azure.com/.default` (older docs: `https://cognitiveservices.azure.com/.default`). The token lasts about an hour and needs a refresh flow. Not supported yet. |

**Deployments and model names.** The `model` field in a v1 request is the
DEPLOYMENT name the owner chose in the Foundry portal, not the base model
id. The portal suggests the model id as the deployment name, so they are
often the same, but nothing makes them so. The response `model` field
carries the base model id (for example a dated `gpt-4o-2024-08-06`).

**Request.** The OpenAI chat completions body: `messages`, `tools`,
`tool_choice`, `parallel_tool_calls`, `response_format` (`json_object` and
`json_schema`), `stream`, `stream_options.include_usage`, `temperature`,
`top_p`, `max_tokens`, `max_completion_tokens`, `reasoning_effort`, `seed`,
`stop`. OpenAI reasoning models (o-series, gpt-5) refuse `max_tokens` and
a non-default `temperature`; they want `max_completion_tokens`. No official
table says which parameters the non-OpenAI Foundry models accept, and field
reports show `max_tokens` working for them, so Mantle sends `max_tokens` by
default (see "Quirks" below).

**Response.** The OpenAI shape plus Azure filter fields:
`prompt_filter_results` (non-streaming) and `content_filter_results` per
choice. `finish_reason` is one of `stop`, `length`, `tool_calls`,
`content_filter`, `function_call`. Usage: `prompt_tokens`,
`completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`,
`completion_tokens_details.reasoning_tokens`. No cost field.

**Streaming.** Server-sent events, `data: {...}` chunks, ending in
`data: [DONE]`. The first chunk often has an EMPTY `choices` array and only
`prompt_filter_results`; a parser must skip it, not fail. Deltas carry
`content`, `tool_calls` (fragments joined by `index`), `refusal` and, for
some models, `reasoning_content`. Usage arrives in the last chunk when
`stream_options.include_usage` is true.

**Model list.** `GET <endpoint>/openai/v1/models` returns
`{object:"list", data:[{id, object:"model", created, owned_by}]}`. It lists
the BASE MODELS the resource can use, NOT the deployments. There is no data
plane call that lists deployments; that is a control plane (Azure Resource
Manager) call with an Entra token. So the catalog is a static seed plus any
deployment name the owner types.

**Rate limits.** Each deployment has a tokens per minute (TPM) and requests
per minute (RPM) limit. RPM is enforced over 1 or 10 second windows, so a
burst can 429 below the per minute figure. Headers on every answer:
`x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`,
`x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`,
`x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`. A 429 also
carries `retry-after-ms` (and usually `retry-after` in seconds). The 429
text says "exceeded token rate limit" or "exceeded call rate limit" for a
deployment limit, and "temporarily unable to process" or "high demand" for
service capacity. Both are transient.

**Errors.** The body is `{"error":{"code","message","param","type","inner_error"}}`.

| Status | Meaning | Mantle |
| --- | --- | --- |
| 400 `content_filter` | Prompt or answer blocked by the content filter. `inner_error.code` is `ResponsibleAIPolicyViolation`. | Request refused (the "refused" sentence). No retry, no failover. |
| 400 other | Bad request: a parameter the model does not take, too long. | No retry. One automatic resend for the known parameter swaps (see "Quirks"). |
| 401 | Wrong key, or the key of another resource or region. | Auth error. No retry, fail over, alert at once. |
| 403 | The key has no access, or a network rule blocks the caller. | Auth error, same as 401. |
| 404 `DeploymentNotFound` | No deployment of that name on this resource, or it is still being created. | Model error. TERMINAL: no retry, fail over, alert at once. |
| 408, 429, 5xx | Timeout, rate limit, service trouble. | Retried with backoff (2 retries, `retry-after-ms` honoured, capped at 30 s), then fail over. |

The exact 404 and 401 bodies were not seen live from this machine (no
resource). The handling keys on the status, not on the text.

## How Mantle uses it

**Where the endpoint comes from.** A chat route's Base URL, when set, else
`MANTLE_FOUNDRY_ENDPOINT`. Either form is accepted: the resource root
(`https://<resource>.openai.azure.com`), the `services.ai.azure.com` root,
or a URL that already ends in `/openai/v1`. The adapter builds the path.
Only `https` is accepted.

**Where the key comes from.** The key vault, as for OpenRouter: service
`foundry`, added at Settings > Keys (the agent and worker forms pick it
like any other key). The key goes in the `api-key` header only. It is never
logged and never put in error text. What a caller or the model hears for a
failed call is the status and a fixed sentence, never the provider body;
the body reaches only the server log, as for every provider. A bad endpoint
or API version is refused in fixed words that never repeat the value.
`MANTLE_FOUNDRY_API_KEY` is a
fallback for routes that have no vault key AND no Base URL of their own,
so the box-level key only ever goes to the box-level endpoint. Agents that
answer chat pick a vault key in their form, so give an agent a vault key.

**API version.** `MANTLE_FOUNDRY_API_VERSION` unset or `v1`: the v1 route,
no query. `preview`: the v1 route with `?api-version=preview`. A date
(`2024-10-21`, `2025-04-01-preview`): the old deployments route,
`/openai/deployments/<deployment>/chat/completions?api-version=<date>`,
for a resource that is not on v1 yet. Dates before `2024-09-01` are refused:
they reject `stream_options` (every stream sends it) and
`max_completion_tokens`. Anything else is refused at call time with a plain
message.

**Model ids.** A route's model is the deployment name. The adapter sends it
as given (v1) or puts it in the path (dated route, URL-encoded). The model
dropdown shows the static seed (common OpenAI and partner model ids, each
noted as "the deployment name, if you named it after the model") and takes
any typed name.

**Discovery and the key test.** With an endpoint set, the Test button and
the model list call `GET /openai/v1/models`: a 200 proves the key, and the
base model ids it returns are added to the seed as hints. Without an
endpoint, discovery returns the seed and a message asking for the endpoint.

**Cost.** Foundry answers with no cost. Prices vary by deployment type
(Global, Data Zone, Regional) and region, so Mantle does not guess: the
spend recorder uses the shared fallback price table, which prices a
deployment named after a known model id and records $0 otherwise.

**Thinking.** A positive thinking budget becomes `reasoning_effort`
(low, medium, high), as for the custom and Mammouth adapters.

**Quirks handled in the adapter.**

- Reasoning models refuse `max_tokens` and a set `temperature` or `top_p`;
  other models may refuse `reasoning_effort` or `max_completion_tokens`.
  With thinking on, the adapter sends `reasoning_effort`,
  `max_completion_tokens` and no sampling parameters. With thinking off, it
  sends `max_tokens`. A 400 that names a refused parameter gets a resend
  with that one fix, each kind at most once and three in all:
  `reasoning_effort` refused (no reasoning on that model) drops it and puts
  the budget back in `max_tokens`; `max_tokens` refused moves the budget to
  `max_completion_tokens` and adds `reasoning_effort: low`, so the model's
  default reasoning cannot eat the whole budget and leave empty text;
  `max_completion_tokens` refused moves it back; `temperature` or `top_p`
  refused drops both. When the `reasoning_effort` refused was our own `low`
  from the `max_tokens` move, only it is dropped and the budget stays in
  `max_completion_tokens`. Each kind is made once, so the fixes always end.
  Nothing
  has reached the user at that point (the 400 comes before the stream).
- Redirects are refused. The key rides the `api-key` header, which a
  redirect to another origin would carry along.
- A route flagged "via tailnet" goes through the Tailscale proxy, for a
  gateway in front of the resource that only the tailnet reaches.
- The agent Test chat and the Studio sandbox send the agent's own Base URL
  and tailnet flag under the same key pairing gate as a real turn (a
  refused `local` agent runs keyless there too). This fixes the test for
  `custom` and `local` agents as well, which never sent their Base URL.
- The empty first stream chunk is skipped by the shared streamer.

**Outages.** Foundry errors are the shared `ChatHttpError`, so the
classifier (`@mantle/std` provider-error), the retry wrapper, the backup
route and the `provider_alerts` circuit (migration 0230) treat it like any
other provider. No Foundry code lives in any of them.

## Not done
- A missing or invalid endpoint, or a bad API version, is a plain error: it
  does not fail over to the backup route and raises no provider alert. The
  message names the fix.
- The key test and the model list have no route, so they use
  `MANTLE_FOUNDRY_ENDPOINT`. A vault key meant for another resource (a
  route Base URL) reads as refused there; the chat itself works.
- After a parameter fix, a 429 retry starts again from the unfixed request,
  costing one extra 400 round trip.

- Entra ID (token) auth. Needs a token refresh flow per box.
- The Responses API. Mantle speaks chat completions to every provider.
- Embeddings through Foundry. The embedder is one brain-wide config
  (docs/embeddings.md); Foundry embeddings would need a deployment-name
  aware embedding adapter.
- Onboarding's Azure route still writes a `custom` route with the Azure
  base URL. It works; moving it to `foundry` is a follow-up.

## Manual smoke test (needs a real resource)

1. Set `MANTLE_FOUNDRY_ENDPOINT` to the resource root and, optionally,
   `MANTLE_FOUNDRY_API_KEY`. Leave `MANTLE_FOUNDRY_API_VERSION` unset.
   Restart the brain.
2. Settings > Keys: add a `Microsoft Foundry` key. Press Test. Expect
   "N models accessible".
3. Pick a chat deployment (for example one named `gpt-4o-mini`). Point a
   test agent at provider `foundry`, model = the deployment name, the new
   key. Send one chat turn. Expect a streamed answer and token counts in
   the trace.
4. Ask the agent something that needs a tool (for example "what time is
   it"). Expect one tool call and a final answer.
5. Force a 429: set the deployment to 1K TPM in the portal and send a long
   prompt twice fast. Expect `[chat-retry] foundry-chat ... HTTP 429, retry`
   in the log, then either an answer or a failover to the backup route.
6. Point the agent at a deployment name that does not exist. Expect one
   call (no retry), a "The provider does not offer this model" message,
   and a failover when a backup is set.
