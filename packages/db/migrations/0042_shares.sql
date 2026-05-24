-- Read-only public share links. One row per link; `token` is the URL. The
-- public surface resolves a node strictly by an active token (not revoked, not
-- expired). One active link per node is enforced by a partial unique index on
-- node_id WHERE revoked_at IS NULL. See docs/sharing.md.

CREATE TABLE IF NOT EXISTS "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_type" "node_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_token_uq" ON "shares" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_owner_idx" ON "shares" USING btree ("owner_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_active_uq" ON "shares" USING btree ("node_id") WHERE "revoked_at" IS NULL;
