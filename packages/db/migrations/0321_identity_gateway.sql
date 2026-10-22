-- The identity gateway: one small set of SQL readers for the settings that
-- name who is acting (the login, the scope, the workspaces, the acting
-- login, the actor, the create-stamp workspaces). The class rule (plan v3.2
-- S7b part b2 round 13): a session sets these with set_config itself, so a
-- function that read them directly trusted whatever the session said. Two
-- re-audits found definers steered that way by the narrow system role
-- (a member made Moderator through a self-set login and workspace; an
-- assistant deleted through a self-set acting login).
--
-- 1. mantle_identity_narrow(): the session's own role (0317's test: the
--    role it SET, else its login; a definer changes current_user, never
--    this) is the narrow system role.
-- 2. The readers. On the narrow role each answers no identity: no login,
--    no scope, no workspaces, no acting login, no create-stamp workspace,
--    and the actor 'system:narrow' (the role's own name, never a reason the
--    session set). The narrow role is system work with no user identity, so
--    every definer that needs a login refuses it by construction. Off the
--    narrow role each answers what it did.
--      mantle_login_id(), mantle_scope_login_id(), mantle_scope_ws(),
--      mantle_scope_mod_ws(), mantle_scope_active(), mantle_setting_uuid(),
--      mantle_identity_acting_login(), mantle_identity_acting_login_required(),
--      mantle_identity_actor()
-- 3. Every function that read mantle.acting_login or mantle.actor directly
--    now asks the readers (rewritten in place below, the list asserted).
--    The acting login is required where it was read: a NULL (the narrow
--    role, or none sent) refuses with 42501 instead of matching a NULL
--    login argument.
-- 4. mantle_identity_leaks(): the catalog check. Every function body,
--    policy, trigger condition, column default, check constraint and view
--    of the app's schemas that reads a mantle.* setting outside the readers
--    is a leak, unless the key is on its list of non-identity keys (each
--    with why). An unknown key counts as an identity key. migrate fails on
--    any leak (packages/db src/migrate.ts), so a new function is covered
--    with no list to keep.
--
-- No grant changes here: the narrow role's EXECUTE list is migrate's
-- (runtime-role.ts NARROW_SYSTEM_FUNCTIONS); the four definers that need an
-- acting login left it in this release and run at the full-route spot
-- acting-login until S7c's signed acting login.
--
-- Revert: packages/db/rollback/0321_identity_gateway.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_identity_narrow"()
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT session_user = 'mantle_system_narrow'
      OR (CASE WHEN current_setting('role') = 'none' THEN session_user::text
               ELSE current_setting('role') END) = 'mantle_system_narrow'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_login_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN NULL::uuid
              ELSE nullif(current_setting('mantle.login_id', true), '')::uuid END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_login_id"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN NULL::uuid
              ELSE coalesce("public"."mantle_login_id"(),
                            nullif(current_setting('mantle.scope_login', true), '')::uuid) END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN '{}'::uuid[]
              ELSE coalesce(nullif(current_setting('mantle.ws', true), '')::uuid[], '{}'::uuid[]) END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_mod_ws"()
  RETURNS uuid[] LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN '{}'::uuid[]
              ELSE coalesce(nullif(current_setting('mantle.mod_ws', true), '')::uuid[], '{}'::uuid[]) END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_scope_active"()
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NOT "public"."mantle_identity_narrow"()
     AND coalesce(current_setting('mantle.ws', true), '') <> ''
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_setting_uuid"(name text)
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN NULL::uuid
              WHEN coalesce(current_setting(name, true), '')
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN current_setting(name, true)::uuid END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_identity_acting_login"()
  RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN NULL::uuid
              ELSE nullif(current_setting('mantle.acting_login', true), '')::uuid END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_identity_acting_login_required"()
  RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  acting uuid := "public"."mantle_identity_acting_login"();
BEGIN
  IF acting IS NULL THEN
    RAISE EXCEPTION 'mantle identity: no acting login (the narrow role names none)'
      USING ERRCODE = '42501';
  END IF;
  RETURN acting;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_identity_actor"()
  RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN "public"."mantle_identity_narrow"() THEN 'system:narrow'
              ELSE current_setting('mantle.actor', true) END
$$;
--> statement-breakpoint
-- Every direct read of the acting login or the actor, through the readers.
-- The bodies are otherwise byte-for-byte what they were (the revert puts the
-- reads back the same way).
DO $do$
DECLARE
  f record;
  def text;
  got text[] := '{}';
  want constant text[] := ARRAY[
    'mantle_access_key_revoke', 'mantle_actor_check_stmt', 'mantle_agent_delete',
    'mantle_edit_ro_stmt', 'mantle_narrow_cascade_stmt', 'mantle_narrow_one_way',
    'mantle_narrow_would_refuse_stmt', 'mantle_space_settle_promotion',
    'mantle_structure_item', 'mantle_tg_chat_set', 'mantle_ws_system_work'];
