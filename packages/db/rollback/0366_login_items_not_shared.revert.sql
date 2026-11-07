-- Rollback of 0366_login_items_not_shared: what an operator MAY run before
-- pinning the image one release back (plan v3.2 rule 2, a one-image
-- rollback). Not a migration: nothing runs it on its own.
--
-- It puts back 0308's mantle_share_with_contacts_rows and 0279's
-- mantle_grant_change and mantle_grant_move_home (no login_id check), and
-- takes 0366 off the ledger, so the next roll forward runs it again. No row
-- changes.
--
-- Run it while the newer image is still up, as the superuser, in one
-- transaction:
--   docker exec mantle_web cat /app/packages/db/rollback/0366_login_items_not_shared.revert.sql \
--     | docker exec -i mantle_pg psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-- then pin the older image straight away (docs/update-prod.md "Rollback").
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
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
CREATE OR REPLACE FUNCTION "public"."mantle_grant_change"(
  op text, node uuid, ws uuid, w boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  home uuid;
  row_home boolean;
  manage boolean;
  moderates boolean;
  ok boolean;
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  IF op IS NULL OR op NOT IN ('add', 'exclude', 'hand', 'write', 'remove', 'restore') THEN
    RAISE EXCEPTION 'mantle_grant_change: unknown op %', op USING ERRCODE = '22023';
  END IF;
  SELECT n."home_ws" INTO home FROM "public"."nodes" n
   WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."is_home" INTO row_home FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."workspace_id" = ws;
  manage := "public"."mantle_may_manage_home"(home);
  moderates := coalesce(ws = ANY ("public"."mantle_scope_mod_ws"()), false);
  ok := CASE
          WHEN op IN ('exclude', 'remove') THEN manage OR moderates
          WHEN op = 'write' AND coalesce(row_home, false) THEN manage
          WHEN op = 'write' AND NOT coalesce(w, false) THEN manage OR moderates
          ELSE manage AND moderates
        END;
  PERFORM "public"."mantle_grant_refuses"(ok, format('%s on item_grants: no right to change this grant', op),
    CASE WHEN manage THEN 'not allowed to grant to that workspace' ELSE 'not allowed to change this item' END);
  IF op = 'add' THEN
    IF row_home IS NULL THEN
      INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "granted_by")
      VALUES (node, ws, coalesce(w, false), who);
    ELSE
      UPDATE "public"."item_grants"
         SET "excluded" = false, "via_folder_id" = NULL, "write" = coalesce(w, false),
             "granted_by" = who, "granted_at" = now()
       WHERE "node_id" = node AND "workspace_id" = ws;
    END IF;
  ELSIF op = 'exclude' THEN
    UPDATE "public"."item_grants"
       SET "excluded" = true, "write" = false, "via_folder_id" = NULL,
           "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSIF op = 'hand' THEN
    UPDATE "public"."item_grants"
       SET "via_folder_id" = NULL, "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSIF op = 'write' THEN
    UPDATE "public"."item_grants" SET "write" = coalesce(w, false)
     WHERE "node_id" = node AND "workspace_id" = ws;
  ELSE
    DELETE FROM "public"."item_grants" WHERE "node_id" = node AND "workspace_id" = ws;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_grant_move_home"(
  node uuid, to_ws uuid, keep_old boolean, actor uuid)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  from_ws uuid;
  who uuid := coalesce("public"."mantle_login_id"(), actor);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n
                  WHERE n."id" = node AND n."owner_id" = "public"."mantle_brain_id"()) THEN
    RAISE EXCEPTION 'not allowed to move this item' USING ERRCODE = '42501';
  END IF;
  SELECT g."workspace_id" INTO from_ws FROM "public"."item_grants" g
   WHERE g."node_id" = node AND g."is_home";
  PERFORM "public"."mantle_grant_refuses"("public"."mantle_may_manage_home"(from_ws),
    'UPDATE on item_grants: a home move, no manage of the home', 'not allowed to move this item');
  PERFORM "public"."mantle_grant_refuses"(coalesce(to_ws = ANY ("public"."mantle_scope_mod_ws"()), false),
    'UPDATE on item_grants: a home move, not a Moderator of the workspace',
    'not allowed to grant to that workspace');
  IF from_ws IS NOT DISTINCT FROM to_ws THEN RETURN; END IF;
  -- The old home row first: the one-home index is not deferrable.
  UPDATE "public"."item_grants" SET "is_home" = false
   WHERE "node_id" = node AND "workspace_id" = from_ws;
  IF EXISTS (SELECT 1 FROM "public"."item_grants" g
              WHERE g."node_id" = node AND g."workspace_id" = to_ws) THEN
    UPDATE "public"."item_grants"
       SET "is_home" = true, "via_folder_id" = NULL,
           "write" = CASE WHEN "excluded" THEN false ELSE "write" END,
           "excluded" = false, "granted_by" = who, "granted_at" = now()
     WHERE "node_id" = node AND "workspace_id" = to_ws;
  ELSE
    INSERT INTO "public"."item_grants" ("node_id", "workspace_id", "write", "is_home", "granted_by")
    VALUES (node, to_ws, false, true, who);
  END IF;
  IF from_ws IS NOT NULL THEN
    IF keep_old THEN
      UPDATE "public"."item_grants" SET "write" = false
       WHERE "node_id" = node AND "workspace_id" = from_ws;
    ELSE
      DELETE FROM "public"."item_grants" WHERE "node_id" = node AND "workspace_id" = from_ws;
    END IF;
  END IF;
END
$$;
--> statement-breakpoint
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1791583563000;
