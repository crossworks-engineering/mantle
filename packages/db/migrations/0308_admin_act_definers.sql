-- Part c1 of "Admin acts become definers" (workspaces arch plan v3.2):
-- four of the Admin acts that run on the system pool with no
-- scope (route-scope.ts ADMIN_ACT_WRITES) get one narrow
-- SECURITY DEFINER function each, which checks the Admin user inside:
--
--  1. mantle_contact_sharing_set(contact, action, code_hash): a contact's
--     sharing switched on, its code made again, or switched off (every live
--     share of the contact revoked in the same transaction).
--     POST /api/contacts/:id/sharing.
--  2. mantle_contact_shares_revoke_all(contact): Revoke all of a contact's
--     live shares. DELETE /api/contacts/:id/shares.
--  3. mantle_share_with_contacts(node, contacts, tokens, write_on, kinds):
--     one item shared with one or more contacts. POST /api/shares/contacts.
--     Its home is not checked, as today (docs/workspaces.md: "Share it with
--     one contact: to be an Admin user, its home is not checked").
--  4. mantle_entity_merge(canonical, dup): an entity merge; every fact and
--     edge of the duplicate moves inside, those of items outside the user's
--     workspaces too (0265: the entity graph is Admin's; facts.entity_id is
--     ON DELETE SET NULL, so a fact left behind would lose its entity).
--     POST /api/entities/merge.
--
-- The check (mantle_admin_act_brain): the scope's own login
-- (mantle_scope_login_id) is an Admin user (mantle_login_is_admin, 0304)
-- AND the brain's live Admin workspace is in the scope (mantle_scope_ws),
-- the same shape as mantle_scope_has_area (0304) with "an Admin user" for
-- "holds the area". It is today's rule: the guard sends only an Admin user's
-- request to these acts (session.ts enterLoginWrite, ADMIN_ACT), and no area
-- names them (an area would refuse an Admin user who has it switched off,
-- a narrower answer nobody asked for). A scope without a login, a member's
-- scope and no scope at all are refused with 42501. These acts have no
-- system work: nothing runs them without an Admin user.
--
-- Each act's rows are written by one body (mantle_*_rows, owner given),
-- which the definer calls for the brain (mantle_brain_id). The body is the
-- system door of the same rows: the content functions with an owner
-- (@mantle/content contact-share-codes.ts, contact-shares.ts and
-- entity-dedup.ts mergeEntities: the nightly entities-dedupe sweep, the
-- CLI and the test fixtures) call it, so the TypeScript copies of these
-- writes go and each act is written once. The bodies add no right: the
-- runtime role writes these tables directly. What only TypeScript knows
-- stays there and comes in as an argument: the code's hash (HMAC keyed by
-- MANTLE_MASTER_KEY), the links' tokens and the kinds a contact share may
-- name (the kind registry, @mantle/client-types/kinds).
--
-- Grants: PUBLIC loses EXECUTE on all nine; the runtime role runs the four
-- definers and the four bodies from its allowlist (packages/db
-- runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS); no viewer role, the write role
-- or the gap writer gets one (the requests stay on the system pool in c1).
-- mantle_admin_act_brain is the definers' own, no role runs it.
--
-- No table, row or trigger changes. Re-runnable: CREATE OR REPLACE only.
--
-- The number was claimed at the merge (plan v3.2 rule 3): this branch held
-- 0306 until S8a (0306_admin_membership) and S2a a1+a2
-- (0307_ws_user_definers) landed; it is 0308 with the `when` it had
-- (1790197800000, above 0307's 1790197740000).
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- The Admin act check: the brain, when the scope's own login is an Admin
-- user and the brain's live Admin workspace is in the scope; else 42501.
CREATE OR REPLACE FUNCTION "public"."mantle_admin_act_brain"(act text)
  RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  login uuid := "public"."mantle_scope_login_id"();
  brain uuid := "public"."mantle_brain_id"();
BEGIN
  IF login IS NULL THEN
    RAISE EXCEPTION '%: an Admin act needs an Admin user''s scope', act
      USING ERRCODE = '42501', DETAIL = 'admin_act_unscoped';
  END IF;
  IF NOT ("public"."mantle_login_is_admin"(login)
          AND EXISTS (SELECT 1 FROM "public"."workspaces" w
                       WHERE w."owner_id" = brain AND w."is_admin"
                         AND w."archived_at" IS NULL
                         AND w."id" = ANY ("public"."mantle_scope_ws"()))) THEN
    RAISE EXCEPTION '%: Admin users only', act
      USING ERRCODE = '42501', DETAIL = 'admin_act_admin_only';
  END IF;
  RETURN brain;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_admin_act_brain"(text) FROM PUBLIC;
--> statement-breakpoint

-- 1. A contact's sharing. `action`: enable, regenerate or disable;
-- `code_hash`: the new code's hash (enable, regenerate). One row:
--   not-a-contact             not a contact of `owner` (nothing changed);
--   on | already-on           enable (already-on: nothing changed);
--   regenerated | sharing-off regenerate (sharing-off: nothing changed);
--   off | was-off             disable, `revoked` the shares it revoked.
-- Enable from off makes a new epoch and revokes any live share left (a
-- share made past an older switch off). A share create holds the code row
-- FOR SHARE, so it waits on these.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_sharing_rows"(
  owner uuid, contact uuid, action text, code_hash text)
  RETURNS TABLE (outcome text, revoked integer) LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_variable
