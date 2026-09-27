-- Member logins, session 7 audit fixes.
--
-- D3: an upload ledger per personal space. The daily upload cap summed the
-- files that still exist, so upload, delete, upload again reset it. Each
-- member upload now leaves a row here (bytes, time); the cap sums the last
-- 24 hours of rows. The space role may insert and read its own space's rows
-- only: no update or delete policy, so a member cannot erase the ledger.
CREATE TABLE IF NOT EXISTS "public"."space_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "public"."spaces"("id") ON DELETE CASCADE,
  "bytes" bigint NOT NULL CHECK ("bytes" >= 0),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "space_uploads_space_time_idx"
  ON "public"."space_uploads" ("space_id", "created_at");
--> statement-breakpoint
ALTER TABLE "public"."space_uploads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "space_uploads_space_read" ON "public"."space_uploads";
--> statement-breakpoint
CREATE POLICY "space_uploads_space_read" ON "public"."space_uploads" FOR SELECT
  TO mantle_view_space
  USING ("space_id" = "public"."mantle_space_id"());
--> statement-breakpoint
DROP POLICY IF EXISTS "space_uploads_space_insert" ON "public"."space_uploads";
--> statement-breakpoint
CREATE POLICY "space_uploads_space_insert" ON "public"."space_uploads" FOR INSERT
  TO mantle_view_space
  WITH CHECK ("space_id" = "public"."mantle_space_id"());
--> statement-breakpoint
-- S7: the owner's comments channel (0149) carried personal items too: the
-- owner SSE got a member's personal node ids and the timing of their threads.
-- Notify only for comments on BRAIN nodes. SECURITY DEFINER so the node
-- lookup is not hidden by the writer's row rules; the search_path is pinned.
create or replace function "public"."notify_comments_changed"()
  returns trigger language plpgsql security definer
  set search_path = pg_catalog, public as $$
declare
  r record;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if exists (select 1 from "public"."nodes" n
              where n.id = r.node_id and "public"."mantle_is_brain_space"(n.owner_id)) then
    perform pg_notify(
      'comments_changed',
      json_build_object('ownerId', r.owner_id, 'nodeId', r.node_id)::text
    );
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;
--> statement-breakpoint
-- S10: mantle_personal_space(login) maps a login to its space. It is for the
-- my-space agent tools, which run in an agent turn at a limited level; the
-- personal-space role and any other role have no use for it.
REVOKE EXECUTE ON FUNCTION "public"."mantle_personal_space"(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_personal_space"(uuid)
  TO mantle_view_team, mantle_view_client, mantle_view_public;
