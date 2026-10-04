# Provider HTTP: the shared connection pool

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

| Setting           | Value                               | Why                                                                      |
| ----------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| Agent             | one per process                     | one connection pool per origin inside it                                 |
| Protocol          | HTTP/1.1 (`allowH2: false`)         | the well-tested path; parallel calls use parallel connections             |
| Connections       | 32 per origin (`PROVIDER_CONNECTIONS`) | a ceiling, not a driver: callers still decide how many calls they send |
| Keep-alive        | 10 s idle                           | reuse TLS connections between bursts                                     |
| Timeouts          | undici defaults (as built-in fetch) | a slow local model may take minutes for its first byte                   |

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

| Origin                       | Fetch          | 1 request | 8 parallel | 32 parallel |
| ---------------------------- | -------------- | --------: | ---------: | ----------: |
| api.openai.com/v1/embeddings | built-in       |    216 ms |   2,668 ms |    9,856 ms |
| api.openai.com/v1/embeddings | providerFetch  |    205 ms |     223 ms |      237 ms |
| openrouter.ai/api/v1/chat    | built-in       |     25 ms |     192 ms |      783 ms |
| openrouter.ai/api/v1/chat    | providerFetch  |     24 ms |      27 ms |      174 ms |

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

- Chat adapters already retry a 429 with backoff (`withRetry`, honours
  `Retry-After`).
- Embedding calls now back off on a 429 too: 2, 4, 8, 16 s with jitter, then
  the error stands ([`rate-limit.ts`](../packages/embeddings/src/rate-limit.ts)).
  Before, a 429 failed the call at once.
- The decisions judge has its own breaker; a 429 there opens it.

No cron or trigger was added. If a provider keeps answering 429, lower the
caller's concurrency (the extractor count in Settings, or `--parallel` on a
backfill); do not raise `PROVIDER_CONNECTIONS`.
