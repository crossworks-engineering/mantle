# Provider HTTP: the pool, deadlines, retries and health

Every model-provider call (chat, embeddings, vision, image, speech, the
decisions judge, the OpenRouter SDK) goes through one fetch:
[`providerFetch`](../packages/voice/src/adapters/provider-fetch.ts). It is the
built-in fetch with a shared `undici` Agent as its `dispatcher`.

## Why it exists

Node 26.5 bundles undici 8.7. Its fetch negotiates HTTP/2 with a TLS provider.
On a warm HTTP/2 session it then sends non-idempotent requests (POST, PUT) one
at a time. Every provider call is a POST, so N parallel calls took N request
times. The limit hid for three reasons:

- GET requests are not affected (model lists, catalogs).
- Plain `http://` hosts are not affected (a local Ollama or LM Studio).
- A cold first batch is not affected: each request opens its own connection
  before the HTTP/2 session exists. Only the second batch onward goes serial.

The `undici` package (8.10) does not have the limit. Its Agent can be the
`dispatcher` of the built-in fetch, so Request and Response stay native.

## The pool

| Setting     | Value                                  | Why                                                                    |
| ----------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Agent       | one per process                        | one connection pool per origin inside it                               |
| Protocol    | HTTP/1.1 (`allowH2: false`)            | the well-tested path; parallel calls use parallel connections          |
| Connections | 32 per origin (`PROVIDER_CONNECTIONS`) | a ceiling, not a driver: callers still decide how many calls they send |
| Keep-alive  | 10 s idle                              | reuse TLS connections between bursts                                   |
| Deadlines   | per call, named (see below)            | every call has one; a stream's covers its headers only                 |

The tailnet route ([`tailnet.ts`](../packages/voice/src/adapters/tailnet.ts))
uses an undici `ProxyAgent` with the same options. A replaced global fetch (a
test stub) is used as is.

`undici` is loaded through `process.getBuiltinModule('node:module')
.createRequire`, never a bare `require`: the server runs as ESM, where
`require` does not exist. Vitest supplies a `require`, so a bare one passes
every unit test and still fails in the brain. Before this change the tailnet
proxy path had exactly that bug ("require is not defined" as soon as
`MANTLE_TAILNET_PROXY_URL` was set). A test now fails on any `require(` in the
voice adapters.

## Measured (2026-10-04, Node 26.5.0, Mac on a home line)

Warm connections, POSTs with a 4 kB body, median of 5 runs. The requests were
unauthenticated (HTTP 401 at the provider edge), so they cost nothing; the
transport path is the same as a real call.

| Origin                       | Fetch         | 1 request | 8 parallel | 32 parallel |
| ---------------------------- | ------------- | --------: | ---------: | ----------: |
| api.openai.com/v1/embeddings | built-in      |    216 ms |   2,668 ms |    9,856 ms |
| api.openai.com/v1/embeddings | providerFetch |    205 ms |     223 ms |      237 ms |
| openrouter.ai/api/v1/chat    | built-in      |     25 ms |     192 ms |      783 ms |
| openrouter.ai/api/v1/chat    | providerFetch |     24 ms |      27 ms |      174 ms |

The same run on the Linux workstation (Node 26.5.0): api.openai.com 32
parallel 6,629 ms built-in, 374 ms pooled; openrouter.ai 32 parallel 771 ms
built-in, 37 ms pooled.

One request takes the same time either way, so chat first-token latency does
not change. Parallel requests now finish in about one request time.

Earlier in-brain numbers with a pool (the decisions judge, v0.237.10): 8 judge
requests 4.6 s to 1.6 s; a `passage_scoring` pool of 50, p50 1.39 s to 0.91 s.
In a lab run, embedding throughput went from about 2,300 to 57,000 texts per
minute.