BEGIN
  FOR f IN
    SELECT p.oid, p.proname::text AS name
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.prosrc LIKE '%current_setting(''mantle.acting_login'', true)%'
            OR p.prosrc LIKE '%current_setting(''mantle.actor'', true)%')
       AND p.proname NOT LIKE 'mantle\_identity\_%'
  LOOP
    def := pg_catalog.pg_get_functiondef(f.oid);
    def := replace(def, 'nullif(current_setting(''mantle.acting_login'', true), '''')::uuid',
                   '"public"."mantle_identity_acting_login_required"()');
    def := replace(def, 'coalesce(current_setting(''mantle.actor'', true), '''')',
                   'coalesce("public"."mantle_identity_actor"(), '''')');
    IF def LIKE '%current_setting(''mantle.acting_login''%'
       OR def LIKE '%current_setting(''mantle.actor''%' THEN
      RAISE EXCEPTION '0321: % reads the acting login or the actor in a form not rewritten', f.name;
    END IF;
    EXECUTE def;
    got := got || f.name;
  END LOOP;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(got) x)
     IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(want) x) THEN
    RAISE EXCEPTION '0321: rewrote %, expected %', got, want;
  END IF;
END
$do$;
--> statement-breakpoint
-- The catalog check. Rows are leaks; none is the rule.
CREATE OR REPLACE FUNCTION "public"."mantle_identity_leaks"()
  RETURNS TABLE (kind text, object text, detail text)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  -- The readers: the only bodies that may read an identity key.
  readers constant text[] := ARRAY[
    'mantle_identity_narrow', 'mantle_login_id', 'mantle_scope_login_id', 'mantle_scope_ws',
    'mantle_scope_mod_ws', 'mantle_scope_active', 'mantle_setting_uuid',
    'mantle_identity_acting_login', 'mantle_identity_actor'];
  -- Bodies that build a key at run time, each with why it reads no identity.
  dynamic constant text[] := ARRAY[
    -- 'mantle.' || the check's name (actor_check, edit_check): a session
    -- value only ever raises the box's mode (greatest of the two).
    'mantle_check_mode',
    -- the once-per-transaction markers of a notice or a miss
    -- ('mantle.actor_missed_<table>', 'mantle.narrow_missed_<table>',
    -- 'mantle.narrow_would_<schema>_<table>', 'mantle.heads_missed_<md5>'):
    -- a marker only quiets a repeated notice; heads' is signed.
    'mantle_actor_check_stmt', 'mantle_narrow_would_refuse_stmt', 'mantle_heads_miss'];
  -- Bodies that write a condition into the triggers they make (as text):
  -- checked where it lands, as trigger conditions.
  makers constant text[] := ARRAY['mantle_edit_check_item_triggers'];
  -- Trigger conditions that read an identity key only to ADD a check, each
  -- with why: a session's own value can only make its write stricter.
  added_checks constant text[] := ARRAY[
    -- WHEN the actor is 'contact:rw' the edit check's contact rule runs: a
    -- contact's write. The narrow role is no contact; leaving the actor
    -- unset skips only a check meant for a contact.
    'mantle_edit_check_contact'];
  arg text;
  -- The non-identity keys, each with why a session's own value of it
  -- decides no identity.
  plain constant text[] := ARRAY[
    'role',                        -- the SET ROLE value: the narrow login has no membership to SET
    'server_version_num',          -- the server's version
    'mantle.route',                -- steers only the narrow counts (report), never a refusal on the narrow role
    'mantle.write_mode',           -- 'ro' only adds refusals
    'mantle.actor_check',          -- a session mode only raises the box's (mantle_check_mode)
    'mantle.edit_check',           -- the same
    'mantle.acl_internal',         -- paired with mantle_owner_role() in every reader
    'mantle.human',                -- the personal space roles' old policies: no narrow table
    'mantle.heads_bypass',         -- verified against the signed marker (mantle_bypass_verified)
    'mantle.heads_check',          -- a session mode only raises the box's
    'mantle.heads_held',           -- signed (mantle_heads_mac)
    'mantle.heads_held_upd',       -- signed
    'mantle.heads_sig',            -- the signature itself
    'mantle.keep_updated_at',      -- keeps a row's updated_at stamp: no right
    'mantle.create_stamp',         -- a new item's stamp step; its workspaces come from mantle_setting_uuid
    'mantle.ingest_notify',        -- a NOTIFY toggle
    'mantle.conversation_notify',  -- a NOTIFY toggle
    'mantle.ws_switch_armed',      -- the workspace switch's DDL window (migrate)
    'mantle.ws_switch_budget',     -- the same
    'mantle.ws_switch_deadline',   -- the same
    'mantle.ws_ddl_retry_pause',   -- the same
    'mantle.ws_former_clients'];   -- an operator's 'reviewed' for the switch's skip reason (report)
  f record;
  m text[];
  k text;
BEGIN
  -- Function bodies.
  FOR f IN
    SELECT p.oid, p.proname::text AS name, p.oid::regprocedure::text AS sig, p.prosrc
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND p.prosrc ~* '(current_setting|pg_settings|show\s+mantle)'
       AND p.proname <> 'mantle_identity_leaks'
  LOOP
    IF f.prosrc ~* 'pg_settings|show\s+mantle' THEN
      kind := 'function'; object := f.sig; detail := 'reads settings by pg_settings or SHOW';
      RETURN NEXT;
    END IF;
    CONTINUE WHEN f.name = ANY (makers);
    FOR m IN SELECT regexp_matches(f.prosrc, 'current_setting\s*\(\s*([^,)]*)', 'gi') LOOP
      arg := btrim(m[1]);
      k := substring(arg FROM '^''{1,2}([^'']*)''{1,2}(?:::text)?$');
      IF k IS NULL THEN
        CONTINUE WHEN f.name = ANY (readers) OR f.name = ANY (dynamic);
        kind := 'function'; object := f.sig; detail := 'reads a key built at run time: ' || arg;
        RETURN NEXT;
      ELSIF NOT (k = ANY (plain)) AND NOT (f.name = ANY (readers)) THEN
        kind := 'function'; object := f.sig; detail := 'reads ' || k || ' outside the readers';
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  -- Policies, column defaults, check constraints, views: no reader names a
  -- key there, so any identity key is a leak.
  FOR f IN
    SELECT 'policy' AS kind, pol.polrelid::regclass::text || ' ' || pol.polname AS obj,
           coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' '
             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS src
      FROM pg_policy pol
    UNION ALL
    SELECT 'default', a.adrelid::regclass::text, pg_get_expr(a.adbin, a.adrelid) FROM pg_attrdef a
    UNION ALL
    SELECT 'check', c.conrelid::regclass::text || ' ' || c.conname, pg_get_constraintdef(c.oid)
      FROM pg_constraint c WHERE c.contype = 'c' AND c.conrelid <> 0
    UNION ALL
    SELECT 'view', r.ev_class::regclass::text, pg_get_ruledef(r.oid)
      FROM pg_rewrite r JOIN pg_class cl ON cl.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_'
  LOOP
    FOR m IN SELECT regexp_matches(f.src, 'current_setting\s*\(\s*([^,)]*)', 'gi') LOOP
      k := substring(btrim(m[1]) FROM '^''([^'']*)''(?:::text)?$');
      IF k IS NULL OR NOT (k = ANY (plain)) THEN
        kind := f.kind; object := f.obj; detail := 'reads ' || m[1];
        RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  -- Trigger conditions: an identity key only on a table the narrow role
  -- cannot change (the edit check's contact actor adds a check on content
  -- tables; the narrow role writes none).
  FOR f IN
    SELECT t.tgrelid, t.tgrelid::regclass::text || ' ' || t.tgname AS obj, t.tgname::text AS name,
           pg_get_triggerdef(t.oid) AS src
      FROM pg_trigger t WHERE NOT t.tgisinternal
  LOOP
    CONTINUE WHEN f.name = ANY (added_checks);
    FOR m IN SELECT regexp_matches(f.src, 'current_setting\s*\(\s*([^,)]*)', 'gi') LOOP
      k := substring(btrim(m[1]) FROM '^''([^'']*)''(?:::text)?$');
      CONTINUE WHEN k = ANY (plain);
      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'mantle_system_narrow')
                AND NOT has_any_column_privilege('mantle_system_narrow', f.tgrelid, 'INSERT, UPDATE')
                AND NOT has_table_privilege('mantle_system_narrow', f.tgrelid, 'INSERT, UPDATE, DELETE');
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'mantle_system_narrow');
      kind := 'trigger'; object := f.obj; detail := 'reads ' || m[1] || ' on a table the narrow role writes';
      RETURN NEXT;
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_identity_leaks"() FROM PUBLIC;
