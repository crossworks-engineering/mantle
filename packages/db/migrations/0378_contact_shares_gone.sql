-- Contact shares are gone (owner, 2026-11-17, Sync service plan v3, decision
-- "Contact share codes"): logins with workspaces and password shares replace
-- them. A contact share was one item shared with one contact, opened with the
-- item's link plus the contact's code (0214). Contacts stay: they are the
-- email gate. Open links stay as they are.
--
-- 1. Every contact share row is DELETED, live or revoked. Kept, a row with its
--    contact_id dropped would read as an open link, and a live one would open
--    with no code. Deleting a share cascades nothing else (only the dropped
--    share_access_log named it).
-- 2. contact_share_codes and share_access_log (only contact shares wrote it;
--    reaped at 90 days) are dropped with their triggers and indexes.
-- 3. shares: the contact check trigger, the contact indexes, can_write and
--    contact_id go; the one live link per item index is 0214's
--    shares_node_open_uq without its contact clause, under its old name
--    shares_node_active_uq. No duplicate is possible: the open index already
--    held one live link per item, and the contact rows are gone.
-- 4. The definers of the contact acts (0293, 0308, 0310) are dropped.
-- 5. The contact edit check (0294): mantle_edit_check_item_triggers() makes
--    the read-only refusal only; every mantle_edit_check_contact trigger (the
--    0294 loop's and those of 0302, 0332, 0355) and their function go.
-- 6. mantle_set_actor (0275) refuses a contact actor: there is none.
-- 7. Two bridge functions (0261, 0262), the edit check trigger (0281) and the
--    client-sourced gate (0293) lose their contact clauses, so no live body
--    names a dropped column. Grants stay (CREATE OR REPLACE).
--
-- Re-runnable. Rollback: packages/db/rollback/0378_contact_shares_gone.revert.sql
-- puts the empty tables and columns back for an older image; the rows do not
-- come back.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- 1. The contact share rows.
DO $$
DECLARE
  n bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'shares' AND column_name = 'contact_id') THEN
    EXECUTE 'DELETE FROM "public"."shares" WHERE "contact_id" IS NOT NULL';
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RAISE NOTICE '0378: % contact share rows deleted', n;
END $$;
--> statement-breakpoint

-- 2. The two tables (their triggers and indexes go with them).
DROP TABLE IF EXISTS "public"."share_access_log";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."contact_share_codes";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_contact_share_code_check"();
--> statement-breakpoint

-- 3. shares.
DROP TRIGGER IF EXISTS "shares_contact_check_trg" ON "public"."shares";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_contact_share_check"();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_active_uq"
  ON "public"."shares" ("node_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."shares_node_open_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."shares_node_contact_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."shares_contact_idx";
--> statement-breakpoint
ALTER TABLE "public"."shares" DROP CONSTRAINT IF EXISTS "shares_can_write_ck";
--> statement-breakpoint
ALTER TABLE "public"."shares" DROP COLUMN IF EXISTS "can_write";
--> statement-breakpoint
ALTER TABLE "public"."shares" DROP COLUMN IF EXISTS "contact_id";
--> statement-breakpoint

-- 4. The contact act definers, by name (every signature).
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND p.proname IN ('mantle_contact_sharing_set', 'mantle_contact_sharing_rows',
                                'mantle_contact_shares_revoke_all', 'mantle_contact_shares_revoke_rows',
                                'mantle_share_with_contacts', 'mantle_share_with_contacts_rows',
                                'mantle_share_contact_write_set', 'mantle_contact_sharing') LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;
--> statement-breakpoint

-- 5. The contact edit check. The maker keeps 0294's read-only part only.
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_item_triggers"()
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  t regclass;
  n integer := 0;
BEGIN
  -- Every item table but the heads rows (a heads lock is not a change).
  FOR t IN SELECT c.tbl FROM "public"."mantle_actor_check_tables"() c
            WHERE c.tbl <> 'public.node_acl_head'::regclass LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER mantle_edit_check_ro BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT WHEN (current_setting(''mantle.write_mode'', true) = ''ro'') '
      'EXECUTE FUNCTION "public"."mantle_edit_ro_stmt"()', t);
    n := n + 1;
  END LOOP;
  PERFORM "public"."mantle_edit_check_triggers"("public"."mantle_check_box_mode"('edit_check') <> 'off', 50);
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_item_triggers"() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT t.tgrelid::regclass AS tbl FROM pg_trigger t
            WHERE t.tgname = 'mantle_edit_check_contact' AND NOT t.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS mantle_edit_check_contact ON %s', r.tbl);
  END LOOP;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS "public"."mantle_edit_contact_stmt"();