The guard: [`provider-fetch.test.ts`](../packages/voice/src/adapters/provider-fetch.test.ts)
serves a slow endpoint over TLS with HTTP/2 offered, warms the pool, then sends
8 POSTs at once. They must finish in under 3 request times. With the built-in
fetch they take 8 (measured: 1,624 ms against a 600 ms limit).

## What now runs in parallel, and the 429 risk

Callers that already sent parallel requests now really do:

- the extractor pool (`EXTRACT_CONCURRENCY`, 1 to 16): its chat and embed calls;
- the decisions judge fan-out;
- the passage-windows backfill (`pnpm maintain chunk-windows --apply`,
  `--parallel=N`, 1 to 32, default 4);
- any agent turns that run at the same time.

Nothing sends more requests than before; they no longer wait in line. A burst
can therefore meet a provider rate limit sooner:

- Chat adapters already retry a 429 with backoff (`withChatRetry` on std
  `withRetry`, honours `Retry-After`).
- Embedding calls now back off on a 429 too: 2, 4, 8, 16 s with jitter, then
  the error stands ([`rate-limit.ts`](../packages/embeddings/src/rate-limit.ts)).
  Before, a 429 failed the call at once.
- The decisions judge has its own breaker; a 429 there opens it.

No cron or trigger was added. If a provider keeps answering 429, lower the
caller's concurrency (the extractor count in Settings, or `--parallel` on a
backfill); do not raise `PROVIDER_CONNECTIONS`.

## Timeouts, retries and health (A10 #10)

The 2026-10 survey found 62 inline `AbortSignal.timeout(` calls with 17
distinct values, 14 hand abort timers, three private `withTimeout` copies,
about ten backoff loops with different rules, Retry-After parsed four ways,
three classifiers and the "is the local model up" probe copied four times.
Cloud embedding calls had no deadline at all, so a hung call stalled a
worker. Each now has one home in `@mantle/std`, and each pattern is pinned
at 0 outside a named list (`eslint-rules/provider-http.mjs`, the scoreboard's
`http_*` numbers, and an ESLint rule per pattern).

### Deadlines

- **The table** ([`timeouts.ts`](../packages/std/src/timeouts.ts)):
  `PROVIDER_TIMEOUTS` for model-provider calls, `NET_TIMEOUTS` for the rest.
  Every value is the one its call site had; a call site names an entry.
- **`timeoutSignal(ms, signal?)`** ([`http.ts`](../packages/std/src/http.ts)):
  the one deadline signal, combined with a caller's own (a user Stop). It
  aborts with a `TimeoutError`, the name every classifier reads.
- **providerFetch `{ timeoutMs, timeoutScope }`**
  ([`provider-fetch.ts`](../packages/voice/src/adapters/provider-fetch.ts)):
  every adapter names its deadline here, the chat calls included (one-shot:
  `{ timeoutMs }`; stream: `{ timeoutMs, timeoutScope: 'headers' }`). A call
  that names none AND brings no signal of its own gets
  `PROVIDER_TIMEOUTS.default` (180 s, the longest one we already had). A
  call that brings its own signal (an `init.signal`, or a Request, which
  always carries one: the OpenRouter SDK) and names none gets no default,
  because a default could only ever cut it shorter than the caller asked.
  Scope `headers` clears the deadline when the headers arrive, whatever the
  answer's type (event stream, ndjson, plain text); every stream call passes
  it. Scope `auto` covers the whole exchange, except an answer typed
  `text/event-stream` (the fallback for a stream call that does not say).
  After the headers the stream's idle guard in `sse.ts` bounds it. There is
  no second fetch path: egressFetch already takes `timeoutMs`.

  Fix round 1 found the first cut wrong: the chat adapters still carried
  their deadline only on `init.signal`, so the 180 s default fired first. A
  local model call allowed 300 s (`chatLocal`) was cut at 180 s, retried
  three times, then failed over to the paid cloud backup. A test now holds
  each adapter's options, and one shows a caller's longer signal is never
  cut at the default.

