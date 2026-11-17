-- Rollback of 0378_contact_shares_gone: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- Needed: the older image reads shares.contact_id on every /s link, reads
-- contact_share_codes for its contacts, and its migrate grants the contact
-- act definers. This puts back, EMPTY, what 0378 dropped, as the migrations
-- before it left it: the two tables (0214, 0225, 0275's actor check), the
-- shares columns, check, trigger and indexes (0214, 0279, 0295), the
-- definers (0293, 0308, 0310), the contact edit check (0294) and the
-- function bodies 0378 changed (0261, 0262, 0275, 0281, 0293). Then it takes
-- 0378 off the ledger, so the next roll forward applies it again (it is
-- re-runnable). The deleted contact shares, codes and trail rows do NOT come
-- back: no contact share opens on the older image either.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0378_contact_shares_gone.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- 0214 (with 0225's trail kinds).

CREATE TABLE IF NOT EXISTS "public"."contact_share_codes" (
  "contact_id"      uuid PRIMARY KEY NOT NULL REFERENCES "public"."nodes"("id") ON DELETE CASCADE,
  "owner_id"        uuid NOT NULL,
  "code_hash"       text,
  "code_epoch"      integer NOT NULL DEFAULT 1,
  "disabled_at"     timestamptz,
  "failed_attempts" integer NOT NULL DEFAULT 0,
  "failed_since"    timestamptz,
  "locked_until"    timestamptz,
  "last_used_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "rotated_at"      timestamptz,
  CONSTRAINT "contact_share_codes_epoch_ck" CHECK ("code_epoch" >= 1),
  CONSTRAINT "contact_share_codes_attempts_ck" CHECK ("failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_share_codes_owner_idx"
  ON "public"."contact_share_codes" ("owner_id");
--> statement-breakpoint

-- The row names a contact node of the same owner.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_share_code_check"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.contact_id AND n.owner_id = new.owner_id AND n.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'contact_share_codes: % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "contact_share_codes_check_trg" ON "public"."contact_share_codes";
--> statement-breakpoint
CREATE TRIGGER "contact_share_codes_check_trg"
  BEFORE INSERT OR UPDATE OF "contact_id", "owner_id" ON "public"."contact_share_codes"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_contact_share_code_check"();
--> statement-breakpoint

-- A lock starting or ending moves the "Needs you" count (0186's event).
DROP TRIGGER IF EXISTS "contact_share_codes_needs_you_trg" ON "public"."contact_share_codes";
--> statement-breakpoint
CREATE TRIGGER "contact_share_codes_needs_you_trg"
  AFTER UPDATE OF "locked_until" ON "public"."contact_share_codes"
  FOR EACH ROW
  WHEN (old.locked_until IS DISTINCT FROM new.locked_until)
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint

ALTER TABLE "public"."shares"
  ADD COLUMN IF NOT EXISTS "contact_id" uuid REFERENCES "public"."nodes"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."shares"
  ADD COLUMN IF NOT EXISTS "can_write" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."shares" DROP CONSTRAINT IF EXISTS "shares_can_write_ck";
--> statement-breakpoint
ALTER TABLE "public"."shares"
  ADD CONSTRAINT "shares_can_write_ck"
  CHECK (NOT "can_write" OR ("contact_id" IS NOT NULL AND "node_type" = 'app'));
--> statement-breakpoint

-- A contact share names a contact node of the same owner, on a workspace
-- item of that owner that is not a folder (decision 2: no folder contact
-- shares in v1) and not a contact.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_share_check"()
  RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public AS $$
BEGIN
  IF new.contact_id IS NULL THEN
    RETURN new;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" c
     WHERE c.id = new.contact_id AND c.owner_id = new.owner_id AND c.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'shares: contact % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.node_id AND n.owner_id = new.owner_id
       AND n.type = new.node_type
       AND "public"."mantle_workspace_kind"(n.type)
       AND n.type <> 'branch'
  ) THEN
    RAISE EXCEPTION 'shares: a contact share needs a workspace item that is not a folder'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "shares_contact_check_trg" ON "public"."shares";
--> statement-breakpoint
CREATE TRIGGER "shares_contact_check_trg"
  BEFORE INSERT OR UPDATE OF "contact_id", "node_id", "node_type", "owner_id" ON "public"."shares"
  FOR EACH ROW EXECUTE FUNCTION "public"."mantle_contact_share_check"();
--> statement-breakpoint

-- One open link per item (unchanged), one live share per contact per item.
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_open_uq"
  ON "public"."shares" ("node_id")
  WHERE "revoked_at" IS NULL AND "contact_id" IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "public"."shares_node_active_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shares_node_contact_uq"
  ON "public"."shares" ("node_id", "contact_id")
  WHERE "revoked_at" IS NULL AND "contact_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shares_contact_idx"
  ON "public"."shares" ("contact_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."share_access_log" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"   uuid NOT NULL,
  "share_id"   uuid REFERENCES "public"."shares"("id") ON DELETE SET NULL,
  "contact_id" uuid REFERENCES "public"."nodes"("id") ON DELETE SET NULL,
  "kind"       text NOT NULL,
  "detail"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "share_access_log_kind_ck"
    CHECK ("kind" IN ('open', 'asset', 'query', 'write', 'tool', 'refused', 'code_failed'))
);
--> statement-breakpoint
-- The trail outlives its share and its contact (like app_access_log):
-- deleting a contact cascades its shares, and both ids go NULL here, so the
-- rows stay. Restated so a database that ran an earlier draft of this file
-- gets the same shape (idempotent).
ALTER TABLE "public"."share_access_log" ALTER COLUMN "share_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "public"."share_access_log"
  DROP CONSTRAINT IF EXISTS "share_access_log_share_id_fkey",
  ADD CONSTRAINT "share_access_log_share_id_fkey"
    FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."share_access_log"
  DROP CONSTRAINT IF EXISTS "share_access_log_contact_id_fkey",
  ADD CONSTRAINT "share_access_log_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "public"."nodes"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_share_idx"
  ON "public"."share_access_log" ("share_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_contact_idx"
  ON "public"."share_access_log" ("contact_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_access_log_created_idx"
  ON "public"."share_access_log" ("created_at");
--> statement-breakpoint
-- 0295's contact share check, 0279's rights.
CREATE OR REPLACE FUNCTION public.mantle_contact_share_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF new.contact_id IS NULL THEN
    RETURN new;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" c
     WHERE c.id = new.contact_id AND c.owner_id = new.owner_id AND c.type = 'contact'
  ) THEN
    RAISE EXCEPTION 'shares: contact % is not a contact of this owner', new.contact_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."nodes" n
     WHERE n.id = new.node_id AND n.owner_id = new.owner_id
       AND n.type = new.node_type
       AND n.type IN ('page', 'note', 'draw', 'table', 'file', 'app', 'formula')
  ) THEN
    RAISE EXCEPTION 'shares: a contact share needs a workspace item that is not a folder'
      USING ERRCODE = '23514';
  END IF;
  RETURN new;
END
--> statement-breakpoint
ALTER FUNCTION "public"."mantle_contact_share_check"() SECURITY DEFINER;
--> statement-breakpoint
ALTER FUNCTION "public"."mantle_contact_share_check"() SET search_path = "public", pg_temp;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_share_check"() FROM PUBLIC;
--> statement-breakpoint
-- 0275's actor check on the code rows.
DO $$ BEGIN
  DROP TRIGGER IF EXISTS mantle_actor_check ON public.contact_share_codes;
  CREATE TRIGGER mantle_actor_check BEFORE INSERT OR UPDATE OR DELETE ON public.contact_share_codes
    FOR EACH STATEMENT EXECUTE FUNCTION public.mantle_actor_check_stmt();
  IF "public"."mantle_actor_check_box_mode"() = 'off' THEN
    ALTER TABLE "public"."contact_share_codes" DISABLE TRIGGER "mantle_actor_check";
  END IF;
END $$;
--> statement-breakpoint
-- 0293.
CREATE OR REPLACE FUNCTION "public"."mantle_contact_sharing"(owner uuid, ids uuid[])
  RETURNS TABLE ("contact_id" uuid, "created_at" timestamptz, "rotated_at" timestamptz,
                 "last_used_at" timestamptz, "locked_until" timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT c."contact_id", c."created_at", c."rotated_at", c."last_used_at", c."locked_until"
    FROM "public"."contact_share_codes" c
   WHERE c."owner_id" = owner AND c."contact_id" = ANY (ids) AND c."code_hash" IS NOT NULL
     AND (NOT "public"."mantle_scope_active"()
          OR (owner = "public"."mantle_brain_id"()
              AND EXISTS (
                SELECT 1 FROM "public"."nodes" n
                 WHERE n."id" = c."contact_id" AND n."owner_id" = owner
                   AND n."read_ws" && "public"."mantle_scope_ws"()
                   AND (n."login_id" IS NULL OR n."login_id" = "public"."mantle_login_id"()))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) TO "mantle_view_user";
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_contact_sharing"(uuid, uuid[]) TO demo_reader;
  END IF;
END $$;
--> statement-breakpoint
-- 0308.
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
-- 0310.
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
-- 0294 (the contact edit check, its maker, the run).
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_edit_contact_stmt"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  -- A cascade's inner statements are skipped (their source is checked).
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  PERFORM "public"."mantle_edit_refuse"(
    format('%s on %s: a contact share writes its app''s data only', TG_OP, TG_TABLE_NAME),
    'ro_actor', 'not allowed to change this: a contact share writes its app''s data only');
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_contact_stmt"() FROM PUBLIC;
--> statement-breakpoint
-- The migration-made edit check triggers of an item table, installed by one
-- loop (the read-only refusal of 0280, section 5, and this one): a migration
-- that adds an item table calls it, so neither trigger is left off a new
-- table. CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE, not the
-- ACCESS EXCLUSIVE of a DROP TRIGGER: reads go on while it runs on a live
-- box. A replaced trigger comes back enabled, so the box mode is applied
-- after the loop: disabled on a box that is off.
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
    -- A contact share writes its app's data: app_databases is left out.
    CONTINUE WHEN t = 'public.app_databases'::regclass;
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER mantle_edit_check_contact BEFORE INSERT OR UPDATE OR DELETE ON %s '
      'FOR EACH STATEMENT WHEN (current_setting(''mantle.actor'', true) = ''contact:rw'') '
      'EXECUTE FUNCTION "public"."mantle_edit_contact_stmt"()', t);
    n := n + 1;
  END LOOP;
  PERFORM "public"."mantle_edit_check_triggers"("public"."mantle_check_box_mode"('edit_check') <> 'off', 50);
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_edit_check_item_triggers"() FROM PUBLIC;
--> statement-breakpoint
SELECT "public"."mantle_edit_check_item_triggers"();
--> statement-breakpoint
-- 0275.
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
-- 0261.
CREATE OR REPLACE FUNCTION "public"."mantle_ws_links_diff"()
  RETURNS TABLE ("section" text, "subject" text, "metric" text, "n" bigint)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  WITH live AS (
    SELECT s."id", s."owner_id", s."node_id", s."settings"
      FROM "public"."shares" s
     WHERE s."revoked_at" IS NULL AND s."contact_id" IS NULL
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
-- 0262.
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
   WHERE n."id" = x."node_id" AND x."revoked_at" IS NULL AND x."contact_id" IS NULL
     AND n."audience"::text = 'client';
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'open links on client items, retired', c;

  -- 2. The served list of every other live open link.
  UPDATE "public"."shares" x
     SET "settings" = x."settings"
                      || jsonb_build_object('served', to_jsonb("public"."mantle_link_served_by_levels"(x."id")))
   WHERE x."revoked_at" IS NULL AND x."contact_id" IS NULL
     AND NOT (x."settings" ? 'served');
  GET DIAGNOSTICS c = ROW_COUNT;
  RETURN QUERY SELECT 'open links given a served list', c;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_link_served_fill"() FROM PUBLIC;
--> statement-breakpoint
-- 0281.
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

  IF mode = 'contact'
     AND (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> 'contact_id') IS NOT NULL THEN
    need := 'admin';
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
-- 0293.
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
                 WHERE s."owner_id" = owner AND s."revoked_at" IS NULL AND s."contact_id" IS NULL
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
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792070000000;
