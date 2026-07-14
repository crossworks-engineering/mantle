-- Category peer-shares: standing per-TYPE grants alongside the per-node
-- peer_shares. A scope row means "this peer may read every one of my nodes of
-- this type, including nodes created later" — resolved at query time, never
-- materialized into id lists. Same revoke-don't-delete shape as peer_shares.
-- Allowed types are enforced in the app layer (PEER_SHAREABLE_TYPES): pages,
-- notes, files, contacts, tables, events, tasks — never secrets, mantle_peer,
-- email, or journal.

CREATE TABLE "peer_share_scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "peer_id" uuid NOT NULL,
  "node_type" "node_type" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "peer_share_scopes" ADD CONSTRAINT "peer_share_scopes_peer_id_mantle_peers_id_fk"
  FOREIGN KEY ("peer_id") REFERENCES "public"."mantle_peers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "peer_share_scopes_peer_idx" ON "peer_share_scopes" USING btree ("peer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "peer_share_scopes_peer_type_active_uq" ON "peer_share_scopes"
  USING btree ("peer_id", "node_type") WHERE "peer_share_scopes"."revoked_at" is null;
