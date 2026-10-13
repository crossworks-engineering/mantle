-- Workspaces arch A3a (plan v2 page fcc4aee4, sections 5.2, 5.3, 19 and
-- 20.3; docs/edit-check.md): the per-table and per-operation checks, behind
-- mantle.edit_check (0280). Off is today's behaviour exactly: the triggers
-- this phase makes are disabled on a box that is off.
--
-- 1. mantle_node_derived_keys(): the keys of nodes.data that only the
--    brain sets (the extractor, the summarizer, the folds, the sync and
--    migration markers), from the writers' inventory
--    (packages/db/src/edit-check.ts pins the list and its writers). A
--    non-system write may clear one (an edit invalidates what the brain
--    derived from the old content), never set or change one.
--    mantle_node_presentation_keys(): rank, the one presentation key (a
--    board or tree order: edit of the item OR of its folder, plan 20.3).
-- 2. mantle_edit_check_trg: the one trigger function of the per-table
--    checks. Its triggers (mantle_edit_check and mantle_edit_check_<suffix>)
--    are made by migrate from the access matrix (access-matrix.ts,
--    editCheck: editCheckTriggers), on the write role only (WHEN
--    current_user = 'mantle_write_user'), each with the need it asks of the
--    row's item and only for the operations and columns that need more than
--    the write check (0278) already asks. Arguments: the need (edit, manage,
--    admin, appdata, link, link_close; 'system': refused, only the brain
--    changes that column), the column naming the item ('self' on nodes),
--    the table that names it ('recall_maps' for a Recall card or revision,
--    else ''), and the mode ('keys': the derived keys of nodes.data;
--    'contact': a row with a contact_id, a contact share, needs admin
--    instead: the guide's "Share it with one contact: to be an Admin user,
--    its home is not checked"). A row whose item is gone passes (its
--    foreign key, or the row rule, decides).
--    Every refusal goes through mantle_edit_refuse (0280): off runs, warn
--    reports, on refuses (42501, detail no_edit, read_only or ro_actor).
-- 3. The write check (0278, 0279) asks its rights through the one rule
--    (mantle_check_row) and its rank exemption through
--    mantle_node_presentation_keys(). Same answers.
-- 4. Two definers so a login's transaction writes no table the write role
--    holds no right on (the last write-role gaps, arch A2b2b):
--     - mantle_recall_retarget(map, old_slug, new_slug): a renamed map's
--       cross-map options in every map of the brain (the brain's own
--       references, also in maps the caller cannot read), only for a map
--       the scope may edit, still answering to old_slug;
--     - mantle_secret_put(node, ciphertext, key_version): a secret's sealed
--       value, only for a secret node the scope may edit; the role never
--       reads or writes the secrets table itself.
--    Each checks only while a scope is set (as the grant definers of 0279),
--    through the edit check's gate.
--
-- Re-runnable.

-- 1. The keys. What the extractor writes about a file's bytes (the read-only
--    snapshot copy's list of 0267, which may change on a copy; the files'
--    BYTE_DERIVED_DATA_KEYS), named once and used by both.
CREATE OR REPLACE FUNCTION "public"."mantle_node_extractor_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['extract_skipped', 'extract_completed_at', 'extract_incomplete',
               'indexing_applied', 'summary', 'summary_model', 'summary_at',
               'entities', 'text', 'vision_model', 'ocr', 'native_pdf',
               'schemaDigest']::text[]
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_derived_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT "public"."mantle_node_extractor_keys"() || ARRAY[
    -- the extractor's own markers (extract-heads-park.ts, index-writes.ts)
    'extract_parked', 'summary_folded',
    -- the refold (gates.ts, maintenance/refold-embeds.ts)
    'refolded',
    -- markers of system work (email sync, the app-nav backfills, the folds,
    -- a backfill script)
    'emailAttachment', 'appNavMigratingAt', 'appNavMigratedAt', 'appMarksMigrated',
    'trashedBeforeFold', 'trashedAt', 'space_file', 'salience_reason'
  ]::text[]
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_node_presentation_keys"()
  RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['rank']::text[]
$$;
--> statement-breakpoint

