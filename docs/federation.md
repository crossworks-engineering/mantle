# Federation — Mantle-to-Mantle

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
| **Access scope** | Explicit per-node grants only (`peer_shares`). A peer sees nothing it wasn't granted — passports invisible unless shared. |
| **Consent** | Auto-answer within the granted scope; every cross-Mantle access is a trace row. |
| **Channel** | Both — an HTTP federation API for scoped data exchange, plus MCP tool access. |

## Trust model

Each peer relationship has **two tokens, one per direction**:

- **Outbound** (`mantle_peers.outbound_token_enc`) — the token *they* issued
  *us*, sealed AES-256-GCM (AAD = row id). We replay it as
  `Authorization: Bearer` when we call their API. Reversible because we must
  resend it.
- **Inbound** (`mantle_peers.inbound_token_hash`) — SHA-256 of the token *we*
  minted for *them*. We show its plaintext to the operator exactly once (to hand
  over), then keep only the hash. An inbound request is verified by hashing the
  presented bearer and matching the unique index — no reversible inbound secret
  at rest.

Revoking a peer (`status='revoked'` / `enabled=false`) instantly closes both
directions; rotating regenerates one side without disturbing the other.

## Schema (migration 0052)

- **`mantle_peer` node type** — the browsable, searchable face of a peer (like a
  `contact`, but for a system). Secrets never live in `node.data`.
- **`mantle_peers`** — connection record + sealed credentials, linked to its
  node via `node_id` (the telegram_accounts sealed-sidecar pattern).
- **`peer_shares`** — explicit per-node grants. The federation query returns the
  intersection of *(what the peer asked for)* ∩ *(nodes with an active grant for
  that peer)*. Revoke-don't-delete (partial unique on `(peer_id, node_id) WHERE
  revoked_at IS NULL`), so grant history stays auditable.

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

- **Phase 1 — foundation (DONE, 2026-05-29).** `mantle_peer` node type +
  `mantle_peers` + `peer_shares` tables + Drizzle schema. Migration 0052.
- **Phase 2 — data + crypto layer (DONE, 2026-05-29).** `@mantle/content/peers`:
  `createPeer` (seal outbound, mint+hash inbound), `verifyInboundToken`
  (constant-time, bumps `last_seen_at`), `getOutboundToken`, `grant`/
  `revokePeerShare`, `listPeerShares`, and `queryForPeer` (the scoped read —
  active grants ∩ request filters, no unscoped variant exists). Pure token
  helpers in `peers-crypto.ts` with 9 unit tests; full create→verify→grant→
  query→revoke→delete path verified live against the dev DB.
- **Phase 3 — HTTP federation API (DONE, 2026-05-29).** `POST
  /api/federation/query` + `GET /api/federation/node/[id]`, bearer-verified via
  `authenticatePeer` (the `/api/federation` prefix is a PUBLIC_PATH — it gates
  on the peer token, not the owner cookie). New `federation_request` trace kind
  (migration 0053) — every cross-Mantle read opens one under the answering
  owner, visible on `/traces`. Ungranted node → 404 (indistinguishable from
  not-found, so a peer can't probe). Verified live over loopback: auth (401 on
  no/wrong token), scope (type filter), node fetch, 404, and traces all
  correct. *Known refinement:* a `page`'s body lives in the `pages` sidecar, so
  `getNodeForPeer` currently returns the node's `data` (summary/tags) without
  the rich page body — fine for files/notes; page-body federation is a later
  pass.
- **Phase 4 — outbound tools (DONE, 2026-05-29).** Shared outbound client
  `@mantle/content/peers-client` (`queryPeer` / `getPeerNode` — resolve peer by
  name/id, sign with the sealed outbound token, fetch with a 15s timeout).
  Surfaced as three builtins (`peer_list` / `peer_query` / `peer_node_get`, in
  `@mantle/tools`) for Saskia AND three MCP tools (same names) for Claude
  Desktop/Code — both thin wrappers over the one client. Verified live via a
  self-loopback peer (outbound token = own inbound token, base_url =
  localhost:3000): query returns the granted node, type filter scopes, node
  fetch works, unknown peer errors. **Operator step:** the builtins seed into
  the `tools` table on the next `apps/agent` boot; grant `peer_query` /
  `peer_node_get` / `peer_list` to a responder at `/settings/agents` for Saskia
  to use them.
- **Phase 5 — UI (DONE, 2026-05-29).** `/settings/peers` master-detail (sidebar
  nav entry added): add a peer (paste their token → mint + reveal-once yours),
  enable/disable, rotate inbound token, update outbound token, delete; and a
  search-and-grant picker over your nodes (excludes branches/secrets/peer
  records) with revoke. Backed by `/api/peers` (+ `/[id]`, `/[id]/rotate`,
  `/[id]/shares`, `/nodes`). Mirrors the `/settings/keys` reveal-once pattern.

- **Phase 6 — semantic federation search (DONE, 2026-07-13).** `queryForPeer`
  now ranks with the same hybrid vector+FTS pipeline local search uses: the
  answering brain embeds the peer's query text in ITS OWN vector space
  (`embed(peer.ownerId, q)` in the route — the wire still carries text only,
  so the protocol is unchanged and older peers transparently get better
  ranking) and `searchNodes` runs with the active grant set as a hard
  id-allowlist (`ids` in `SearchOptions`) — the no-unscoped-variant invariant
  is preserved by construction. Embed failure degrades to FTS ranking, never a
  hard error. New passage endpoint `POST /api/federation/chunks`
  (`searchChunksForPeer` — vector search over `content_chunks` restricted to
  granted nodes) + outbound `searchPeerChunks` + `peer_search_chunks` builtin
  (in the `federation` tool group). Because chunks carry the full extracted
  text, passage search also closes most of the Phase 3 page-body gap: a peer
  can now read the relevant *sections* of a granted page. Older peers without
  the endpoint 404; the tool surfaces that as "use peer_query instead".

**Status: feature complete.** Two sovereign Mantles can now register each other,
exchange tokens via the UI, grant specific nodes, and query across the border
semantically — Saskia (or Claude) on one side, the scoped HTTP API on the
other, every read traced. Remaining nice-to-haves: full page-body federation
(Phase 3 note; passage search now covers the common case), a handshake/pairing
flow to auto-exchange tokens, and per-peer rate limiting.
