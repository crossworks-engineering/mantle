-- Comments on content nodes — the discussion thread on a task's detail pane
-- (tasks first; node-generic so pages/notes can adopt it without DDL).
--
-- One row per comment, flat and chronological. `author_kind` carries the three
-- voices with the same vocabulary as forum_posts: 'owner' (an admin login —
-- login_id), 'member' (a contact holding a team token — contact_id), 'agent'
-- (an assistant — agent_id). The author FKs go SET NULL on deletion and
-- `author_name` is the durable snapshot: a comment outlives its author.
-- `node_id` cascades — deleting the task deletes its thread (same reaper
-- philosophy as the mentioned_in/facts triggers: pure SQL, no LLM).

CREATE TABLE IF NOT EXISTS "node_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"author_kind" text NOT NULL,
	"login_id" uuid,
	"contact_id" uuid,
	"agent_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "node_comments" ADD CONSTRAINT "node_comments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "node_comments" ADD CONSTRAINT "node_comments_login_id_users_id_fk" FOREIGN KEY ("login_id") REFERENCES "auth"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "node_comments" ADD CONSTRAINT "node_comments_contact_id_nodes_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "node_comments" ADD CONSTRAINT "node_comments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "node_comments_node_idx" ON "node_comments" ("node_id","created_at");