--> statement-breakpoint

-- 6. The actor of a transaction: no contact actor any more.
CREATE OR REPLACE FUNCTION "public"."mantle_set_actor"(actor text, write_mode text, check_mode text DEFAULT '')
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF actor IS NULL OR actor !~ '^(login:(rw|ro|owner):[0-9a-f-]{36}|assistant:([0-9a-f-]{36}|none)|link|system:[a-z][a-z0-9:._/@-]{0,119}|peer:([0-9a-f-]{36}|none))$' THEN
    RAISE EXCEPTION 'mantle_set_actor: not an actor: %', left(coalesce(actor, 'null'), 60)
      USING ERRCODE = '22023';
  END IF;
  IF write_mode NOT IN ('rw', 'ro') THEN
    RAISE EXCEPTION 'mantle_set_actor: write mode must be rw or ro' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('mantle.actor', actor, true);
  PERFORM set_config('mantle.write_mode', write_mode, true);
  IF check_mode IN ('warn', 'on') THEN
    PERFORM set_config('mantle.actor_check', check_mode, true);
  END IF;
END
$$;
--> statement-breakpoint

-- 7. The bodies that named the dropped column.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_links_diff"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH live AS (
    SELECT s."id", s."owner_id", s."node_id", s."settings"
      FROM "public"."shares" s
     WHERE s."revoked_at" IS NULL
       AND (s."expires_at" IS NULL OR s."expires_at" > now())
       AND coalesce(s."settings"->>'mode', 'public') <> 'team'
  ),
  served AS (
    SELECT l."id" AS share_id, l."owner_id", l."node_id", lower(v) AS served_id
      FROM live l
     CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(l."settings"->'served') = 'array' THEN l."settings"->'served'
            ELSE '[]'::jsonb END) v
  )
  SELECT 'reach-fail', 'links', 'serve an item not served before', count(*)
    FROM served x
   WHERE x.served_id <> lower(x."node_id"::text)
     AND NOT EXISTS (
       SELECT 1 FROM "public"."nodes" n
        WHERE n."id"::text = x.served_id AND n."owner_id" = x."owner_id"
          AND (n."audience"::text = 'public' OR coalesce(n."inherited_level"::text = 'public', false)
               OR coalesce(n."embedded_level"::text = 'public', false)))
  HAVING count(*) > 0
  UNION ALL
  SELECT 'reach', 'links', 'live open links', count(*) FROM live
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_ws_links_diff"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_link_served_fill"()
  RETURNS TABLE ("step" text, "n" bigint)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  c bigint;
BEGIN
  -- 1. Open links on an item frozen at client: never served, now retired.
  UPDATE "public"."shares" x
     SET "revoked_at" = now(), "settings" = x."settings" || '{"retired":"client"}'::jsonb
    FROM "public"."nodes" n
   WHERE n."id" = x."node_id" AND x."revoked_at" IS NULL
     AND n."audience"::text = 'client';
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'open links on client items, retired', c;

  -- 2. The served list of every other live open link.
  UPDATE "public"."shares" x
     SET "settings" = x."settings"
                      || jsonb_build_object('served', to_jsonb("public"."mantle_link_served_by_levels"(x."id")))
   WHERE x."revoked_at" IS NULL
     AND NOT (x."settings" ? 'served');
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'open links given a served list', c;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_link_served_fill"() FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_edit_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  need text := TG_ARGV[0];
  item_col text := TG_ARGV[1];
  via text := coalesce(TG_ARGV[2], '');
  mode text := coalesce(TG_ARGV[3], '');
  items uuid[] := '{}';
  item uuid;
  node uuid;
  bad text;
  ok boolean;
