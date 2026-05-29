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
  Saskia: "ask Jason's Mantle for           POST /api/federation/query
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
- **Phase 4 — outbound tools.** `peer_query` / `peer_list` builtins (the
  researcher/Remy delegation pattern) + MCP equivalents.
- **Phase 5 — UI.** `/settings/peers` master-detail: add a peer, exchange
  tokens, manage `peer_shares`, enable/revoke.