-- The read-only snapshot copy (0267's body) on the named list: the same 13
-- keys, so the same answers.
CREATE OR REPLACE FUNCTION "public"."mantle_snapshot_copy_node_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  derived text[] := "public"."mantle_node_extractor_keys"();
BEGIN
  IF NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."slug" IS DISTINCT FROM OLD."slug"
     OR NEW."tags" IS DISTINCT FROM OLD."tags"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR (coalesce(NEW."data", '{}'::jsonb) - derived)
        IS DISTINCT FROM (coalesce(OLD."data", '{}'::jsonb) - derived) THEN
    IF "public"."mantle_bypass_verified"() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'not allowed to change this item: it is a read-only snapshot copy'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_snapshot_copy_node_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 2. The per-table checks.
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

-- 3. The write check (0279's body) on the one rule. Same answers: edit is
--    mantle_check_row's edit, manage of a home its manage, and the rank-only
--    exemption the presentation keys.
CREATE OR REPLACE FUNCTION "public"."mantle_write_check_trg"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  kind text := TG_ARGV[0];
  col text := TG_ARGV[1];
  seen jsonb[] := ARRAY[]::jsonb[];
  r jsonb;
  item uuid;
  n record;
  f record;
  ok boolean;
  ws uuid[];
  generated text[];
  target uuid;
BEGIN
  IF kind = 'self' THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT "public"."mantle_may_add_to_folder"(NEW."owner_id", NEW."type", NEW."path") THEN
        RAISE EXCEPTION 'not allowed to add items to that folder' USING ERRCODE = '42501';
      END IF;
      IF NOT "public"."mantle_may_create_item"(NEW."owner_id", NEW."type", NEW."path")
         AND "public"."mantle_scoped_write_refuses"('INSERT on nodes: no Moderator of the home') THEN
        RAISE EXCEPTION 'not allowed to create an item in that workspace' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW."type" IS DISTINCT FROM OLD."type"
         AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: a change of kind') THEN
        RAISE EXCEPTION 'not allowed to change the kind of this item' USING ERRCODE = '42501';
      END IF;
      ok := "public"."mantle_check_row"(OLD."home_ws", OLD."write_ws", OLD."read_ws", 'edit');
      IF NOT ok THEN
        -- A change of the presentation keys alone (a board rank): edit of
        -- the item or of its folder. Stored generated columns are not
        -- computed yet in a BEFORE trigger's NEW: left out of the comparison.
        generated := ARRAY(SELECT a."attname"::text FROM pg_attribute a
                            WHERE a."attrelid" = TG_RELID AND a."attgenerated" <> '');
        IF (to_jsonb(NEW) - generated - 'data' - 'updated_at')
             = (to_jsonb(OLD) - generated - 'data' - 'updated_at')
           AND (coalesce(NEW."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"())
               = (coalesce(OLD."data", '{}'::jsonb) - "public"."mantle_node_presentation_keys"()) THEN
          SELECT p."home_ws", p."write_ws", p."read_ws" INTO f FROM "public"."nodes" p
           WHERE p."id" = "public"."mantle_parent_folder"(OLD."owner_id", OLD."type", OLD."path");
          ok := FOUND AND "public"."mantle_check_row"(f."home_ws", f."write_ws", f."read_ws", 'edit');
        END IF;
      END IF;
      IF NOT ok AND "public"."mantle_scoped_write_refuses"('UPDATE on nodes: no edit of the item') THEN
        RAISE EXCEPTION 'not allowed to edit this item' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD."home_ws" IS NULL AND NOT "public"."mantle_may_manage_home"(NULL)
         AND "public"."mantle_scoped_write_refuses"('DELETE on nodes: no home, no Admin scope') THEN
        RAISE EXCEPTION 'not allowed to delete this item' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN seen := seen || to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN seen := seen || to_jsonb(NEW); END IF;
  FOREACH r IN ARRAY seen LOOP
    item := (r ->> col)::uuid;
    IF item IS NULL THEN
      -- A row of no item: inside the scope, and the caller's own.
      IF kind = 'manage' OR NOT (r ? 'read_ws') THEN
        ok := false;
      ELSE
        ws := ARRAY(SELECT jsonb_array_elements_text(r -> 'read_ws'))::uuid[];
        ok := ws <@ "public"."mantle_scope_ws"()
              AND coalesce((r ->> 'login_id')::uuid = "public"."mantle_login_id"(), false);
      END IF;
    ELSE
      SELECT x."home_ws", x."write_ws", x."read_ws" INTO n FROM "public"."nodes" x WHERE x."id" = item;
      IF NOT FOUND THEN
        ok := true; -- no such item: its foreign key refuses the row
      ELSE
        ok := "public"."mantle_check_row"(n."home_ws", n."write_ws", n."read_ws",
                                          CASE WHEN kind = 'manage' THEN 'manage' ELSE 'edit' END);
      END IF;
    END IF;
    IF NOT ok AND "public"."mantle_scoped_write_refuses"(
         format('%s on %s: no %s of the item', TG_OP, TG_TABLE_NAME, kind)) THEN
      RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A new grant, one moved to another workspace, or one made the home: a
  -- Moderator of its workspace.
  IF kind = 'manage' AND TG_OP IN ('INSERT', 'UPDATE') THEN
    target := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
    IF (TG_OP = 'INSERT'
        OR target IS DISTINCT FROM (to_jsonb(OLD) ->> 'workspace_id')::uuid
        OR (coalesce((to_jsonb(NEW) ->> 'is_home')::boolean, false)
            AND NOT coalesce((to_jsonb(OLD) ->> 'is_home')::boolean, false)))
       AND NOT coalesce(target = ANY ("public"."mantle_scope_mod_ws"()), false)
       AND "public"."mantle_scoped_write_refuses"(
             format('%s on %s: not a Moderator of the workspace', TG_OP, TG_TABLE_NAME)) THEN
      RAISE EXCEPTION 'not allowed to grant to that workspace' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_write_check_trg"() FROM PUBLIC;
--> statement-breakpoint

-- 4. The two definers.
CREATE OR REPLACE FUNCTION "public"."mantle_recall_retarget"(map uuid, old_slug text, new_slug text)
  RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  m record;
  n integer;
BEGIN
  SELECT x."owner_id", x."node_id", x."slug" INTO m FROM "public"."recall_maps" x WHERE x."id" = map;
  IF NOT FOUND OR m."slug" IS DISTINCT FROM old_slug OR new_slug IS NULL
     OR new_slug !~ '^[a-z0-9][a-z0-9-]{0,119}$' OR new_slug = old_slug THEN
    RAISE EXCEPTION 'mantle_recall_retarget: map % does not answer to that slug, or the new one is not a slug', map
      USING ERRCODE = '22023';
  END IF;
  -- The write role always carries a scope; with none it is refused.
  IF "public"."mantle_caller_is_write_role"() AND NOT "public"."mantle_scope_active"() THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501', DETAIL = 'no_edit';
  END IF;
  IF "public"."mantle_scope_active"()
     AND NOT coalesce("public"."mantle_check_item"(m."node_id", 'edit'), false) THEN
    PERFORM "public"."mantle_edit_refuse"('UPDATE on recall_nodes: a renamed map the scope may not edit',
      'no_edit', 'not allowed to change this item');
  END IF;
  -- The map takes the new slug here, with its old one kept as a former slug,
  -- so the options rewritten below always name the map's own slug.
  UPDATE "public"."recall_maps"
     SET "slug" = new_slug,
         "former_slugs" = ARRAY(SELECT DISTINCT s FROM unnest("former_slugs" || old_slug) AS s
                                 WHERE s <> new_slug ORDER BY s)
   WHERE "id" = map;
  UPDATE "public"."recall_nodes"
     SET "options" = (
       SELECT jsonb_agg(
         CASE WHEN o->>'targetMap' = old_slug
              THEN jsonb_set(jsonb_set(o, '{targetMap}', to_jsonb(new_slug)), '{targetSlug}', to_jsonb(new_slug))
              ELSE o END)
         FROM jsonb_array_elements("options") o)
   WHERE "owner_id" = m."owner_id"
     AND "options" @> jsonb_build_array(jsonb_build_object('targetMap', old_slug));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_recall_retarget"(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_secret_put"(node uuid, sealed bytea, key_version integer)
  RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "public"."nodes" n WHERE n."id" = node AND n."type" = 'secret') THEN
    RAISE EXCEPTION 'mantle_secret_put: % is not a secret', node USING ERRCODE = '22023';
  END IF;
  -- The write role always carries a scope; with none it is refused.
  IF "public"."mantle_caller_is_write_role"() AND NOT "public"."mantle_scope_active"() THEN
    RAISE EXCEPTION 'not allowed to change this item' USING ERRCODE = '42501', DETAIL = 'no_edit';
  END IF;
  IF "public"."mantle_scope_active"()
     AND NOT coalesce("public"."mantle_check_item"(node, 'edit'), false) THEN
    PERFORM "public"."mantle_edit_refuse"('INSERT on secrets: a secret the scope may not edit',
      'no_edit', 'not allowed to change this item');
  END IF;
  INSERT INTO "public"."secrets" ("node_id", "ciphertext", "key_version")
  VALUES (node, sealed, coalesce(key_version, 1));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_secret_put"(uuid, bytea, integer) FROM PUBLIC;