BEGIN
  -- A cascade's inner rows follow the statement that was checked.
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF mode LIKE 'strip%' THEN
    -- A new node (INSERT) carrying values only the brain sets: the derived
    -- keys of data and the columns after 'strip:' (an embedding). On, they
    -- are dropped (the extractor writes them again from the item itself, so
    -- a copy keeps working); warn reports them; the write runs.
    IF "public"."mantle_edit_refuses"('INSERT on nodes: values only the brain sets (dropped when on)') THEN
      NEW := jsonb_populate_record(NEW,
        jsonb_build_object('data', coalesce(NEW."data", '{}'::jsonb) - "public"."mantle_node_derived_keys"())
        || coalesce((SELECT jsonb_object_agg(c, NULL)
                       FROM unnest(string_to_array(nullif(split_part(mode, ':', 2), ''), ',')) AS c), '{}'::jsonb));
    END IF;
    RETURN NEW;
  END IF;

  IF mode = 'keys' THEN
    -- nodes.data: a derived key set or changed (cleared is fine).
    SELECT k INTO bad FROM unnest("public"."mantle_node_derived_keys"()) AS k
     WHERE coalesce(NEW."data", '{}'::jsonb) ? k
       AND (coalesce(NEW."data", '{}'::jsonb) -> k) IS DISTINCT FROM (coalesce(OLD."data", '{}'::jsonb) -> k)
     LIMIT 1;
    IF bad IS NOT NULL THEN
      PERFORM "public"."mantle_edit_refuse"(
        format('UPDATE on nodes: data.%s, a key only the brain sets', bad), 'no_edit',
        'not allowed to change this item: only the brain sets that value');
    END IF;
    RETURN NEW;
  END IF;

  IF need = 'system' THEN
    -- The trigger's WHEN found a change to a column only the brain writes.
    PERFORM "public"."mantle_edit_refuse"(
      format('%s on %s: a column only the brain writes', TG_OP, TG_TABLE_NAME), 'no_edit',
      'not allowed to change this item: only the brain sets that value');
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- The row's item, before and after (a row moved to another item needs
  -- both).
  IF item_col = 'self' THEN
    IF TG_OP <> 'INSERT' THEN items := items || OLD."id"; END IF;
    IF TG_OP <> 'DELETE' THEN items := items || NEW."id"; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN items := items || ((to_jsonb(OLD) ->> item_col)::uuid); END IF;
    IF TG_OP <> 'DELETE' THEN items := items || ((to_jsonb(NEW) ->> item_col)::uuid); END IF;
  END IF;
  FOREACH item IN ARRAY ARRAY(SELECT DISTINCT x FROM unnest(items) AS x WHERE x IS NOT NULL) LOOP
    node := item;
    IF via = 'recall_maps' THEN
      SELECT m."node_id" INTO node FROM "public"."recall_maps" m WHERE m."id" = item;
      CONTINUE WHEN node IS NULL;
    ELSIF via <> '' THEN
      RAISE EXCEPTION 'mantle_edit_check_trg: unknown via %', via USING ERRCODE = '22023';
    END IF;
    ok := "public"."mantle_check_item"(node, need);
    -- NULL: the item is gone (its foreign key, or the row rule, decides).
    IF ok IS NOT NULL AND NOT ok THEN
      PERFORM "public"."mantle_edit_refuse"(
        format('%s on %s: no %s of the item', TG_OP, TG_TABLE_NAME, need),
        CASE WHEN NOT coalesce("public"."mantle_check_item"(node, 'read'), true) THEN 'no_read'
             WHEN need = 'appdata' AND "public"."mantle_check_item"(node, 'edit') THEN 'read_only'
             ELSE 'no_edit' END,
        CASE
          WHEN TG_TABLE_NAME = 'shares' THEN 'not allowed to share this item'
          WHEN need = 'appdata' THEN 'not allowed to write this app''s data'
          WHEN TG_TABLE_NAME = 'apps' AND need = 'manage'
            THEN 'not allowed to change this app''s code: a Moderator of its workspace does'
          WHEN TG_TABLE_NAME = 'apps' AND need = 'admin'
            THEN 'not allowed to change this app''s settings: an Admin user does'
          WHEN need = 'manage' THEN 'not allowed to change this item: a Moderator of its workspace does'
          ELSE 'not allowed to change this item' END);
    END IF;
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_trg"() FROM PUBLIC;
--> statement-breakpoint
-- (0293) The client-sourced gate: an open link is every live share now.
CREATE OR REPLACE FUNCTION "public"."mantle_client_sourced_gate"(
  owner uuid, want_nodes uuid[], want_apps uuid[], want_paths text[],
  want_agents text[], want_groups text[], want_tools text[])
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  cws uuid[];
  wanted uuid[];
  hits integer;
  p text;