DECLARE
  cur text;
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" x
                  WHERE x."id" = contact AND x."owner_id" = owner AND x."type" = 'contact') THEN
    RETURN QUERY SELECT 'not-a-contact'::text, 0;
    RETURN;
  END IF;
  IF action IN ('enable', 'regenerate') AND coalesce(code_hash, '') = '' THEN
    RAISE EXCEPTION 'mantle_contact_sharing_rows: % needs a code hash', action
      USING ERRCODE = '22023';
  END IF;
  IF action = 'enable' THEN
    SELECT c."code_hash" INTO cur FROM "public"."contact_share_codes" c
     WHERE c."contact_id" = contact FOR UPDATE;
    IF FOUND AND cur IS NOT NULL THEN
      RETURN QUERY SELECT 'already-on'::text, 0;
      RETURN;
    END IF;
    IF NOT FOUND THEN
      -- Two Enables at once both find no row: the second meets the first
      -- one's row here, waits for it, and answers already-on.
      INSERT INTO "public"."contact_share_codes" AS c
          ("contact_id", "owner_id", "code_hash", "created_at")
        VALUES (contact, owner, code_hash, now())
        ON CONFLICT ("contact_id") DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN QUERY SELECT CASE WHEN n = 0 THEN 'already-on' ELSE 'on' END::text, 0;
      RETURN;
    END IF;
    UPDATE "public"."contact_share_codes" c
       SET "code_hash" = code_hash, "code_epoch" = c."code_epoch" + 1, "disabled_at" = NULL,
           "failed_attempts" = 0, "failed_since" = NULL, "locked_until" = NULL,
           "rotated_at" = now()
     WHERE c."contact_id" = contact;
    UPDATE "public"."shares" s SET "revoked_at" = now()
     WHERE s."owner_id" = owner AND s."contact_id" = contact AND s."revoked_at" IS NULL;
    RETURN QUERY SELECT 'on'::text, 0;
    RETURN;
  END IF;
  IF action = 'regenerate' THEN
    UPDATE "public"."contact_share_codes" c
       SET "code_hash" = code_hash, "code_epoch" = c."code_epoch" + 1,
           "failed_attempts" = 0, "failed_since" = NULL, "locked_until" = NULL,
           "rotated_at" = now()
     WHERE c."contact_id" = contact AND c."owner_id" = owner AND c."code_hash" IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN QUERY SELECT CASE WHEN n = 0 THEN 'sharing-off' ELSE 'regenerated' END::text, 0;
    RETURN;
  END IF;
  IF action = 'disable' THEN
    UPDATE "public"."contact_share_codes" c
       SET "code_hash" = NULL, "disabled_at" = now(), "code_epoch" = c."code_epoch" + 1,
           "failed_attempts" = 0, "failed_since" = NULL, "locked_until" = NULL
     WHERE c."contact_id" = contact AND c."owner_id" = owner AND c."code_hash" IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RETURN QUERY SELECT 'was-off'::text, 0;
      RETURN;
    END IF;
    UPDATE "public"."shares" s SET "revoked_at" = now()
     WHERE s."owner_id" = owner AND s."contact_id" = contact AND s."revoked_at" IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN QUERY SELECT 'off'::text, n;
    RETURN;
  END IF;
  RAISE EXCEPTION 'mantle_contact_sharing_rows: unknown action %', action USING ERRCODE = '22023';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_sharing_rows"(uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_contact_sharing_set"(
  contact uuid, action text, code_hash text)
  RETURNS TABLE (outcome text, revoked integer) LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT r.* FROM "public"."mantle_contact_sharing_rows"(
    "public"."mantle_admin_act_brain"('mantle_contact_sharing_set'), contact, action, code_hash) r
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_sharing_set"(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint

