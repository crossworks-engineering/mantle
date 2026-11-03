# Federation: Mantle-to-Mantle

Two sovereign single-user Mantles exchanging **scoped** data over an
authenticated channel. This is deliberately **not** multi-tenancy: each brain
stays a bounded "one life" with its own `owner_id`; they negotiate at the
border. Her Mantle asks yours *"do you hold her passports?"* and yours answers
**only** what you've explicitly shared with her peer.

Companion to [`architecture.md`](./architecture.md) (the single-user model this
preserves), [`sharing.md`](./sharing.md) (the public-link sharing this extends),
and [`observability.md`](./observability.md) (every cross-Mantle read is traced).

## Locked design decisions (2026-05-29)

| Concern | Decision |
|---|---|
| **Peer auth** | Sealed per-peer bearer token. Reuses `@mantle/crypto` (AES-256-GCM) + the `api_keys` vault pattern. |
| **Access scope** | Explicit grants only, per node (`peer_shares`) or per category (`peer_share_scopes`, added 2026-07-14). A peer sees nothing it wasn't granted, passports invisible unless shared. A category grant is a **standing subscription** resolved at query time: enable "Pages" for a peer and every page, including pages created later, is readable by it. |
| **Consent** | Auto-answer within the granted scope; every cross-Mantle access is a trace row. |
| **Channel** | Both, an HTTP federation API for scoped data exchange, plus MCP tool access. |

## Trust model

Each peer relationship has **two tokens, one per direction**:

- **Outbound** (`mantle_peers.outbound_token_enc`): the token *they* issued
  *us*, sealed AES-256-GCM (AAD = row id). We replay it as
  `Authorization: Bearer` when we call their API. Reversible because we must
  resend it. Optional at create: without it the peer sits in
  `status='pending'`, inbound requests still verify (so the other side can
  start querying as soon as they paste our token), outbound calls are disabled
  until the token is added. This is what makes first-time pairing possible:
  each side adds the other with just a URL, sends the token it minted, and
  pastes the one it receives; neither has to go first.
- **Inbound** (`mantle_peers.inbound_token_hash`): SHA-256 of the token *we*
  minted for *them*. We show its plaintext to the operator exactly once (to hand
  over), then keep only the hash. An inbound request is verified by hashing the
  presented bearer and matching the unique index, no reversible inbound secret
  at rest.

Revoking a peer (`status='revoked'` / `enabled=false`) instantly closes both
directions; rotating regenerates one side without disturbing the other.

## Schema (migration 0052)

- **`mantle_peer` node type**: the browsable, searchable face of a peer (like a
  `contact`, but for a system). Secrets never live in `node.data`.
- **`mantle_peers`**: connection record + sealed credentials, linked to its
  node via `node_id` (the telegram_accounts sealed-sidecar pattern).
- **`peer_shares`**: explicit per-node grants. The federation query returns the
  intersection of *(what the peer asked for)* ∩ *(nodes with an active grant for
  that peer)*. Revoke-don't-delete (partial unique on `(peer_id, node_id) WHERE
  revoked_at IS NULL`), so grant history stays auditable.
- **`peer_share_scopes`** (migration 0118): standing per-category grants: one
  active row per `(peer_id, node_type)` means *every* node of that type is
  readable by the peer, **including nodes created after the grant**: the grant
  is a predicate resolved at query time, never materialized into an id list.
  Same revoke-don't-delete shape. The effective grant set everywhere is
  `(id ∈ peer_shares) OR (type ∈ peer_share_scopes)`, resolved in ONE place
  (`activePeerGrantNodeIds`) and applied by all three read paths
  (`queryForPeer`, `searchChunksForPeer`, `getNodeForPeer`). Which types may be
  category-shared is a server-enforced allowlist (`PEER_SHAREABLE_TYPES`):
  pages, notes, files, contacts, tables, events, tasks, never `secret` or
  `mantle_peer`, and deliberately never `email` or `journal` (the owner's
  private corpus; even the team responder gates those behind
  `teamPrivateReads`). Individual email/journal nodes can still be
  cherry-picked via `peer_shares`. The same reasoning covers what a category
  of an allowed type holds (access matrix H1, 2026-10-08): a category grant
  never covers the notes Mantle writes about the owner's own chats
  (conversation digests and chat archives) nor the files that are email
  attachments (`peerCategoryExcluded`, inside `grantUnionFilter`, so every
  read path shares it). A per-node grant still reaches one of them when the
  owner picks it.

## Request flow (target)

```
Her Mantle (asking)                         Your Mantle (answering)
  Saskia: "ask Alex's Mantle for           POST /api/federation/query
   her passports"                             Authorization: Bearer <inbound token>
  → peer_query tool                           { query: "her passports",
  → POST {peer.base_url}/api/federation/query   types: ["file"] }
     Authorization: Bearer <outbound token>  → hash bearer → resolve peer
                                             → search ∩ active peer_shares
                                             → open federation_request trace
                                             → return granted matches only
  ← cited results                           ← { nodes: [...] }
