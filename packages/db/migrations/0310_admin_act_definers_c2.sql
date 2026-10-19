-- Part c2 of "Admin acts become definers" (workspaces arch plan v3.2):
-- the three Admin acts the session's item gate sent to the system pool
-- with no scope (session.ts itemWriteGate, ADMIN_ACT) get one narrow
-- SECURITY DEFINER function each, which checks inside, so the requests
-- (DELETE and PATCH /api/shares/:id, DELETE /api/apps/deleted/:id and
-- POST /api/apps/deleted/:id/restore) run in the login's scope and the
-- gate's two item pre-checks of them (route-scope.ts ITEM_REF_PREFIXES:
-- share, deleted-app) go:
--
--  1. mantle_share_close_admin(share): a link or a contact share closed by
--     an Admin user with the users area, whatever its item's home
--     (docs/workspaces.md: closing only narrows). DELETE /api/shares/:id.
--     The scope's login without the users area (an Admin user with it
--     switched off, a member, role drift) is told 'no-area' and nothing is
--     written: the route then closes it by the link's own rule (mayLink),
--     in the login's scope, as the gate did. No login in the scope: 42501.
--  2. mantle_share_contact_write_set(share, can_write): "Can write" on a
--     contact share of an app, by an Admin user, its home not checked, as
--     making one (POST /api/shares/contacts, 0308). PATCH /api/shares/:id
--     with a body that asks Can write. A share that names no contact (or
--     none at all) is 'not-contact', nothing written: the route answers it
--     by the link's rule, as the gate did. A contact share: the Admin user
--     check (mantle_admin_act_brain, 0308), then the share read and changed
--     under one row lock.
--  3. mantle_app_trash_act(app, act): the trash's rows of a deleted app, a
--     purge or a restore's check, by an Admin user. The newest pre_delete
--     snapshot of a gone app: none, the 'not-found' of every hidden app.
--     Its home (meta.homeWs) and keepForOwner (CEO decision 1), as the
--     gate read them: the brain's owner purges a held app; otherwise a
--     Moderator of its home (mantle_may_manage), or the owner for an app
--     with no home stored; a held app's purge by anyone but the owner is
--     'held' (the 403), its restore is not. A purge removes the app's
--     history rows (node_snapshots), the owner-only purge rule exactly as
--     today; their files are the store sweep's (0284 tombstones), as
--     before. A restore writes nothing here: it answers the snapshot the
--     restore needs (code, seq, data file, schema version, member era),
--     and the route restores the app in the login's scope after it.
--
-- Each check asks the scope's own login (mantle_scope_login_id), as c1.
-- The routes call these through adminActTx (packages/db admin-act.ts: one
-- system-pool transaction in the login's scope), as c1's do: the write
-- role's EXECUTE list is the access matrix's (S2c's next).
--
-- Grants: PUBLIC loses EXECUTE on all three; the runtime role runs them
-- from its allowlist (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS). No table,
-- row, trigger or grant on a table changes. Re-runnable: CREATE OR REPLACE
-- only.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- 1. A share closed by an Admin user with the users area. One word:
--   no-area  the scope's login does not hold the users area (nothing
--            written; the route goes on by the link's rule);
--   closed   the live share was revoked now;
--   gone     no live share of the brain has this id (revoked, or none).
CREATE OR REPLACE FUNCTION "public"."mantle_share_close_admin"(share uuid)
  RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_variable
DECLARE
  n integer;
BEGIN
  IF "public"."mantle_scope_login_id"() IS NULL THEN
    RAISE EXCEPTION 'mantle_share_close_admin: an Admin act needs a login''s scope'
      USING ERRCODE = '42501', DETAIL = 'admin_act_unscoped';
  END IF;
  IF NOT "public"."mantle_scope_has_area"('users') THEN
    RETURN 'no-area';
  END IF;
  UPDATE "public"."shares" s SET "revoked_at" = now()
   WHERE s."id" = share AND s."owner_id" = "public"."mantle_brain_id"()
     AND s."revoked_at" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n > 0 THEN 'closed' ELSE 'gone' END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_share_close_admin"(uuid) FROM PUBLIC;
--> statement-breakpoint

-- 2. "Can write" on a contact share, by an Admin user. One row:
--   not-contact    no share of the brain names a contact by this id
--                  (nothing written, no Admin check: the link's rule);
--   not-found      a contact share, not live (revoked or expired);
--   write-not-app  a live contact share of another kind;
--   ok             set; `contact` is the share's contact (the audit row).
CREATE OR REPLACE FUNCTION "public"."mantle_share_contact_write_set"(
  share uuid, can_write boolean)
  RETURNS TABLE (outcome text, contact uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_variable
DECLARE
  brain uuid := "public"."mantle_brain_id"();
  c uuid;
  kind text;
  live boolean;
BEGIN
  IF can_write IS NULL THEN
    RAISE EXCEPTION 'mantle_share_contact_write_set: can_write is null' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "public"."shares" s
                  WHERE s."id" = share AND s."owner_id" = brain
                    AND s."contact_id" IS NOT NULL) THEN
    RETURN QUERY SELECT 'not-contact'::text, NULL::uuid;
    RETURN;
  END IF;
  PERFORM "public"."mantle_admin_act_brain"('mantle_share_contact_write_set');
  SELECT s."contact_id", s."node_type"::text,
         s."revoked_at" IS NULL AND (s."expires_at" IS NULL OR s."expires_at" > now())
    INTO c, kind, live
    FROM "public"."shares" s
   WHERE s."id" = share AND s."owner_id" = brain AND s."contact_id" IS NOT NULL
     FOR UPDATE;
  IF NOT FOUND OR NOT live THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::uuid;
    RETURN;
  END IF;
  IF kind IS DISTINCT FROM 'app' THEN
    RETURN QUERY SELECT 'write-not-app'::text, NULL::uuid;
    RETURN;
  END IF;
  UPDATE "public"."shares" s SET "can_write" = can_write WHERE s."id" = share;
  RETURN QUERY SELECT 'ok'::text, c;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_share_contact_write_set"(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint

-- 3. A deleted app's trash rows, by an Admin user. `act`: purge or
-- restore. One row:
--   not-found  not in the trash, or in it where the login may not
--              manage it (one answer: no deleted app leaves the scope);
--   held       a purge of an app a login other than the brain's owner
--              deleted, by anyone but the owner (nothing removed);
--   purged     its history rows removed (purge);
--   restore    the restore may go on (nothing written): the newest
--              pre_delete snapshot's seq, code, data file and schema
--              version, and whether a member ever wrote its code.
CREATE OR REPLACE FUNCTION "public"."mantle_app_trash_act"(app uuid, act text)
  RETURNS TABLE (outcome text, seq integer, code jsonb, db_path text,
                 schema_version integer, member_era boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_variable
DECLARE
  brain uuid := "public"."mantle_admin_act_brain"('mantle_app_trash_act');
  owner boolean := "public"."mantle_scope_login_id"() = brain;
  s_seq integer;
  s_code jsonb;
  s_db text;
  s_schema integer;
  home text;
  held boolean;
  may boolean;
BEGIN
  IF act IS NULL OR act NOT IN ('purge', 'restore') THEN
    RAISE EXCEPTION 'mantle_app_trash_act: act % is neither purge nor restore', act
      USING ERRCODE = '22023';
  END IF;
  SELECT s."seq", s."code", s."db_path", s."schema_version",
         nullif(s."code" -> 'meta' ->> 'homeWs', ''),
         coalesce((s."code" -> 'meta' ->> 'keepForOwner')::boolean, false)
    INTO s_seq, s_code, s_db, s_schema, home, held
    FROM "public"."node_snapshots" s
   WHERE s."owner_id" = brain AND s."node_id" = app AND s."node_kind" = 'app'
     AND s."trigger" = 'pre_delete'
     AND NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = s."node_id")
   ORDER BY s."seq" DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not-found'::text, NULL::integer, NULL::jsonb, NULL::text,
                        NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  -- The owner purges an app another login deleted, whatever its home.
  IF NOT (act = 'purge' AND held AND owner) THEN
    may := owner AND home IS NULL;
    IF home IS NOT NULL THEN
      may := coalesce("public"."mantle_may_manage"(home::uuid), false);
    END IF;
    IF NOT may THEN
      RETURN QUERY SELECT 'not-found'::text, NULL::integer, NULL::jsonb, NULL::text,
                          NULL::integer, NULL::boolean;
      RETURN;
    END IF;
    IF act = 'purge' AND held THEN
      RETURN QUERY SELECT 'held'::text, NULL::integer, NULL::jsonb, NULL::text,
                          NULL::integer, NULL::boolean;
      RETURN;
    END IF;
  END IF;
  IF act = 'purge' THEN
    DELETE FROM "public"."node_snapshots" x WHERE x."owner_id" = brain AND x."node_id" = app;
    RETURN QUERY SELECT 'purged'::text, NULL::integer, NULL::jsonb, NULL::text,
                        NULL::integer, NULL::boolean;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'restore'::text, s_seq, s_code, s_db, s_schema,
    EXISTS (SELECT 1 FROM "public"."node_snapshots" m
             WHERE m."node_id" = app AND m."actor" = 'member');
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_app_trash_act"(uuid, text) FROM PUBLIC;