-- 2. Revoke all: every live share of one contact (not revoked, not
-- expired). How many; NULL when `contact` is not a contact of `owner`. No
-- level changes; the contact's sharing stays on.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_shares_revoke_rows"(owner uuid, contact uuid)
  RETURNS integer LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" x
                  WHERE x."id" = contact AND x."owner_id" = owner AND x."type" = 'contact') THEN
    RETURN NULL;
  END IF;
  UPDATE "public"."shares" s SET "revoked_at" = now()
   WHERE s."owner_id" = owner AND s."contact_id" = contact AND s."revoked_at" IS NULL
     AND (s."expires_at" IS NULL OR s."expires_at" > now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_shares_revoke_rows"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_contact_shares_revoke_all"(contact uuid)
  RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_contact_shares_revoke_rows"(
    "public"."mantle_admin_act_brain"('mantle_contact_shares_revoke_all'), contact)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_shares_revoke_all"(uuid) FROM PUBLIC;
--> statement-breakpoint

-- 3. Share one item with each of `contacts` (`tokens[i]`: the new link's
-- token for contacts[i]; a contact named twice counts once, with its first
-- token). One share per contact, made or found (an existing live share is
-- answered as it is), in the order of `contacts`. Refused as a whole, one
-- row with `refused` set and nothing written, in this order: missing (no
-- such item of `owner`), snapshot (a read-only snapshot copy, 0267),
-- folder, kind:<type> (a type not in `kinds`), write-not-app (`write_on`
-- on anything but an app), not-a-contact, sharing-off. Changes no level.
CREATE OR REPLACE FUNCTION "public"."mantle_share_with_contacts_rows"(
  owner uuid, node uuid, contacts uuid[], tokens text[], write_on boolean, kinds text[])
  RETURNS TABLE (share_id uuid, contact_id uuid, token text, refused text)
  LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  t "public"."node_type";
  d jsonb;
  ids uuid[];
  toks text[];
  n integer;
