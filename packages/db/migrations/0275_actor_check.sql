-- Workspaces arch A2a (plan v2 page fcc4aee4, sections 4 and 20.3): every
-- statement carries its actor, warn only.
--
--  - mantle.actor names who a write runs as: login:rw:<id>, login:ro:<id>,
--    login:owner:<id>, assistant:<id|none>, link, contact:rw|ro,
--    system:<reason>, peer:<id|none>. mantle.write_mode is rw or ro. Both
--    are transaction-local and set together by mantle_set_actor, which only
--    packages/db calls (the actor-setters-in-db-only lint). This is not a
--    secret: any role can set_config a mantle.* setting (20.3 item 6). The
--    protection is the lint, the runtime role (A9) and the read predicate
--    on the write role (20.1).
--  - mantle.actor_check (off, warn, on) is read like mantle.heads_check
--    (0241): the box setting from the catalog, raised by a session setting,
--    never lowered. The box default is off. In A2a 'on' still only logs:
--    refusing a statement with no actor is A2b.
--  - A statement on an item table with no actor raises a NOTICE that starts
--    with "mantle actor miss:". It writes nothing in the transaction: an
--    INSERT there would assign a transaction id before mantle_lock_heads
--    (20.3 item 7). The app's pool reads the notice and logs the miss row
--    later, on another connection (mantle_actor_miss_log), at most 100 rows
--    an hour per check, as the heads misses are capped.
--  - mantle_operator_actor('reason') names an operator's psql session as
--    system:operator:<reason> (docs/update-prod.md).
--
-- Nothing is refused and no row changes. Re-runnable.

CREATE TABLE IF NOT EXISTS "public"."actor_check_misses" (
  "id" bigserial PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  -- 'ts': the app found no actor bound when it sent a statement;
  -- 'sql': a write trigger found no mantle.actor on the transaction.
  "source" text NOT NULL,
  "check_name" text NOT NULL,
  "actor" text NOT NULL DEFAULT '',
  "detail" text NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actor_check_misses_check_at_idx"
  ON "public"."actor_check_misses" ("check_name", "at");
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."actor_check_misses" FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantle_view_user') THEN
    REVOKE ALL ON TABLE "public"."actor_check_misses" FROM "mantle_view_user";
  END IF;
END $$;
--> statement-breakpoint

-- The mode (see mantle_heads_check_mode, 0241): the box setting from the
-- catalog, so a session cannot lower it; a session may only make it stricter.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_mode"()
  RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  box text;
  sess text := coalesce(nullif(current_setting('mantle.actor_check', true), ''), 'off');
  rank_box int;
  rank_sess int;
BEGIN
  SELECT split_part(c, '=', 2) INTO box
    FROM pg_db_role_setting d, unnest(d.setconfig) AS c
   WHERE d.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND d.setrole = 0 AND c LIKE 'mantle.actor_check=%'
   LIMIT 1;
  box := coalesce(box, 'off');
  rank_box := CASE box WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  rank_sess := CASE sess WHEN 'warn' THEN 1 WHEN 'on' THEN 2 ELSE 0 END;
  RETURN CASE greatest(rank_box, rank_sess) WHEN 0 THEN 'off' WHEN 2 THEN 'on' ELSE 'warn' END;
END
$$;
--> statement-breakpoint

-- The actor of this transaction. Only packages/db calls it. `check_mode`
-- raises the check for this transaction (a test process in warn on a box
-- that is off); '' leaves it.
CREATE OR REPLACE FUNCTION "public"."mantle_set_actor"(actor text, write_mode text, check_mode text DEFAULT '')
  RETURNS void LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF actor IS NULL OR actor !~ '^(login:(rw|ro|owner):[0-9a-f-]{36}|assistant:([0-9a-f-]{36}|none)|link|contact:(rw|ro)|system:[a-z][a-z0-9:._/@-]{0,119}|peer:([0-9a-f-]{36}|none))$' THEN
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

-- An operator's hand psql (docs/update-prod.md): the session runs as
-- system:operator:<reason> until it ends.
CREATE OR REPLACE FUNCTION "public"."mantle_operator_actor"(reason text)
  RETURNS text LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF reason IS NULL OR reason !~ '^[a-z][a-z0-9._/@-]{0,80}$' THEN
    RAISE EXCEPTION 'mantle_operator_actor: give a short reason in lower case, such as fix-slug'
      USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('mantle.actor', 'system:operator:' || reason, false);
  PERFORM set_config('mantle.write_mode', 'rw', false);
  RETURN 'system:operator:' || reason;
END
$$;
--> statement-breakpoint

-- Log one miss row, on its own connection after the statement that missed
-- (the app's pool calls it; never inside the missing transaction). At most
-- 100 rows an hour per check.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_miss_log"(source text, check_name text, actor text, detail text)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM (SELECT 1 FROM "public"."actor_check_misses" m
                             WHERE m."check_name" = mantle_actor_miss_log.check_name
                               AND m."at" > now() - interval '1 hour' LIMIT 100) x) < 100 THEN
    INSERT INTO "public"."actor_check_misses" ("source", "check_name", "actor", "detail")
      VALUES (left(source, 10), left(check_name, 200), left(coalesce(actor, ''), 200),
              left(coalesce(detail, ''), 500));
  END IF;
END
$$;
--> statement-breakpoint

-- The SQL check: a write on an item table with no actor. Statement level and
-- the cheap test first, so a statement with an actor pays one setting read.
-- A cascade's inner statements are skipped (their source is checked).
-- Writes nothing: a NOTICE, once per transaction and table.
CREATE OR REPLACE FUNCTION "public"."mantle_actor_check_stmt"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = "public", pg_temp AS $$
DECLARE
  seen_key text := 'mantle.actor_missed_' || TG_TABLE_NAME;
BEGIN
  IF coalesce(current_setting('mantle.actor', true), '') <> '' OR pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF "public"."mantle_actor_check_mode"() = 'off' THEN RETURN NULL; END IF;
  IF coalesce(current_setting(seen_key, true), '') = TG_OP THEN RETURN NULL; END IF;
  PERFORM set_config(seen_key, TG_OP, true);
  RAISE NOTICE 'mantle actor miss: % on %', TG_OP, TG_TABLE_NAME;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'nodes', 'pages', 'draws', 'tables', 'apps', 'app_databases', 'recall_maps',
    'recall_nodes', 'recall_revisions', 'node_embeds', 'app_table_exports', 'shares',
    'node_snapshots', 'item_grants', 'peer_shares', 'contact_share_codes', 'node_comments'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS mantle_actor_check ON public.%I', t);
      EXECUTE format(
        'CREATE TRIGGER mantle_actor_check BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH STATEMENT EXECUTE FUNCTION public.mantle_actor_check_stmt()', t);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint

-- The setters are for the app's own pool and the operator, never the
-- workspace role (functions are open to PUBLIC by default).
REVOKE ALL ON FUNCTION "public"."mantle_set_actor"(text, text, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_operator_actor"(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_actor_miss_log"(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mantle_view_user') THEN
    REVOKE ALL ON FUNCTION "public"."mantle_set_actor"(text, text, text) FROM "mantle_view_user";
    REVOKE ALL ON FUNCTION "public"."mantle_operator_actor"(text) FROM "mantle_view_user";
    REVOKE ALL ON FUNCTION "public"."mantle_actor_miss_log"(text, text, text, text) FROM "mantle_view_user";
  END IF;
END $$;