BEGIN
  cws := "public"."mantle_client_ws"(owner);
  wanted := ARRAY(
    SELECT DISTINCT v FROM unnest(
      coalesce(want_nodes, '{}') || coalesce(want_apps, '{}')
      || coalesce((SELECT array_agg(e."table_node_id") FROM "public"."app_table_exports" e
                    WHERE e."owner_id" = owner AND e."app_node_id" = ANY (want_apps)), '{}')) v);
  IF cardinality(wanted) > 0 THEN
    SELECT count(*) INTO hits FROM "public"."nodes" n
     WHERE n."owner_id" = owner AND n."id" = ANY (wanted);
    IF hits < cardinality(wanted) THEN
      RETURN 'its target is not an item of this brain';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "public"."nodes" n
       WHERE n."owner_id" = owner AND n."id" = ANY (wanted)
         AND (coalesce(n."read_ws" && cws, false)
              OR EXISTS (
                SELECT 1 FROM "public"."shares" s
                 WHERE s."owner_id" = owner AND s."revoked_at" IS NULL
                   AND (s."expires_at" IS NULL OR s."expires_at" > now())
                   AND coalesce(s."settings" ->> 'mode', 'public') <> 'team'
                   AND (s."node_id" = n."id"
                        OR coalesce(s."settings" -> 'served', '[]'::jsonb) ? lower(n."id"::text))))) THEN
      RETURN 'it writes into an item clients or the public read';
    END IF;
  END IF;
  FOREACH p IN ARRAY coalesce(want_paths, '{}') LOOP
    IF EXISTS (
      SELECT 1 FROM "public"."nodes" n
       WHERE n."owner_id" = owner AND n."type" = 'branch' AND n."path" @> p::ltree
         AND coalesce(n."read_ws" && cws, false)) THEN
      RETURN 'it puts something in a folder shared with clients';
    END IF;
  END LOOP;
  IF cardinality(want_agents) > 0 AND EXISTS (
    SELECT 1 FROM "public"."agents" g
     WHERE g."owner_id" = owner AND g."slug" = ANY (want_agents) AND g."workspace_id" = ANY (cws)) THEN
    RETURN 'it changes an agent clients talk to';
  END IF;
  IF (cardinality(want_groups) > 0 OR cardinality(want_tools) > 0) AND EXISTS (
    SELECT 1 FROM "public"."tool_groups" tg
      JOIN "public"."agents" g ON g."owner_id" = tg."owner_id" AND tg."slug" = ANY (g."tool_group_slugs")
     WHERE tg."owner_id" = owner
       AND ((cardinality(want_groups) > 0 AND tg."slug" = ANY (want_groups))
            OR (cardinality(want_tools) > 0 AND tg."tool_slugs" && want_tools))
       AND g."workspace_id" = ANY (cws)) THEN
    RETURN 'it changes a tool group an agent clients talk to holds';
  END IF;
  RETURN NULL;
END
$$;