- **`withTimeout(promise, ms, label)`**: for work that is not a fetch (a
  dashboard vital, a sanity check, a nightly sweep). Rejects with
  `<label> timed out after <ms>`.

A headers-only deadline (cleared when the headers arrive) cannot be a
`timeoutSignal`; the three that exist (providerFetch itself, the stream
connect in `sse.ts`, the MCP SSE stream in `mcp-client.ts`) are named.

### Every provider call's deadline, main vs now

"Exchange" is the headers and the body; "headers" is the first byte only,
after which a stream's idle guard (120 s between chunks) bounds it.
"undici" is no deadline of our own: undici's 300 s for the headers and
300 s of body silence, no total.

| Caller                                                                       | Main                                       | Now                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Chat one-shot: Anthropic, Google, xAI, Hugging Face, DeepSeek                | 60 s exchange (`init.signal`)              | 60 s exchange (`chat`)                          |
| Chat one-shot: Copilot, Mammouth, custom                                     | 120 s exchange                             | 120 s exchange (`chatRelay`)                    |
| Chat one-shot: local (direct or tailnet)                                     | 300 s exchange                             | 300 s exchange (`chatLocal`)                    |
| Chat one-shot: OpenRouter (SDK)                                              | 60 s exchange (SDK signal)                 | the same (a Request input: no default)          |
| Chat stream: Anthropic, Google, xAI, HF, DeepSeek, Copilot, Mammouth, custom | 60 s headers                               | 60 s headers (`streamConnect`, scope `headers`) |
| Chat stream: local (direct or tailnet)                                       | 300 s headers                              | 300 s headers (scope `headers`)                 |
| Chat stream: OpenRouter (SDK)                                                | 60 s headers                               | the same (a Request input: no default)          |
| OpenRouter research (`web_search`, `web_search_pro`, SDK)                    | undici                                     | undici (a Request input: no default)            |
| Model lists (discover)                                                       | 15 s                                       | 15 s (`discover`)                               |
| Catalogue lists (embedding models, local models, speech models)              | 8 s                                        | 8 s (`catalog`)                                 |
| OpenRouter key info                                                          | 10 s                                       | 10 s (`keyInfo`)                                |
| Copilot token exchange                                                       | 15 s                                       | 15 s (`tokenExchange`)                          |
| Decisions judge                                                              | 1.5 s (or the caller's)                    | the same (`decision`)                           |
| Vision (one image)                                                           | 60 s                                       | 60 s (`vision`)                                 |
| Vision (Anthropic PDF)                                                       | 120 s                                      | 120 s (`visionDocument`)                        |
| Image generation (OpenAI, xAI, Google, OpenRouter)                           | 120 s                                      | 120 s (`image`)                                 |
| Image generation (Hugging Face)                                              | 180 s                                      | 180 s (`imageCold`)                             |
| OpenAI returned-image fetch                                                  | undici                                     | **120 s** exchange (`image`, new)               |
| Text to speech: ElevenLabs, Google, xAI                                      | 60 s                                       | 60 s (`speech`)                                 |
| Text to speech: OpenAI, OpenRouter                                           | undici                                     | **60 s** (`speech`, new)                        |
| Speech to text (all adapters, AssemblyAI upload and create)                  | undici                                     | **10 min** (`transcribe`, new)                  |
| AssemblyAI status poll (a GET)                                               | undici                                     | **180 s** (`default`, new)                      |
| Hosted embeddings (OpenAI, OpenRouter, Google, Mistral, Cohere)              | undici                                     | **120 s** (`embed`, new)                        |
| Local embeddings (direct or tailnet)                                         | 120 s (or `MANTLE_LOCAL_EMBED_TIMEOUT_MS`) | the same (`localEmbed`)                         |
| Local model probe (pill, sanity check, capabilities, services)               | 1.2 to 1.5 s                               | the same (`healthPill`, `localProbe`)           |
| Push relay (egress, not the pool)                                            | 10 s                                       | 10 s (`pushRelay`)                              |
| Tailnet route                                                                | whatever the adapter set                   | the same options, passed through                |

Only the rows in bold are shorter than main, and each was a call with no
deadline of its own (named behaviour changes below).

### Retries

**`withRetry(fn, { retries, retryOn, isFailure, delayMs, onRetry })`** and
**`backoffMs(step, { baseMs, factor, maxMs, jitter })`**. There is no default
budget: each caller states its own, so adopting the helper cannot add a
retry (cost-safety rule). A thrown error retries only when `retryOn` names
it; a returned value (an HTTP 429 response) retries when `isFailure` says so,
and the last one is returned when the budget is spent. `delayMs` returning
null gives up early (a deadline).

| Loop                               | Budget             | Delay                                                                 |
| ---------------------------------- | ------------------ | --------------------------------------------------------------------- |
| Chat (`withChatRetry`)             | 2 retries          | full jitter over 500 ms doubling, cap 8 s; Retry-After wins, cap 30 s |
| OpenRouter empty 2xx body          | 2 retries          | full jitter over 500 ms doubling, cap 8 s                             |
| Embed 429 (`withRateLimitBackoff`) | 4 retries          | 2, 4, 8, 16 s plus up to a quarter                                    |
| Microsoft Graph 429                | 4 retries          | Retry-After seconds, else 1, 2, 4, 8 s                                |
| Tika 429                           | until the deadline | Retry-After seconds (1 s without), at most 5 s                        |
| Telegram 429                       | 3 retries          | `retry_after` (1 s without), at most 30 s                             |
| Extract circuit probe              | (a schedule)       | 5, 10, 20, 40, then 60 min (`backoffMs`)                              |

Each row is pinned by a test recorded against the hand loop before the fold.

**`parseRetryAfterMs`** is the one Retry-After reader: delta-seconds or an
HTTP date, never negative.

### Errors

**`ProviderHttpError`** ([`provider-error.ts`](../packages/std/src/provider-error.ts))
carries `status`, `provider`, `retryAfterMs`, `body` and a `kind`. The chat
adapters' `ChatHttpError` is one, and the embedding adapters throw one (with
their old message text). Three readers live beside it over one status
reading, each keeping its own rule:

