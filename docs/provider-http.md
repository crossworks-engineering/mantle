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
  every provider call has a deadline. A call that names none gets
  `PROVIDER_TIMEOUTS.default` (180 s, the longest one we already had). The
  scope `auto` covers the whole exchange of an ordinary answer and only the
  headers of an event stream, so a long healthy stream is never cut (the
  stream's idle guard in `sse.ts` bounds it after that). There is no second
  fetch path: egressFetch already takes `timeoutMs`.
- **`withTimeout(promise, ms, label)`**: for work that is not a fetch (a
  dashboard vital, a sanity check, a nightly sweep). Rejects with
  `<label> timed out after <ms>`.

A headers-only deadline (cleared when the headers arrive) cannot be a
`timeoutSignal`; the three that exist (providerFetch itself, the stream
connect in `sse.ts`, the MCP SSE stream in `mcp-client.ts`) are named.

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
  adapters had). Before, none.
- A provider call that names no deadline aborts after 180 s (`default`),
  headers only for an event stream.
- Microsoft Graph and Tika honour a Retry-After given as an HTTP date (the
  shared reader); before, a date fell back to the doubling or 1 s wait.
- A provider error that reaches a reply or a tool answer says a fixed
  sentence (`The provider limits the request rate. (anthropic, HTTP 429)`),
  status 502 or 504; before, an opaque 500, and a tool answer carried the
  provider's own text.
- `withTimeout` messages read `<label> timed out after <n>` (a sanity check
  said "timeout", a sweep "<slug>: timed out after 30 min").
- The Mapbox static image deadline (15 s) now covers the image body too;
  before, the headers only. Tika, the media sidecar and the onboarding
  probes abort with a `TimeoutError` rather than an `AbortError` (each
  caller treats both alike).
- The chat retry log line reads `..., retry 1/2 in 250ms` (no dash).