```

## Build phases

- **Phase 1, foundation (DONE, 2026-05-29).** `mantle_peer` node type +
  `mantle_peers` + `peer_shares` tables + Drizzle schema. Migration 0052.
- **Phase 2, data + crypto layer (DONE, 2026-05-29).** `@mantle/content/peers`:
  `createPeer` (seal outbound, mint+hash inbound), `verifyInboundToken`
  (constant-time, bumps `last_seen_at`), `getOutboundToken`, `grant`/
  `revokePeerShare`, `listPeerShares`, and `queryForPeer` (the scoped read,
  active grants ∩ request filters, no unscoped variant exists). Pure token
  helpers in `peers-crypto.ts` with 9 unit tests; full create→verify→grant→
  query→revoke→delete path verified live against the dev DB.
- **Phase 3, HTTP federation API (DONE, 2026-05-29).** `POST
  /api/federation/query` + `GET /api/federation/node/[id]`, bearer-verified via
  `authenticatePeer` (the `/api/federation` prefix is a PUBLIC_PATH; it gates
  on the peer token, not the owner cookie). New `federation_request` trace kind
  (migration 0053), every cross-Mantle read opens one under the answering
  owner, visible on `/traces`. Ungranted node → 404 (indistinguishable from
  not-found, so a peer can't probe). Verified live over loopback: auth (401 on
  no/wrong token), scope (type filter), node fetch, 404, and traces all
  correct. *Known refinement:* a `page`'s body lives in the `pages` sidecar, so
  `getNodeForPeer` currently returns the node's `data` (summary/tags) without
  the rich page body, fine for files/notes; page-body federation is a later
  pass.
- **Phase 4, outbound tools (DONE, 2026-05-29).** Shared outbound client
  `@mantle/content/peers-client` (`queryPeer` / `getPeerNode`, resolve peer by
  name/id, sign with the sealed outbound token, fetch with a 15s timeout).
  Since A10 part 1 the fetch is the one egress fetch with `allowLan`
  ([egress.md](egress.md)): a peer on a private, loopback or tailnet address
  keeps working, a redirect to link-local space (the cloud metadata address)
  is refused, the token is dropped on a hop to another origin, and a reply
  over 32 MB is not read. The peer MCP tools' transport runs on the same.
  Surfaced as three builtins (`peer_list` / `peer_query` / `peer_node_get`, in
  `@mantle/tools`) for Saskia AND three MCP tools (same names) for Claude
  Desktop/Code; both thin wrappers over the one client. Verified live via a
  self-loopback peer (outbound token = own inbound token, base_url =
  localhost:3000): query returns the granted node, type filter scopes, node
  fetch works, unknown peer errors. **Operator step:** the builtins seed into
  the `tools` table on the next `server/api` boot; grant `peer_query` /
  `peer_node_get` / `peer_list` to a responder at `/settings/agents` for Saskia
  to use them.
- **Phase 5, UI (DONE, 2026-05-29; pairing flow fixed 2026-07-14).**
  `/settings/peers` master-detail (sidebar nav entry added): add a peer with
  just a name + URL (mints + reveal-once YOUR token immediately; their token is
  optional and can be pasted later, before the fix both sides needed the
  other's token first, a deadlock for two fresh Mantles),
  enable/disable, rotate inbound token, update outbound token, delete; and a
  search-and-grant picker over your nodes (excludes branches/secrets/peer
  records) with revoke. Backed by `/api/peers` (+ `/[id]`, `/[id]/rotate`,
  `/[id]/shares`, `/nodes`). Mirrors the `/settings/keys` reveal-once pattern.

- **Phase 6, semantic federation search (DONE, 2026-07-13).** `queryForPeer`
  now ranks with the same hybrid vector+FTS pipeline local search uses: the
  answering brain embeds the peer's query text in ITS OWN vector space
  (`embed(peer.ownerId, q)` in the route, the wire still carries text only,
  so the protocol is unchanged and older peers transparently get better
  ranking) and `searchNodes` runs with the active grant set as a hard
  id-allowlist (`ids` in `SearchOptions`), the no-unscoped-variant invariant
  is preserved by construction. Embed failure degrades to FTS ranking, never a
  hard error. New passage endpoint `POST /api/federation/chunks`
  (`searchChunksForPeer`, vector search over `content_chunks` restricted to
  granted nodes) + outbound `searchPeerChunks` + `peer_search_chunks` builtin
  (in the `federation` tool group). Because chunks carry the full extracted
  text, passage search also closes most of the Phase 3 page-body gap: a peer
  can now read the relevant *sections* of a granted page. Older peers without
  the endpoint 404; the tool surfaces that as "use peer_query instead".

- **Phase 7, category peer-shares (DONE, 2026-07-14).** Grants gained a second
  kind: per-category (`peer_share_scopes`, see Schema above). "Share whole
  categories" Switch rows in the peer detail pane at `/settings/peers`, one
  per shareable type with its node count and an "includes future X" hint (the
  dynamic nature must be unmissable); the per-node picker stays for
  cherry-picking and both coexist. `/api/peers/[id]/shares` GET now returns
  `{ shares, typeShares, typeCounts }`; POST accepts `{ nodeType }`; DELETE
  accepts `?nodeType=`. Resolution-side: `activePeerGrantNodeIds` returns
  granted types alongside explicit ids, and the grant union travels into
  `@mantle/search` as a composable predicate (`SearchOptions.idsOrTypes` /
  `ChunkSearchOptions.nodeIdsOrTypes`, built by `grantUnionFilter`), no
  materialized id lists, no wire-protocol change; entirely answering-side.
  Caveat: category-sharing Pages amplifies the page-body gap (bodies still
  aren't federated; passages + summaries are, Phase 3 note).

**Status: feature complete.** Two sovereign Mantles can now register each other,
exchange tokens via the UI, grant specific nodes or whole categories, and query
across the border semantically, Saskia (or Claude) on one side, the scoped
HTTP API on the other, every read traced. Remaining nice-to-haves: full
page-body federation (Phase 3 note; passage search now covers the common case),
a handshake/pairing flow to auto-exchange tokens, and per-peer rate limiting.

## Peers that act as a login

Since 0227 a peer can also be bound to a login and call this brain's MCP
endpoint as that login, read-only unless its Write switch is on. See
[mcp-as-a-login.md](mcp-as-a-login.md).

## Status links

A status link lets one box (the admin box) watch others: every few minutes
it reads each watched box's health as numbers, with no model call, no
person clicking and no password. It is the fleet monitor's base; a mini app
keeps the history and draws it.

### The access scope (migration 0354)

`mantle_peers.access_scope` says what a peer's inbound token may do here:

| Scope    | What the token reaches                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `full`   | As every peer before 0354: the federation read routes, and `/api/mcp` as its Acts as login. Every existing peer is `full`. |
| `status` | `/api/mcp` lists and calls `box_status` and `brain_capacity`, nothing else. Never the federation routes.                  |
| `none`   | Nothing: the token verifies nowhere. An outbound-only peer, the watching side of a link.                                   |

A value this code does not know grants nothing (`peerAccessScopeOf`), and a
CHECK refuses any value outside the three. The checks, from the outside in:

- `verifyInboundToken` (`packages/content/src/peers/registry.ts`) verifies
  only a `full` or `status` token;
- `authenticatePeer` (`server/web/lib/federation-auth.ts`) refuses all but
  `full`, so a status peer reads no shared item;
- `callerFromPeerToken` (`server/web/lib/mcp-auth.ts`) makes a status peer a
  caller with `statusOnly`: the brain's owner as the owner is now (an Admin
  login, still usable), read-only, no risky tools, whatever the row says
  about Acts as, its Write switch or its risky tools;
- the MCP surface registers only the status tools for it, on the full list
  even when the tool map is asked for (no `tool_read`, `tool_help` or other
  call tool), and the instructions name only them
  (`packages/mcp-core/src/login-surface.ts`);
- the gate's peer narrower refuses any other name for it at list and call
  time (`packages/tools/src/gate-narrowers.ts`, the list in
  `packages/tools/src/status-surface.ts`).

`mantle_peers.watch_status` marks a peer this box watches: `peer_status`
asks it when no peer is named.

### The two tools

- **`box_status`** (`packages/tools/src/builtins-box-status.ts`): this box as
  numbers, `schema: 1`. Build version, sha and time; process uptime and
  memory; host CPU load, load average, cores, memory and disk, with `scope`
  (`container`, or `host` when the box mounts the host's `/proc`, below);
  Postgres up, size, connections and cache hit; each service up or down
  (object store, parser with its running and queued jobs, browser,
  documents, embedder, sandboxes, network); model spend in micro-USD over
  the last 24 hours, 7 and 30 days, with the last day's trace, turn and
  error counts; corpus capacity (counts, zone, percent of split); the
  extractor's queue and dead letters; logins by role. `degraded` names the
  probes that did not answer. Never a name, a title, a host or anything a
  user wrote: the collector (`server/web/lib/box-status.ts`) reads only
  counts, and the tool rebuilds its output from schema 1's shape
  (`shapeBoxStatus`, `packages/tools/src/box-status-bridge.ts`): only the
  known key paths, a number at each numeric path, a boolean at each flag,
  and a string only where the shape has one and only when it fits that
  path's pattern or list (`ts` a UTC ISO time; the build's version x.y.z
  with at most an `alpha`, `beta` or `rc` tag and its number, sha hex and
  time an ISO date; `host.scope` `container` or `host`;
  `capacity.zone` `green`, `watch` or `split`). `degraded` keeps only our
  probes' fixed names (`BOX_STATUS_PROBES`). Everything else is dropped. It never
  makes the paid embedder probe the dashboard makes. Read, spends nothing,
  the settings area, not risky. Cached 30 seconds, one collection at a time.
- **`peer_status`**: asks every watched, paired, enabled peer for its
  `box_status` over the peer's `/api/mcp`: the first 64 by name (the rest
  are counted in `skipped`), eight at a time, 10 seconds each and the whole
  call within 45 seconds (a peer not answered or not asked by then reads
  `timeout`), a reply read up to 256 KB, and adds this box's own line
  (`self: true`). `peer` names one peer instead. Each line is
  `{ peerId, name, ok, ms, status }` or, on a failure, a short fixed
  `error` (`timeout`, `unreachable`, `refused`, `not offered`, `failed`,
  `bad reply`, `not paired`, and `unavailable` for this box's own line in a
  process without the collector), never the peer's reply text. A peer's
  status is rebuilt by the same `shapeBoxStatus` before a model reads it (a
  reply that is not schema 1 is a `bad reply`), so a linked box can put no
  key and no text of its own into it; it is fenced as data all the same. It calls `box_status` and nothing else, at the peer row's own URL
  (no URL is an argument). Read, spends nothing, the settings area; risky
  for a key or a peer by the `peer_` family rule (it reaches other brains on
  this brain's credentials), as every `peer_` tool is.

The collectors live in server/web, so only the web process installs them
(`packages/tools/src/box-status-bridge.ts`). The runner (agent turns) and
the stdio MCP server answer that `box_status` is read over the box's MCP
endpoint; `peer_status` there reports its own line as `unavailable` and
still asks the peers. So `box_status` is in a group of its own,
`fleet-status`, that no shipped agent holds (a turn in the runner would get
the refusal); `peer_status` is in `federation`.

A status peer runs as the owner login, as the owner is now. When the
owner is disabled, or the box's password rule holds the owner (a password
to change, or one not yet checked under the rule), the peer is no caller:
the watching box's `peer_status` reads `refused` for it until the owner
signs in. The same holds for an HTTP change that mints or arms one: a new
token (rotate) and turning it back on are the owner's, as for a peer bound
to the owner (`peerBoundToOwner` counts every scope but `full`).

Host numbers: in a container the load average and memory come from the
web container's `/proc`. A box that wants the host's own sets
`MANTLE_HOST_PROC` to a read-only mount of the host's `/proc` files
`loadavg` and `meminfo` (for example `/host/proc`); `scope` then reads
`host`. Mount only those two files: the whole host `/proc` shows every host
process to the container. The shipped compose files mount nothing.

### Linking from the shell

`scripts/peer-link.sh` runs `server/web/scripts/peer-link.ts` in the web
container, as `scripts/onboard.sh` does: shell access proves ownership, so
it asks for no password, and every peer it makes is the owner's. A create
prints `peer_id=...` and, unless `--outbound-only`, this side's new token
once as `token=...`; `accept` reads the other box's create output (or just
its token line) on stdin, or from a file (`--token-file`, passed through
whole), finds the `token=` line itself, and never takes the token as an
argument. Every change leaves an audit row
(`peer.linked`, `peer.accepted`, `peer.revoked`) that names no token.

A watched box and the admin box that watches it, over ssh (each `cd` is the
box's stack directory: `install.sh` makes `./mantle` where it runs, or
`MANTLE_HOME`; prefix `sudo` where the ssh user is not in the docker group):

```sh
# On the admin box: an outbound-only, watched peer for the watched box.
ssh admin.example.com 'cd ~/mantle && scripts/peer-link.sh create \
    --name watched --url https://watched.example.com --outbound-only --watch'

# On the watched box: a status-only peer for the admin box. Its output goes
# straight into the admin box's accept, which takes the token= line: the
# token is never written to a file or shown.
ssh watched.example.com 'cd ~/mantle && scripts/peer-link.sh create \
    --name admin --url https://admin.example.com --status-only' \
  | ssh admin.example.com 'cd ~/mantle && scripts/peer-link.sh accept --peer watched'
```

The URL must be https (`--allow-http` takes plain http, for a local test
only). The watched box needs remote MCP on (Settings, MCP). `list` shows the
peers with no secret; `revoke --peer <id|name>` closes one, both ways.
The admin box grants the watched box nothing: its peer row is
outbound-only, and the watched box never accepts a token back.