- `classifyProviderError`: what failed (quota, auth, no key, model, rate
  limit, server, network, timeout), for the alert banner and the extract
  queue's circuit;
- `retryDecision`: retry this chat call now (408, 409, 425, 429, 500, 502, 503,
  504, network, timeout, an empty body);
- `isRouteDownError`: fail an embedding over (any 5xx, network, timeout).

It is a domain error (`DOMAIN_ERRORS`): a reply says a fixed sentence per
class with the provider and the status (502, or 504 for a timeout), never
the provider's body.

### Health and breakers

**`providerHealth(baseUrl, { timeoutMs, model })`**
([`provider-health.ts`](../packages/voice/src/adapters/provider-health.ts))
is the one local model probe: the dashboard pill, the sanity check, the
capabilities panel and the services switch call it and word their own
answers.

**`CircuitBreaker`** ([`breaker.ts`](../packages/std/src/breaker.ts)) is the
one in-process breaker (the decisions judge uses it). The extract queue's
`ProviderCircuit` is a different job (a database-backed queue pause with
admin alerts), so it stays its own, on `backoffMs` for its probe schedule.
**Chat has no breaker**: a dead chat provider still costs each turn its
retries and the failover. That is a known gap, left for its own step.

### Behaviour changes

- Hosted embedding calls now abort after 120 s (`PROVIDER_TIMEOUTS.embed`);
  before, only undici's 300 s header and 300 s body-silence defaults applied.
- Speech-to-text calls abort after 10 min (`transcribe`); the OpenAI and
  OpenRouter speech calls after 60 s (`speech`, the value the other speech
  adapters had). The OpenAI image adapter's fetch of a returned image URL
  after 120 s (`image`). Before, none.