BEGIN
  SELECT coalesce(array_agg(u.c ORDER BY u.o), '{}'), coalesce(array_agg(u.k ORDER BY u.o), '{}')
    INTO ids, toks
    FROM (SELECT DISTINCT ON (z.c) z.c, z.k, z.o
            FROM unnest(contacts, tokens) WITH ORDINALITY AS z(c, k, o)
           WHERE z.c IS NOT NULL
           ORDER BY z.c, z.o) u;
  IF cardinality(ids) = 0 THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(toks) AS q(k) WHERE coalesce(q.k, '') = '') THEN
    RAISE EXCEPTION 'mantle_share_with_contacts_rows: a token for each contact'
      USING ERRCODE = '22023';
  END IF;
  SELECT x."type", x."data" INTO t, d FROM "public"."nodes" x
   WHERE x."id" = node AND x."owner_id" = owner;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'missing'::text;
    RETURN;
  END IF;
  IF jsonb_typeof(d -> 'snapshot_of') = 'string' AND d ->> 'snapshot_of' <> '' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'snapshot'::text;
    RETURN;
  END IF;
  IF t = 'branch' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'folder'::text;
    RETURN;
  END IF;
  IF NOT (t::text = ANY (coalesce(kinds, '{}'))) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, ('kind:' || t::text);
    RETURN;
  END IF;
  IF coalesce(write_on, false) AND t <> 'app' THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'write-not-app'::text;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM "public"."nodes" x
       WHERE x."owner_id" = owner AND x."type" = 'contact' AND x."id" = ANY (ids))
     <> cardinality(ids) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'not-a-contact'::text;
    RETURN;
  END IF;
  -- The code rows, locked FOR SHARE in id order before the sharing-off
  -- check: a switch off (or an Enable from off) updates the row, so it
  -- waits for this transaction, or this one waits for it and then reads
  -- the row as it left it (the lock returns the row's newest version).
  IF (SELECT count(*) FROM (
        SELECT c."code_hash" AS h FROM "public"."contact_share_codes" c
         WHERE c."owner_id" = owner AND c."contact_id" = ANY (ids)
         ORDER BY c."contact_id" FOR SHARE) l
       WHERE l.h IS NOT NULL)
     <> cardinality(ids) THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, 'sharing-off'::text;
    RETURN;
  END IF;
  -- An expired share still holds its (item, contact) slot
  -- (shares_node_contact_uq is WHERE revoked_at IS NULL): retire it first.
  UPDATE "public"."shares" s SET "revoked_at" = now()
   WHERE s."owner_id" = owner AND s."node_id" = node AND s."contact_id" = ANY (ids)
     AND s."revoked_at" IS NULL AND s."expires_at" < now();
  -- A second identical request at the same time (a double click) meets the
  -- first one's row on shares_node_contact_uq: nothing, then the read below
  -- answers the row it made.
  INSERT INTO "public"."shares" ("owner_id", "node_id", "node_type", "token", "contact_id", "can_write")
  SELECT owner, node, t, w.k, w.c, coalesce(write_on, false)
    FROM unnest(ids, toks) AS w(c, k)
   WHERE NOT EXISTS (SELECT 1 FROM "public"."shares" s
                      WHERE s."owner_id" = owner AND s."node_id" = node
                        AND s."contact_id" = w.c AND s."revoked_at" IS NULL)
  ON CONFLICT ("node_id", "contact_id") WHERE "revoked_at" IS NULL AND "contact_id" IS NOT NULL
  DO NOTHING;
  RETURN QUERY
    SELECT s."id", w.c, s."token", NULL::text
      FROM unnest(ids) WITH ORDINALITY AS w(c, o)
      JOIN "public"."shares" s
        ON s."owner_id" = owner AND s."node_id" = node AND s."contact_id" = w.c
       AND s."revoked_at" IS NULL
     ORDER BY w.o;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(ids) THEN
    RAISE EXCEPTION 'contact share: a raced row is gone';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_share_with_contacts_rows"(uuid, uuid, uuid[], text[], boolean, text[]) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_share_with_contacts"(
  node uuid, contacts uuid[], tokens text[], write_on boolean, kinds text[])
  RETURNS TABLE (share_id uuid, contact_id uuid, token text, refused text)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT r.* FROM "public"."mantle_share_with_contacts_rows"(
    "public"."mantle_admin_act_brain"('mantle_share_with_contacts'),
    node, contacts, tokens, write_on, kinds) r
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_share_with_contacts"(uuid, uuid[], text[], boolean, text[]) FROM PUBLIC;
--> statement-breakpoint

-- 4. Merge `dup` into `canonical` for `owner`: every relation and mention
-- edge (source and target) and every fact moves to the canonical, the
-- dup's name and aliases fold into the canonical's aliases (each trimmed,
-- the first of equal ones kept in order, none empty or the canonical's own
-- name in any case), then the dup goes. False when they are one, or either
-- is not `owner`'s.
CREATE OR REPLACE FUNCTION "public"."mantle_entity_merge_rows"(owner uuid, canonical uuid, dup uuid)
  RETURNS boolean LANGUAGE plpgsql VOLATILE
  SET search_path = "public", pg_temp AS $$
DECLARE
  c_name text;
  c_aliases text[];
  d_name text;
  d_aliases text[];
  merged text[];
BEGIN
  IF canonical IS NULL OR dup IS NULL OR canonical = dup THEN
    RETURN false;
  END IF;
  SELECT e."name", e."aliases" INTO c_name, c_aliases FROM "public"."entities" e
   WHERE e."id" = canonical AND e."owner_id" = owner;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT e."name", e."aliases" INTO d_name, d_aliases FROM "public"."entities" e
   WHERE e."id" = dup AND e."owner_id" = owner;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE "public"."entity_edges" g SET "source_id" = canonical
   WHERE g."owner_id" = owner AND g."source_id" = dup;
  UPDATE "public"."entity_edges" g SET "target_id" = canonical
   WHERE g."owner_id" = owner AND g."target_id" = dup;
  UPDATE "public"."facts" f SET "entity_id" = canonical
   WHERE f."owner_id" = owner AND f."entity_id" = dup;
  SELECT coalesce(array_agg(a.v ORDER BY a.o), '{}') INTO merged
    FROM (SELECT b.v, min(b.o) AS o
            FROM (SELECT regexp_replace(u.x, '^[[:space:]' || E'\u00A0\uFEFF' || ']+|[[:space:]' || E'\u00A0\uFEFF' || ']+$', '', 'g') AS v,
                         u.o
                    FROM unnest(coalesce(c_aliases, '{}') || ARRAY[d_name] || coalesce(d_aliases, '{}'))
                         WITH ORDINALITY AS u(x, o)) b
           WHERE b.v IS NOT NULL AND b.v <> '' AND lower(b.v) <> lower(c_name)
           GROUP BY b.v) a;
  UPDATE "public"."entities" e SET "aliases" = merged, "updated_at" = now()
   WHERE e."id" = canonical;
  DELETE FROM "public"."entities" e WHERE e."id" = dup AND e."owner_id" = owner;
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_entity_merge_rows"(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_entity_merge"(canonical uuid, dup uuid)
  RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT "public"."mantle_entity_merge_rows"(
    "public"."mantle_admin_act_brain"('mantle_entity_merge'), canonical, dup)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_entity_merge"(uuid, uuid) FROM PUBLIC;
