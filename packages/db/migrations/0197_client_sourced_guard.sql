-- Client logins C5 audit fixes: the lowering guard (packages/tools/src/
-- client-sourced.ts and client-sourced-rules.ts; docs/client-logins.md
-- section 8).
--
-- 1. client_sourced_nodes: a node a staff turn CREATED after it read text a
--    client wrote (page_from_note, page_split, note_create, table_from_text
--    and the like). The copy carries the mark, so a later turn that reads it
--    is marked as if it read the client's text. Written only by the tool loop
--    (as the system, never by a tool or the model), removed with the node.
--
-- 2. conversation_taints: the mark on a conversation (an agent's owner
--    conversation, or one login's conversation with an agent), so the next
--    turn of the same conversation (which holds the client's text only in its
--    history) is still marked. The last client-sourced read's time; a reader
--    ignores a row older than 24 hours. One row per conversation, so the
--    table stays small without a sweep. No trigger, no worker.
--
-- 3. client_request_filings: one row per client request filed by
--    client_request_create, a ledger like space_submissions (0194): the daily
--    cap counts it, so deleting a request never gives the quota back.
--
-- All three are admin level: no viewer role reads them (the access matrix
-- grants nothing), the app writes them as the system.
--
-- Rollback: the previous release never reads these tables; it counts client
-- requests from the tasks again and forgets the marks.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."client_sourced_nodes" (
  "node_id" uuid PRIMARY KEY NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "owner_id" uuid NOT NULL,
  "via" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."conversation_taints" (
  "owner_id" uuid NOT NULL,
  "conversation_key" text NOT NULL,
  "via" text NOT NULL,
  "tainted_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("owner_id", "conversation_key")
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."client_request_filings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "login_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "thread_message_id" text,
  "task_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_request_filings_login_time_idx"
  ON "public"."client_request_filings" ("login_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "client_request_filings_message_idx"
  ON "public"."client_request_filings" ("thread_message_id")
  WHERE "thread_message_id" IS NOT NULL;