- A provider call that names no deadline and brings no signal of its own
  aborts after 180 s (`default`), headers only for an event stream. In
  practice that is one call, the AssemblyAI status poll; a caller's own
  signal is never cut shorter by the default.
- Microsoft Graph and Tika honour a Retry-After given as an HTTP date (the
  shared reader); before, a date fell back to the doubling or 1 s wait.
- A provider error that reaches a member or the model says a fixed
  sentence, never the provider's body or message (a body can carry an
  account id, an organisation name or part of a key); the detail goes to
  the server log. An HTTP answer says it with status 502 or 504 (before,
  an opaque 500). Every adapter throws `ProviderHttpError` on a non-2xx
  answer: chat, embeddings, and since fix round 1 speech, speech to text,
  vision and image generation (the body stays on the error, for the
  server log; the message text is unchanged). The sentence
  (`publicProviderErrorMessage`, @mantle/std) is, in order: a domain
  error's row (`The provider limits the request rate. (anthropic, HTTP
  429)` for a `ProviderHttpError`); the classifier's class for any other
  error it names (`The provider refused the API key. (HTTP 403)` for
  OpenRouter's SDK error); the class the status names when the error
  carries one the classifier does not read (an SDK's `statusCode`); else,
  for a provider failure no class names (an OpenRouter 400 not about the
  model, a 403 moderation refusal, a 413, a body that did not parse),
  `The model provider answered with an error.` with its status when known
  (fix round 2; before, its message). An error with no provider shape (no
  status, no body: our own) keeps its message.
  - Model-facing: a builtin that throws (the dispatcher's catch, every
    surface: `toolThrowText` maps only a provider's HTTP failure, a
    `ProviderHttpError` or an SDK error with its `statusCode` and `body`,
    so a validation message, a domain refusal or a non-provider fetch's
    404 reads as on main); the worker tools (`synthesize_speech`,
    `extract_from_image`, `summarize_text`, `generate_image`);
    `video_ingest`'s transcript step; `web_search` and `web_search_pro`;
    `recall_match` and `find_window` (`embed failed: <sentence>`); an
    attachment's vision or document note.
  - Member-facing: a member's thread error and the turn stream's error
    event for a failed team turn; an MCP client (a member's or the
    owner's) for a builtin that throws one (`thrownToolDatabaseError`).
  - Owner-side: a run worker item's stored failure (`runs_worker_turn`)
    says the sentence for a provider's HTTP failure, its own text
    otherwise; the full message stays in the run's log line. Owner-only
    surfaces keep the detail where they had it on main: the transcribe
    route for an Admin user, a settings form's model discovery, the trace.
- `withTimeout` rejects with a `TimeoutError` (std), message
  `<label> timed out after <n>`: a nightly sweep and a sanity check that
  run out of time now fail with that error, where before they threw a
  plain `Error` ("timeout" for a sanity check, "<slug>: timed out after
  30 min" for a sweep). Each caller records the message as before; a
  classifier that reads the name now sees a timeout.
- The drawing render's per-image deadline (5 s, `drawFile`) covers the
  image's fetch and its body, as the hand timer did (it was cleared after
  the read); it now aborts with a `TimeoutError` rather than an
  `AbortError`, and the image is counted missing either way.
- The Mapbox static image deadline (15 s) now covers the image body too;
  before, the headers only. Tika, the media sidecar and the onboarding
  probes abort with a `TimeoutError` rather than an `AbortError` (each
  caller treats both alike; `route_map` still says "static map request
  timed out", fix round 2).
- The chat retry log line reads `..., retry 1/2 in 250ms` (no dash).
- The member thread's error for a failed team turn, and the stream's error
  event, say the fixed sentence for a provider failure (before, the
  provider's own text).
- The ticker's and the Telegram poller's doubling waits are std `backoffMs`
  (the same delays: 1 s doubling to a 60 s cap, back to 1 s after a poll
  that goes through; pinned by the ticker tests and
  `server/web/workers/telegram-poll.backoff.test.ts`).
