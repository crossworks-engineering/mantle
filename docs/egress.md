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
  (the platform keeps custom headers such as `x-api-key`). Only 301, 302,
  303, 307 and 308 are followed, as the platform does; any other 3xx comes
  back as the response. A hop keeps the body unless it is a 303 or a 301 or
  302 on POST (the platform's downgrade to GET), so a PUT on a 301 or a
  PATCH on a 302 replays it just as a 307 or 308 does. Any hop to another
  origin that keeps the body is refused when the caller has `secrets` (an
  OAuth2 client_secret in a form body, an API tool's body); the body is not
  searched, since it may be a stream.
- **A deadline** (`timeoutMs`) over the whole exchange, body included. It
  aborts the way the callers' own timers did, so the error reads the same.
- **A streamed byte cap** (`maxBytes`): reading stops at the cap, either as
  an error (`EgressTooLargeError`) or, with `overflow: 'truncate'`, by ending
  the body there. An oversized body is never held whole.
- **`allowLan`, per caller config.** A linked peer brain or a local model on
  a private or tailnet address is legitimate. `allowLan` lets RFC 1918,
  loopback, CGNAT (Tailscale) and unique local IPv6 through and still
  refuses link-local (the metadata address lives there), the cloud metadata
  addresses that sit inside the private ranges (Alibaba `100.100.100.200`,
  Oracle `192.0.0.192`, AWS IPv6 `fd00:ec2::254`), "this network",
  multicast and reserved space.
- **The connection is pinned to a checked address** (DNS rebinding). The
  check before a hop resolves the name for a clear refusal; the connection
  then goes through an undici `Agent` whose `connect.lookup` resolves again,
  checks every answer and hands the socket only checked addresses. A name
  that answers a public address to the check and a private one to the
  connect is refused at the connect. TLS SNI and the certificate check keep
  the hostname (only the address lookup is replaced). A name that does not
  resolve is refused in every mode, `allowLan` included. A caller's own
  `guard` replaces only the check before a hop; the pin still applies. Only
  an `exempt` URL (the sandbox proxy carve) skips both.

The sandbox service proxy carve (`isSandboxProxyUrl`) stays in
`packages/tools/src/ssrf-guard.ts`: it is that package's decision, passed
in as `exempt` (through `assertFetchableUrl` for the check, and beside it
for the pin).

The pin closes the TOCTOU the old guard noted between its DNS check and
the platform's own connect.

### The callers

| Caller | File | How |
| --- | --- | --- |
| `web_fetch` | `packages/tools/src/toolsmith/web-fetch.ts` | `guardedFetch`, 5 MB streamed cap, `truncate` |
| http API tools, OAuth2 token endpoint, dev console proxy | `packages/tools/src/safe-fetch.ts` | `safeFetch` over `egressFetch` with the resolved secrets |
| OpenAPI spec fetch | `packages/tools/src/openapi-sync.ts` | `safeFetch` with a 30 s deadline (its own 5 MB reader, unchanged) |
| MCP connector | `packages/tools/src/mcp-client.ts` | `redirect: 'error'`, the SSE headers timeout kept, a reply capped at 32 MB (the standing GET event stream uncapped) |
| MCP connector OAuth endpoints | `packages/tools/src/mcp-oauth.ts` | `redirect: 'error'`, 30 s, 1 MB |
| peer MCP transport | `packages/tools/src/builtins-peer-mcp.ts` | `allowLan`, 20 redirects, a reply capped at 32 MB (the standing GET event stream uncapped) |
| federation client (`peer_query`, `peer_node_get`, `peer_search_chunks`) | `packages/content/src/peers-client.ts` | `allowLan`, the token as a secret, 15 s, 32 MB, 20 redirects |
| calendar ICS feed | `packages/calendar/src/providers/ics.ts` | 30 s, 12 MB, 20 redirects |
| `video_ingest` link | `packages/tools/src/builtins-video.ts` | a redirect walk before the sidecar, 10 s, no body read; a timeout or too many redirects refuses the link |

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

The default is 5 redirects. The three callers that used the platform's
`redirect: 'follow'` before the fold (the ICS feed, the federation client,
the peer MCP transport) keep its limit of 20 (`PLATFORM_MAX_REDIRECTS`), so
a feed or peer behind a long redirect chain answers as before.

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
| `video_ingest` link | public host, cross-host redirect, oversized | handed to the sidecar | the link is reached once (no body read), then handed to the sidecar |
| `video_ingest` link | slow server | handed to the sidecar | refused after 10 s (fix round 1: the walk fails closed, as on too many redirects) |
| federation client | redirect to 169.254.169.254 | fetched the metadata, read as "no nodes" | refused |
| federation client | oversized body | read 33 MB, the parse failure read as "no nodes" | refused at 32 MB |
| peer MCP transport | redirect to 169.254.169.254 | fetched the metadata | refused |
| `web_fetch` | oversized body | the same first 5 MB returned after reading 33 MB | the same first 5 MB, reading stops there |
| MCP connector | oversized body | read 33 MB | refused at 32 MB (fix round 1) |
| MCP connector OAuth endpoints | oversized body | read 33 MB | refused at 1 MB (fix round 1) |
| MCP connector OAuth endpoints | slow server | still waiting after ten minutes | aborted after 30 s (fix round 1) |
| OpenAPI spec fetch | slow server | still waiting after ten minutes | "fetching the spec timed out after 30 s" (fix round 1) |
| peer MCP transport | oversized body | read 33 MB | refused at 32 MB (fix round 1) |

The survey named the feed and the crawl and video redirects. The crawl
needs none (Firecrawl fetches). The federation client, the peer MCP
transport and the `web_fetch` read are the consequence of moving them onto
the one fetch with `allowLan`.

**What an owner might notice:** a calendar feed served from a host on the
box's own network (a LAN CalDAV server, a feed on a private IP) is refused
now ("refusing to fetch a private/internal address"). A peer brain answering
over 32 MB on one federation call errors instead of reading as empty.

### The pins

- `eslint-rules/no-bare-fetch.mjs` (`mantle-egress/no-bare-fetch`): all
  product code under `packages/` and `server/{web,api}/` (not tests, not
  scripts) uses the platform fetch only in the files the rule lists, its
  inventory (`BARE_FETCH_ALLOWED`, 32 files). Each entry names the kind of
  host it reaches (a fixed provider host, owner config, same-origin
  internal, a URL a fixed provider returned, or the fetch layer itself) and
  why. The rule flags a bare `fetch(`, `fetch` kept or passed as a value (an
  alias), and `globalThis.fetch`, `window.fetch`, `self.fetch` or
  `globalThis['fetch']`, called or not; `typeof fetch` in a type is not a
  use. `eslint-rules/no-bare-fetch.test.ts` holds the inventory to exactly
  the files that use the platform fetch.
- The scoreboard (`scripts/arch-scoreboard.ts`) counts the bare fetch sites
  in tools, calendar and content, `bareFetchSites`: 12 before the move,
  pinned at 5.

### Config URLs: trust levels

The inventory's "owner config" and "provider-returned" entries, and the
config-URL fetches that run through the provider pool (`providerFetch`),
are not on the egress fetch. Each fetches a URL the owner or an admin set,
or one a fixed provider returned, never one a user message, a model or a
remote document chose:

| Fetch | Where | Trust |
| --- | --- | --- |
| custom chat, agent and AI worker base URLs | `packages/voice` (provider pool) | owner config: a local model on a LAN or tailnet address on purpose |
| `/api/embedding/test` (`probeEmbeddingRoute`), the embedder probes | `packages/embeddings`, `server/web/lib/integrity/capabilities.ts`, `system-health.ts`, `services.ts` | owner config: the embedding base URL (a LAN or tailnet embedder on purpose) |
| onboarding Azure probe | `server/web/lib/onboarding-steps.ts` | owner config: the Azure base URL the owner types in during onboarding |
| IMAP and SMTP | `packages/email` (sockets, not fetch) | owner config: the mail host the owner set; not an HTTP fetch, so outside this layer |
| Microsoft Graph download URL | `packages/microsoft/src/drives/sync.ts` | provider-returned: the pre-authenticated URL in Graph's own answer |
| xAI returned image URL | `packages/voice/src/adapters/xai-image.ts` | moved onto the egress fetch (fix round 1): any URL in the answer, so it is checked, with 60 s and 32 MB |

### Calendar feeds on the LAN

A calendar feed served from the box's own network (a LAN CalDAV server, a
feed on a private IP) is refused: the ICS fetch does not take `allowLan`,
because the feed URL can come from a shared link or an invite, not only
from the owner. When a real need appears, the planned answer is an operator
allow-list read by the egress layer (an environment variable such as
`MANTLE_EGRESS_LAN_ALLOW` naming the hosts or ranges a box may reach), not
`allowLan` per caller. Link-local and the cloud metadata addresses stay
refused whatever that list says.

## The background fence (fold 4)

The fence (`fenceRetrieved`, its forged-marker defang `stripFenceMarkers`,
the markers `FENCE_OPEN` and `FENCE_CLOSE`) moved from
`packages/runtime/src/agent/messages.ts` to `packages/std/src/fence.ts`.
`messages.ts` re-exports it, so the live loop (`execute-call.ts`) and the
turn's own blocks are byte for byte as before
(`packages/std/src/fence.test.ts` pins the markers). The tools' error
hygiene (`packages/tools/src/errors.ts`) uses the same defang instead of its
own copy of the pattern.

The defang reads a skeleton of the text, not its exact characters (fix
round 1): each character NFKC-normalised (fullwidth and styled letters and
brackets to plain ones), zero-width and other invisible characters and
combining marks dropped, Cyrillic, Greek and small-capital look-alikes
folded to Latin, case ignored, and any run of spaces, newlines,
underscores, hyphens, dots or colons (or none) taken between the words. A
marker counts with a bracket on either side, so a missing closing bracket
is still caught and prose that names the words is left alone. Text without
a marker comes back byte for byte, so the live turn's prompts are unchanged
for normal text. A per-call nonce in the markers was not added: the live
turn's markers stay byte-identical, and the skeleton match covers the
disguises a nonce would.

The background jobs that read outside text now fence it:

| Job | File | What is fenced |
| --- | --- | --- |
| extractor (summary, facts, entities) | `server/api/src/agent/extract/model.ts` | the node's title and body (an email's subject and text, a fetched page, an upload's filename and text); the type stays outside |
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
`background-prompts.after.json` beside it). One named change since (fix
round 1): the extractor's `Title:` line moved inside the fence, at the head
of the fenced text, since a subject, filename or page title is outside text
too; a separate case puts an injection and a forged marker in a title and
requires them inside the fence.

