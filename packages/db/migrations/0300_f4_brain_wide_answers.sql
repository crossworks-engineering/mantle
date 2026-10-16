-- F4 fix round 2 (docs/actors.md, "F4 fix round 2"): two definers that
-- answer the brain-wide questions a write asks in the caller's scope after
-- its item check, where the scope sees only the rows it reads. Each answers
-- yes or no, or a number, never a row.
--
-- 1. mantle_name_taken(what, owner, name, except_id): whether `name` is
--    taken brain-wide, rows the caller cannot read included (a write must
--    never meet a hidden row's unique index as a 500, nor reuse a name a
--    hidden row answers to):
--     - 'folder': a folder (a branch) at the path `name` (the unique index
--       nodes_branch_owner_path_uq): a folder copy's or move's destination;
--     - 'recall-slug': a Recall map answers to the slug `name`, now or as a
--       former slug (agents and skills remember those), the map `except_id`
--       left out: a new map's slug, a slug change, a revision restore;
--     - 'formula-spec': a formula whose spec id is `name` (the formula
--       library's seed: present is present, whoever reads it).
--    Any other `what` answers no. Not held to the rows the scope reads: its
--    whole point is a name a row the caller cannot read holds (as
--    mantle_file_name_taken, 0293). In a scope only the brain's own.
-- 2. mantle_snapshot_bytes(owner, manual_only, member, login): the bytes the
--    history copies take (node_snapshots.db_bytes), the brain's budget
--    (APP_SNAPSHOT_MAX_MB): every copy, or the manual ones only; with
--    `member` the members' (true) or everyone else's (false) only; with
--    `login` that login's only. A number for the budget's refusal, never a
--    row; the scope reads only the history of the items it reads, so the
--    sum there was short. In a scope only the brain's own.
--
-- Every definer: a fixed search_path (pg_temp last), no right for PUBLIC,
-- EXECUTE for the workspace role (the write and runtime roles follow it,
-- as for 0293's) and the public demo's reader when it exists.
--
-- No row changes. Re-runnable.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_name_taken"(what text, owner uuid, name text, except_id uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
     AND CASE what
       WHEN 'folder' THEN EXISTS (
         SELECT 1 FROM "public"."nodes" n
          WHERE n."owner_id" = owner AND n."type" = 'branch' AND n."path"::text = name)
       WHEN 'recall-slug' THEN EXISTS (
         SELECT 1 FROM "public"."recall_maps" m
          WHERE m."owner_id" = owner
            AND (except_id IS NULL OR m."id" <> except_id)
            AND (m."slug" = name OR name = ANY (m."former_slugs")))
       WHEN 'formula-spec' THEN EXISTS (
         SELECT 1 FROM "public"."nodes" n
          WHERE n."owner_id" = owner AND n."type" = 'formula'
            AND n."data" -> 'spec' ->> 'id' = name)
       ELSE false
     END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_name_taken"(text, uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_name_taken"(text, uuid, text, uuid) TO "mantle_view_user";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_bytes"(owner uuid, manual_only boolean, member boolean, login uuid)
  RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT coalesce(sum(s."db_bytes"), 0)::bigint
    FROM "public"."node_snapshots" s
   WHERE s."owner_id" = owner
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
     AND (NOT manual_only OR s."trigger" = 'manual')
     AND (member IS NULL OR (s."actor" = 'member') = member)
     AND (login IS NULL OR s."actor_login_id" = login)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_snapshot_bytes"(uuid, boolean, boolean, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_snapshot_bytes"(uuid, boolean, boolean, uuid) TO "mantle_view_user";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_name_taken"(text, uuid, text, uuid) TO demo_reader;
    GRANT EXECUTE ON FUNCTION "public"."mantle_snapshot_bytes"(uuid, boolean, boolean, uuid) TO demo_reader;
  END IF;
END
$$;
