-- One definer for the structure items a narrow exit makes, edits and
-- removes (plan v3.2 S7b part b2): the Secrets root, a secret, a peer, a
-- contact, a documentation item and the folders above one, and the events a
-- calendar synced. Before this, each
-- ran at a full-route spot (packages/db viewer.ts FULL_ROUTE_SPOTS
-- secrets-root, secret-item, peer-item, sender-contact, docs-collection,
-- calendar-events):
-- the area's narrow exit wrote nodes on the system pool's own login. Now the
-- narrow role runs this function and holds no right on nodes; the function
-- writes nodes as its owner, under its own check.
--
-- mantle_structure_item(kind, op, login, owner, items, fields): the KIND is
-- one of a fixed list, and the list fixes the item's type, the area its
-- writer must hold, the operations open to it and, for a new item, where it
-- may land:
--
--   kind           type           area        ops                    lands at
--   secrets-root   branch         keys        insert                 secrets
--   secret-item    secret         keys        insert update delete   secrets
--   peer-item      mantle_peer    connectors  insert delete          peers
--   contact-item   contact        connectors  insert                 contacts
--   docs-folder    branch         settings    insert                 documentation or under it
--   docs-item      documentation  settings    insert update delete   documentation or under it
--   calendar-event event          connectors  delete                 (a synced event only)
--
-- On the narrow login the acting login is a mistake guard, not a boundary:
-- a raw narrow session may name any acting login (only the gateway's text
-- check refuses a narrow statement that names it). The database boundaries
-- there are each definer's own kind, op, place, type and owner checks and
-- the narrow role's column rights (access-matrix.ts NARROW_COLUMN_RIGHTS:
-- no credential or rights column of auth.users, no new login, no minted
-- credential). A definer the narrow role may run must therefore give
-- nothing whichever login it is told it acts for.
--
-- Any other kind or operation is refused (42501). The caller: no scope
-- (a scope's own writes go through the write role), a system session
-- (mantle_system_session: the runtime role, the narrow role, a superuser
-- or the definers' owner, 0314's rule), LOGIN equal to the acting login the gateway sends
-- (mantle.acting_login; none, or another, is refused), and that login
-- holding the kind's area (mantle_area_rule: an Admin workspace member
-- whose areas do not take it away). OWNER must be this brain. A read-only
-- caller (mantle.write_mode ro) is refused.
--
-- What each operation does is what the app's own code did on the system
-- pool, so every answer is the same (placement, the create home its
-- triggers stamp, readers):
--  - insert: the heads of the folder the item lands in, shared (as
--    withNodeInsertHeads), then one row: type and owner from the list,
--    title, slug, path, data (default {}), tags (default {}) from FIELDS. A
--    branch kind does nothing on a branch already at that path (the app's
--    onConflictDoNothing). Returns the new id, or nothing.
--  - update (one item of the kind's type): title and tags when FIELDS
--    names them, data (FIELDS must name it: 22023 otherwise, never a wipe),
--    updated_at; then, when FIELDS' work is extract,
--    the index reset markContentChanged sends (packages/db
--    content-changed.ts and index-work.ts stampIndexWork, kept equal by
--    structure-item.db.test.ts), and node_ingested when FIELDS' announce is
--    true. The two kinds that edit (secret-item, docs-item) index no field
--    for embed work only (the kind registry), so no other reset is open.
--    No heads, as the app's update took none. Returns the id, or nothing.
--  - delete (items of the kind's type; for calendar-event only an event a
--    calendar synced, data.external_account_id set; when FIELDS names a
--    match, only rows whose data holds it: the account a calendar's events
--    came from, the collection a purge removes, read again under the
--    heads): the heads of each and of the folder it sits in, for update (as
--    withNodeDeleteHeads), then the rows; their foreign keys cascade as
--    before. Returns the ids removed.
-- The heads go through mantle_lock_heads_nested: the first lock of the
-- transaction, or more heads where some are held, as the app's own call.
--
-- EXECUTE: taken from PUBLIC here; migrate gives it to the runtime role
-- (runtime-role.ts RUNTIME_SYSTEM_FUNCTIONS) and the narrow role
-- (NARROW_SYSTEM_FUNCTIONS). The write role and the user role hold none.
-- No table, row or trigger changes; no LLM work. Re-runnable. Revert:
-- packages/db/rollback/0315_structure_item_definer.revert.sql (not needed
-- for a one-image rollback: the image before this one never calls it). The
-- `when` sits 60000 above 0314's.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_structure_item"(
  kind text, op text, login uuid, owner uuid, items uuid[], fields jsonb)
  RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  t "public"."node_type";
  need_area text;
  ops text[];
  place ltree;
  lands boolean;
  folder uuid;
  heads uuid[];
  new_id uuid;
  w text;
  m jsonb;
