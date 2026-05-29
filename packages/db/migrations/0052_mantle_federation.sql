-- Mantle-to-Mantle federation. A "peer" is another sovereign single-user
-- Mantle instance we exchange SCOPED data with — not multi-tenancy; two
-- separate brains negotiating at the border. Auth is a sealed per-peer bearer
-- token; access is explicit per-node grants (peer_shares); every cross-Mantle
-- read is traced. See docs/federation.md.

-- Browsable peer record node type. The node (type='mantle_peer') is the
-- searchable face; the sealed tokens live in mantle_peers, never in node.data.
ALTER TYPE "node_type" ADD VALUE IF NOT EXISTS 'mantle_peer';
--> statement-breakpoint

-- Connection record + sealed credentials, one row per peer.
CREATE TABLE IF NOT EXISTS "mantle_peers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "display_name" text NOT NULL,
  -- Root of the peer's federation API, e.g. https://her-mantle.example.com
  "base_url" text NOT NULL,
  -- Token THEY issued US, sealed AES-256-GCM; sent as Bearer when we call them.
  "outbound_token_enc" bytea NOT NULL,
  "outbound_token_version" integer NOT NULL DEFAULT 1,
  -- SHA-256 (hex) of the token WE minted for THEM. Lets us verify their inbound
  -- requests by hashing the presented bearer and matching — no reversible
  -- secret stored for the inbound direction.
  "inbound_token_hash" text NOT NULL,
  -- 'pending' | 'active' | 'revoked'
  "status" text NOT NULL DEFAULT 'active',
  "enabled" boolean NOT NULL DEFAULT true,
  "last_contacted_at" timestamptz,
  "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mantle_peers_owner_idx" ON "mantle_peers" ("owner_id");
--> statement-breakpoint
-- Inbound verification hits this index: hash the presented bearer, look it up.
CREATE UNIQUE INDEX IF NOT EXISTS "mantle_peers_inbound_hash_uq" ON "mantle_peers" ("inbound_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mantle_peers_node_uq" ON "mantle_peers" ("node_id");
--> statement-breakpoint

-- Explicit per-node grants: which of MY nodes a given peer may read. The
-- federation query is the intersection of (peer's request) ∩ (active grants).
CREATE TABLE IF NOT EXISTS "peer_shares" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "peer_id" uuid NOT NULL REFERENCES "mantle_peers"("id") ON DELETE CASCADE,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "node_type" "node_type" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "peer_shares_peer_idx" ON "peer_shares" ("peer_id");
--> statement-breakpoint
-- One active grant per (peer, node); revoking sets revoked_at, re-granting
-- mints a fresh row (mirrors the public `shares` partial-unique pattern).
CREATE UNIQUE INDEX IF NOT EXISTS "peer_shares_peer_node_active_uq"
  ON "peer_shares" ("peer_id","node_id") WHERE "revoked_at" IS NULL;
