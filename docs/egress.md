# One egress fetch and the background fence (A10 part 1)

Folds 3 and 4 of the gateway survey (dev-brain page "Gateway survey:
scattered checks across Mantle", 2026-10-14). Two jobs that each lived in
one place for the live turn and were done by hand, or not at all, elsewhere:

- **Fetching a URL that came from outside** (a user, a model, a remote
  server, a linked peer). One guard existed; some callers had their own
  redirect loop, some had none.
- **Fencing outside text before a model reads it.** The live tool loop
  fenced; the background jobs that write long-term memory did not.

The house style of the proofs (record, move, compare) is the one in
[actors.md](actors.md).

## The egress fetch (fold 3)

`egressFetch(input, init, opts)` in `packages/std/src/egress.ts`
(`@mantle/std/egress`, node only, so the browser bundles of `@mantle/std`
stay free of node builtins). On top of the platform fetch:

- **The address check on every hop.** Redirects are followed by hand and
  each target is resolved and refused when it lands on a private, loopback,
  link-local, CGNAT, cloud metadata or reserved address (`assertEgressUrl`,
  `isBlockedIp`). `redirect: 'error'` refuses any redirect instead.
  An IPv6 address is read as 16 bytes, whatever its text form (the URL
  parser writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`): the forms that
  carry an IPv4 address (IPv4-mapped `::ffff:0:0/96`, IPv4-compatible
  `::/96`, IPv4-translated `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96`, 6to4
  `2002::/16`) are judged by the IPv4 rules; Teredo `2001::/32`, local-use
  NAT64, site-local `fec0::/10`, multicast `ff00::/8`, documentation and
  discard space are refused for every caller.
- **Secret headers across origins.** On a hop to another origin it drops
  Authorization, Cookie and Proxy-Authorization by name (as the platform
  does) and any header whose value carries one of the caller's `secrets`
  (the platform keeps custom headers such as `x-api-key`).
- **A deadline** (`timeoutMs`) over the whole exchange, body included. It
  aborts the way the callers' own timers did, so the error reads the same.
- **A streamed byte cap** (`maxBytes`): reading stops at the cap, either as
  an error (`EgressTooLargeError`) or, with `overflow: 'truncate'`, by ending
  the body there. An oversized body is never held whole.
- **`allowLan`, per caller config.** A linked peer brain or a local model on
  a private or tailnet address is legitimate. `allowLan` lets RFC 1918,
  loopback, CGNAT (Tailscale) and unique local IPv6 through and still
  refuses link-local (the metadata address lives there), "this network",
  multicast and reserved space. A name that does not resolve is left to the
  platform's connect, as before.

The sandbox service proxy carve (`isSandboxProxyUrl`) stays in
`packages/tools/src/ssrf-guard.ts`: it is that package's decision, passed
in as `exempt` through `assertFetchableUrl`.

Residual, unchanged: a TOCTOU between the DNS check and the platform's own
connect (DNS rebinding). Noted in the module, not closed.

### The callers

| Caller | File | How |
| --- | --- | --- |
| `web_fetch` | `packages/tools/src/toolsmith/web-fetch.ts` | `guardedFetch`, 5 MB streamed cap, `truncate` |
| http API tools, OAuth2 token endpoint, dev console proxy | `packages/tools/src/safe-fetch.ts` | `safeFetch` over `egressFetch` with the resolved secrets |
| OpenAPI spec fetch | `packages/tools/src/openapi-sync.ts` | `safeFetch` (its own 5 MB reader, unchanged) |
| MCP connector | `packages/tools/src/mcp-client.ts` | `redirect: 'error'`, the SSE headers timeout kept |
| MCP connector OAuth endpoints | `packages/tools/src/mcp-oauth.ts` | `redirect: 'error'` |
| peer MCP transport | `packages/tools/src/builtins-peer-mcp.ts` | `allowLan` |
| federation client (`peer_query`, `peer_node_get`, `peer_search_chunks`) | `packages/content/src/peers-client.ts` | `allowLan`, the token as a secret, 15 s, 32 MB |
| calendar ICS feed | `packages/calendar/src/providers/ics.ts` | 30 s, 12 MB |
| `video_ingest` link | `packages/tools/src/builtins-video.ts` | a redirect walk before the sidecar, 10 s, no body read |

Not moved, and why:

- **`web_crawl` / `web_map`.** Firecrawl's cloud fetches the site, not this
  box, so a redirect it follows lands in Firecrawl's network. The survey's
  "redirects followed unchecked" is theirs; `vetUrl` keeps checking the
  first URL as hygiene.
- **The media sidecar's own fetch.** yt-dlp follows redirects inside the
  sidecar (`infra/media-sidecar/app.py` re-checks the first host only). The
  app now walks the redirects first, so a link that redirects into private
  or metadata space is refused before the sidecar sees it; a site that
  answers the box and yt-dlp differently is the residual the sidecar's
  isolation still bounds.
- **Provider adapters with fixed hosts** (Mapbox, the OpenRouter Data API,
  sandboxd in `@mantle/tools`; the model and embedding providers, Tika, the
  media sidecar, Microsoft Graph, Telegram elsewhere).
- **Local model and embedder base URLs** (`packages/voice`,
  `packages/embeddings`): owner config pointing at a LAN or tailnet host on
  purpose, outside the swept packages.

### The proof

Record, move, compare. A fake network (`packages/std/src/egress-test-net.ts`)
stands in for DNS (`node:dns/promises`, mocked per test file) and the
platform fetch (stubbed), with the platform's redirect modes as Node 26 runs
them (checked against two loopback servers: `follow` keeps custom headers on
a cross-origin hop and drops Authorization, Cookie and Proxy-Authorization).
Every caller above, called the way its product code calls it, runs over
seven cells: a public host, a private IP, a name resolving to 127.0.0.1, a
redirect to 169.254.169.254, a redirect to another host carrying
Authorization, an oversized body (33 MB) and a slow server (fake time, ten
minutes). Each cell records the caller's answer, the hosts reached, whether
the other host saw Authorization and how much of the oversized body was
read.

The tables were recorded on the sources before the move and are never
rewritten: `packages/tools/src/__snapshots__/egress-proof.before.json`,
`packages/calendar/src/providers/__snapshots__/egress-proof.before.json`,
`packages/content/src/__snapshots__/peers-egress-proof.before.json`. After
the move each test (`packages/tools/src/egress-proof.test.ts`,
`packages/calendar/src/providers/egress-proof.test.ts`,
`packages/content/src/peers-egress-proof.test.ts`) requires the table to
equal the recorded one with its named changes applied, and nothing else;
the tables after are the `.after.json` files beside them.

**Unchanged:** every cell of the callers guarded before (`web_fetch`, the
http API tools, the OpenAPI spec fetch, the MCP connector and its OAuth
endpoints) answers as before. A peer on a private IP or a name resolving to
loopback answers as before.

**Named changes:**

| Caller | Cell | Before | After |
| --- | --- | --- | --- |
| calendar ICS feed | private IP | pulled | refused |
| calendar ICS feed | name resolving to 127.0.0.1 | pulled | refused |
| calendar ICS feed | redirect to 169.254.169.254 | fetched the metadata, failed to parse | refused before the hop |
| calendar ICS feed | oversized body | "feed too large" after reading 33 MB | "feed too large" at 12 MB |
| `video_ingest` link | redirect to 169.254.169.254 | handed to the sidecar | refused |
| `video_ingest` link | public host, cross-host redirect, oversized, slow | handed to the sidecar | the link is reached once (no body read), then handed to the sidecar; a slow host adds up to 10 s |
| federation client | redirect to 169.254.169.254 | fetched the metadata, read as "no nodes" | refused |
| federation client | oversized body | read 33 MB, the parse failure read as "no nodes" | refused at 32 MB |
| peer MCP transport | redirect to 169.254.169.254 | fetched the metadata | refused |
| `web_fetch` | oversized body | the same first 5 MB returned after reading 33 MB | the same first 5 MB, reading stops there |

The survey named the feed and the crawl and video redirects. The crawl
needs none (Firecrawl fetches). The federation client, the peer MCP
transport and the `web_fetch` read are the consequence of moving them onto
the one fetch with `allowLan`.

**What an owner might notice:** a calendar feed served from a host on the
box's own network (a LAN CalDAV server, a feed on a private IP) is refused
now ("refusing to fetch a private/internal address"). A peer brain answering
over 32 MB on one federation call errors instead of reading as empty.

### The pins

- `eslint-rules/no-bare-fetch.mjs` (`mantle-egress/no-bare-fetch`): no bare
  `fetch(` or `globalThis.fetch(` in `@mantle/tools`, `@mantle/calendar` and
  `@mantle/content` outside three fixed-host files, each listed with its
  reason (Mapbox, the OpenRouter Data API, sandboxd).
  `eslint-rules/no-bare-fetch.test.ts` holds the list to what the repo
  has.
- The scoreboard (`scripts/arch-scoreboard.ts`) counts the bare fetch sites
  in those packages, `bareFetchSites`: 12 before the move, pinned at 5.

## The background fence (fold 4)

The fence (`fenceRetrieved`, its forged-marker defang `stripFenceMarkers`,
the markers `FENCE_OPEN` and `FENCE_CLOSE`) moved from
`packages/runtime/src/agent/messages.ts` to `packages/std/src/fence.ts`.
`messages.ts` re-exports it, so the live loop (`execute-call.ts`) and the
turn's own blocks are byte for byte as before
(`packages/std/src/fence.test.ts` pins the markers). The tools' error
hygiene (`packages/tools/src/errors.ts`) uses the same defang instead of its
own copy of the pattern.

The background jobs that read outside text now fence it:

| Job | File | What is fenced |
| --- | --- | --- |
| extractor (summary, facts, entities) | `server/api/src/agent/extract/model.ts` | the node's body (an email, a fetched page, an upload); the title stays outside, defanged |
| reflector | `server/api/src/agent/reflector.ts` | the recent transcript (the notes it already has stay outside) |
| conversation summarizer | `server/api/src/agent/summarizer.ts` | the batch's transcript |
| `summarize_text` | `packages/tools/src/builtins-workers.ts` | the source text (the caller's focus stays outside) |

Each system prompt ends with one line saying what the fence means
(`BACKGROUND_FENCE_NOTE`, added by `withFenceNote`), whether the prompt is
the default or the worker's own. The summarizer's is the exception: it is
built by `buildChatMessages`, which already ends it with the live turn's
standing data-boundary rule. Output formats are unchanged.

**Proof:** `server/api/src/agent/background-prompts.test.ts`, recorded
before the fence (`server/api/src/agent/__snapshots__/background-prompts.before.json`)
with a fixture that carries an injection attempt and two forged markers:
each job's input after the fence wraps the outside text and strips the
forged markers, and equals the recorded input but for the two fence lines,
the defanged markers and the one note line (the after file is
`background-prompts.after.json` beside it).

**Eval and recall quality.** A fenced block adds about 20 tokens (the two
marker lines), the note about 40 on a system prompt that is cached per
worker. Extraction, reflection and digest quality could shift a little,
most likely on the small local models (a model may echo a marker or treat
the fenced text more cautiously). No paid model eval was run for this
change; `pnpm -C server/web eval:recall` and `pnpm -C server/api bench:memory` are the checks to run
on the dev box before rolling it wider.

**Not fenced here**, for a later pass: the fact classifier
(`server/api/src/agent/extract/facts.ts`) reads candidate facts (the
extractor's own output, already from fenced input) and the existing facts;
the chat archive summary (`packages/runtime/src/agent/chat-archive.ts`) and
the worker RPC (`server/web/lib/ai-worker-rpc.ts`) also build model input
from stored text and are the next candidates.