BEGIN
  IF coalesce(current_setting('mantle.write_mode', true), '') = 'ro' THEN
    RAISE EXCEPTION 'mantle_structure_item: a read-only caller' USING ERRCODE = '42501';
  END IF;
  CASE "mantle_structure_item"."kind"
    WHEN 'secrets-root' THEN t := 'branch'; need_area := 'keys'; ops := ARRAY['insert'];
    WHEN 'secret-item' THEN t := 'secret'; need_area := 'keys'; ops := ARRAY['insert', 'update', 'delete'];
    WHEN 'peer-item' THEN t := 'mantle_peer'; need_area := 'connectors'; ops := ARRAY['insert', 'delete'];
    WHEN 'contact-item' THEN t := 'contact'; need_area := 'connectors'; ops := ARRAY['insert'];
    WHEN 'docs-folder' THEN t := 'branch'; need_area := 'settings'; ops := ARRAY['insert'];
    WHEN 'docs-item' THEN
      t := 'documentation'; need_area := 'settings'; ops := ARRAY['insert', 'update', 'delete'];
    WHEN 'calendar-event' THEN t := 'event'; need_area := 'connectors'; ops := ARRAY['delete'];
    ELSE
      RAISE EXCEPTION 'mantle_structure_item: not a listed kind' USING ERRCODE = '42501';
  END CASE;
  IF "mantle_structure_item"."op" IS NULL OR NOT ("mantle_structure_item"."op" = ANY (ops)) THEN
    RAISE EXCEPTION 'mantle_structure_item: not an operation of this kind' USING ERRCODE = '42501';
  END IF;
  IF "public"."mantle_scope_active"() OR "public"."mantle_scope_login_id"() IS NOT NULL THEN
    RAISE EXCEPTION 'mantle_structure_item: only with no scope' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_system_session"() THEN
    RAISE EXCEPTION 'mantle_structure_item: not a system session' USING ERRCODE = '42501';
  ELSIF "mantle_structure_item"."login" IS NULL
     OR "mantle_structure_item"."login" IS DISTINCT FROM
        nullif(current_setting('mantle.acting_login', true), '')::uuid THEN
    RAISE EXCEPTION 'mantle_structure_item: only the acting login' USING ERRCODE = '42501';
  ELSIF NOT "public"."mantle_area_rule"("mantle_structure_item"."login", need_area) THEN
    RAISE EXCEPTION 'mantle_structure_item: the acting login does not hold the area' USING ERRCODE = '42501';
  END IF;
  IF "mantle_structure_item"."owner" IS DISTINCT FROM "public"."mantle_brain_id"() THEN
    RAISE EXCEPTION 'mantle_structure_item: only on this brain' USING ERRCODE = '42501';
  END IF;

  IF "mantle_structure_item"."op" = 'insert' THEN
    place := ("mantle_structure_item"."fields" ->> 'path')::ltree;
    -- An assignment, not the IF's own test: plpgsql ends an IF's test at
    -- its first THEN, a CASE's included.
    lands := CASE "mantle_structure_item"."kind"
               WHEN 'secrets-root' THEN place = 'secrets'::ltree
               WHEN 'secret-item' THEN place = 'secrets'::ltree
               WHEN 'peer-item' THEN place = 'peers'::ltree
               WHEN 'contact-item' THEN place = 'contacts'::ltree
               ELSE place <@ 'documentation'::ltree
             END;
    IF place IS NULL OR NOT coalesce(lands, false) THEN
      RAISE EXCEPTION 'mantle_structure_item: not where this kind lands' USING ERRCODE = '42501';
    END IF;
    folder := "public"."mantle_parent_folder"("mantle_structure_item"."owner", t, place);
    PERFORM "public"."mantle_lock_heads_nested"(
      CASE WHEN folder IS NULL THEN '{}'::uuid[] ELSE ARRAY[folder] END, 'share');
    IF t = 'branch' THEN
      INSERT INTO "public"."nodes" ("owner_id", "type", "title", "slug", "path", "data", "tags")
      VALUES ("mantle_structure_item"."owner", t, "mantle_structure_item"."fields" ->> 'title',
              "mantle_structure_item"."fields" ->> 'slug', place,
              coalesce("mantle_structure_item"."fields" -> 'data', '{}'::jsonb),
              CASE WHEN "mantle_structure_item"."fields" ? 'tags'
                   THEN ARRAY(SELECT jsonb_array_elements_text("mantle_structure_item"."fields" -> 'tags'))
                   ELSE '{}'::text[] END)
      ON CONFLICT ("owner_id", "path") WHERE "type" = 'branch' DO NOTHING
      RETURNING "id" INTO new_id;
    ELSE
      INSERT INTO "public"."nodes" ("owner_id", "type", "title", "slug", "path", "data", "tags")
      VALUES ("mantle_structure_item"."owner", t, "mantle_structure_item"."fields" ->> 'title',
              "mantle_structure_item"."fields" ->> 'slug', place,
              coalesce("mantle_structure_item"."fields" -> 'data', '{}'::jsonb),
              CASE WHEN "mantle_structure_item"."fields" ? 'tags'
                   THEN ARRAY(SELECT jsonb_array_elements_text("mantle_structure_item"."fields" -> 'tags'))
                   ELSE '{}'::text[] END)
      RETURNING "id" INTO new_id;
    END IF;
    IF new_id IS NOT NULL THEN RETURN NEXT new_id; END IF;
    RETURN;
  END IF;

  IF "mantle_structure_item"."op" = 'update' THEN
    IF coalesce(cardinality("mantle_structure_item"."items"), 0) <> 1 THEN
      RAISE EXCEPTION 'mantle_structure_item: an update names one item' USING ERRCODE = '22023';
    END IF;
    -- An edit names its data (the app's update always sets it): none is a
    -- caller's mistake, never a wipe to {}.
    IF "mantle_structure_item"."fields" IS NULL OR NOT ("mantle_structure_item"."fields" ? 'data')
       OR jsonb_typeof("mantle_structure_item"."fields" -> 'data') <> 'object' THEN
      RAISE EXCEPTION 'mantle_structure_item: an update names its data' USING ERRCODE = '22023';
    END IF;
    w := "mantle_structure_item"."fields" ->> 'work';
    IF w IS NOT NULL AND w <> 'extract' THEN
      RAISE EXCEPTION 'mantle_structure_item: the only work is extract' USING ERRCODE = '22023';
    END IF;
    UPDATE "public"."nodes" n
       SET "title" = CASE WHEN "mantle_structure_item"."fields" ? 'title'
                          THEN "mantle_structure_item"."fields" ->> 'title' ELSE n."title" END,
           "tags" = CASE WHEN "mantle_structure_item"."fields" ? 'tags'
                         THEN ARRAY(SELECT jsonb_array_elements_text("mantle_structure_item"."fields" -> 'tags'))
                         ELSE n."tags" END,
           "data" = "mantle_structure_item"."fields" -> 'data',
           "updated_at" = now()
     WHERE n."id" = "mantle_structure_item"."items"[1]
       AND n."owner_id" = "mantle_structure_item"."owner" AND n."type" = t
    RETURNING n."id" INTO new_id;
    IF new_id IS NULL THEN RETURN; END IF;
    -- The extract reset of markContentChanged (index-work.ts stampIndexWork
    -- with content-changed.ts SUMMARY_KEYS), equal by structure-item.db.test.ts.
    IF w = 'extract' THEN
      UPDATE "public"."nodes" n
         SET "embedding" = NULL,
             "data" = (coalesce(n."data", '{}'::jsonb)
                        - array['summary', 'summary_model', 'summary_at', 'entities']::text[]
                        - array['index_work', 'index_work_had_vector']::text[])
                      || jsonb_build_object('index_work'::text, 'extract')
       WHERE n."id" = new_id;
    END IF;
    IF w IS NOT NULL AND coalesce(("mantle_structure_item"."fields" ->> 'announce')::boolean, false) THEN
      PERFORM pg_notify('node_ingested', new_id::text);
    END IF;
    RETURN NEXT new_id;
    RETURN;
  END IF;

  -- delete. FIELDS' match (an object, or none) narrows the rows to those
  -- whose data holds it, read again here under the heads: a calendar's
  -- account id, a collection's key (the app's own delete names the same).
  m := "mantle_structure_item"."fields" -> 'match';
  IF m IS NOT NULL AND jsonb_typeof(m) <> 'object' THEN
    RAISE EXCEPTION 'mantle_structure_item: a delete''s match is an object' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x."id"), '{}'::uuid[]) INTO heads FROM (
    SELECT n."id" FROM "public"."nodes" n
     WHERE n."id" = ANY ("mantle_structure_item"."items")
       AND n."owner_id" = "mantle_structure_item"."owner" AND n."type" = t
       AND ("mantle_structure_item"."kind" <> 'calendar-event' OR n."data" ? 'external_account_id')
       AND (m IS NULL OR n."data" @> m)
    UNION
    SELECT "public"."mantle_parent_folder"(n."owner_id", n."type", n."path") FROM "public"."nodes" n
     WHERE n."id" = ANY ("mantle_structure_item"."items")
       AND n."owner_id" = "mantle_structure_item"."owner" AND n."type" = t
       AND ("mantle_structure_item"."kind" <> 'calendar-event' OR n."data" ? 'external_account_id')
       AND (m IS NULL OR n."data" @> m)
  ) x WHERE x."id" IS NOT NULL;
  PERFORM "public"."mantle_lock_heads_nested"(heads, 'update');
  RETURN QUERY
    DELETE FROM "public"."nodes" n
     WHERE n."id" = ANY ("mantle_structure_item"."items")
       AND n."owner_id" = "mantle_structure_item"."owner" AND n."type" = t
       AND ("mantle_structure_item"."kind" <> 'calendar-event' OR n."data" ? 'external_account_id')
       AND (m IS NULL OR n."data" @> m)
    RETURNING n."id";
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_structure_item"(text, text, uuid, uuid, uuid[], jsonb) FROM PUBLIC;