**Eval and recall quality.** A fenced block adds about 20 tokens (the two
marker lines), the note about 40 on a system prompt that is cached per
worker. Extraction, reflection and digest quality could shift a little,
most likely on the small local models (a model may echo a marker or treat
the fenced text more cautiously). No paid model eval was run for this
change; `pnpm -C server/web eval:recall` and `pnpm -C server/api bench:memory` are the checks to run
on the dev box before rolling it wider.

The chat archive summary (`packages/runtime/src/agent/chat-archive.ts`,
`buildArchiveSummaryMessages`) fences the thread since fix round 1: the
summary it writes re-enters later prompts. Like the conversation
summarizer, its prompt is built by `buildChatMessages`, whose standing
data-boundary rule explains the fence.

**Not fenced here**, for a later pass: the fact classifier
(`server/api/src/agent/extract/facts.ts`) reads candidate facts (the
extractor's own output, already from fenced input) and the existing facts;
the worker RPC (`server/web/lib/ai-worker-rpc.ts`) builds model input from
stored text; the follow-up suggester (`server/api/src/turn-suggestion.ts`)
reads the turn's user text and reply, and the status narrator
(`server/api/src/turn-narration.ts`) reads a status line that can carry a
search term or a tool's topic. Both write only a short line for the live
UI (a chip, a thought-trail line), nothing that is stored as memory or
read by a later prompt, so they are the next candidates, not urgent.
