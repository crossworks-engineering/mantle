-- Workspaces W5b2 part B: an open link serves a list (plan page 4887b8e7,
-- section 8.1, decision 12).
--
-- A public link stays a per-item open door for people with no login. It is
-- not a grant, and it no longer follows (or sets) a level: it serves its
-- item plus the node ids it holds in shares.settings.served. A page, note,
-- task or event link: the items it names and embeds on that list; a drawing
-- link: the images its committed scene places; a folder link: the files and
-- subfolders under it on that list. A file added later to a shared folder is
-- not served until someone adds it.
--
-- 1. Every live open link on an item frozen at CLIENT is revoked and marked
--    retired (client logins C3: such a link was never served; 0192 revoked
--    them, and the read path kept refusing any that stayed live). The read
--    path stops reading levels, so it may not stay live.
-- 2. Every live open link (revoked_at null, contact_id null) gets the list
--    of what it serves TODAY, computed from the frozen levels:
--      - a page, note, task or event link: each item its text names that
--        the public read (its own level, inherited share or embedded share
--        at public, as the "Private item" filter read them); an embedded
--        file or drawing only at an OWN public level (the asset and drawing
--        routes read that alone); and the images of each drawing it embeds
--        that is public, when they are public (a drawing's snapshot carries
--        its images);
--      - a drawing link: the images its committed scene places that are
--        public;
--      - a folder link: the files and subfolders under it at public with no
--        folder above public between them and the shared folder.
--    A name is any uuid in the text (a page's committed doc, a note's
--    markdown, a task's body and checklist, an event's body) that is an
--    item of the owner; serving still asks that the item names it.
--    A file, app, table or formula link serves its item only: an empty list.
-- 3. A contact share holds no list: it serves what its item names, as
--    before.
--
-- No LLM work, no extractor notify. Narrowing only: nothing is served that
-- was not served before.

-- The ids an open link served under the level rules, as lower-case text.
CREATE OR REPLACE FUNCTION "public"."mantle_link_served_by_levels"(s uuid)
  RETURNS text[] LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
DECLARE
  sh record;
  it record;
  txt text;
  out_ids text[];
BEGIN
  SELECT x."owner_id", x."node_id" INTO sh FROM "public"."shares" x WHERE x."id" = s;
  IF NOT FOUND THEN RETURN '{}'::text[]; END IF;
  SELECT n."id", n."owner_id", n."type"::text AS "type", n."path", n."data" INTO it
    FROM "public"."nodes" n WHERE n."id" = sh."node_id" AND n."owner_id" = sh."owner_id";
  IF NOT FOUND THEN RETURN '{}'::text[]; END IF;

  IF it."type" = 'branch' THEN
    IF it."path" IS NULL THEN RETURN '{}'::text[]; END IF;
    SELECT coalesce(array_agg(lower(x."id"::text) ORDER BY x."id"), '{}'::text[]) INTO out_ids
      FROM "public"."nodes" x
     WHERE x."owner_id" = it."owner_id" AND x."type" IN ('file', 'branch')
       AND x."id" <> it."id" AND x."path" <@ it."path"
       AND x."audience"::text = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM "public"."nodes" b
          WHERE b."owner_id" = it."owner_id" AND b."type" = 'branch'
            AND b."path" <@ it."path" AND b."path" <> it."path" AND b."path" @> x."path"
            AND b."audience"::text <> 'public');
    RETURN out_ids;
  END IF;

  IF it."type" = 'draw' THEN
    SELECT coalesce(array_agg(lower(x."id"::text) ORDER BY x."id"), '{}'::text[]) INTO out_ids
      FROM "public"."node_embeds" e
      JOIN "public"."nodes" x ON x."id" = e."to_id" AND x."owner_id" = it."owner_id"
     WHERE e."from_id" = it."id" AND x."audience"::text = 'public';
    RETURN out_ids;
  END IF;

  IF it."type" NOT IN ('page', 'note', 'task', 'event') THEN RETURN '{}'::text[]; END IF;

  txt := CASE it."type"
    WHEN 'page' THEN (SELECT p."doc"::text FROM "public"."pages" p WHERE p."node_id" = it."id")
    WHEN 'note' THEN it."data"->>'content'
    WHEN 'task' THEN coalesce(it."data"->>'body', '') || ' ' || coalesce((it."data"->'todos')::text, '')
    ELSE it."data"->>'body'
  END;

  WITH named AS (
    SELECT DISTINCT lower(m[1])::uuid AS id
      FROM regexp_matches(coalesce(txt, ''),
             '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', 'g') m
  ),
  emb AS (
    SELECT e."to_id" AS id FROM "public"."node_embeds" e WHERE e."from_id" = it."id"
  ),
  cand AS (
    SELECT id FROM named UNION SELECT id FROM emb
  ),
  direct AS (
    SELECT x."id"
      FROM cand c
      JOIN "public"."nodes" x ON x."id" = c.id AND x."owner_id" = it."owner_id"
     WHERE x."id" <> it."id"
       AND CASE
             WHEN x."type" IN ('file', 'draw') AND c.id IN (SELECT id FROM emb)
               THEN x."audience"::text = 'public'
             ELSE x."audience"::text = 'public'
                  OR coalesce(x."inherited_level"::text = 'public', false)
                  OR coalesce(x."embedded_level"::text = 'public', false)
           END
  ),
  hop AS (
    SELECT y."id"
      FROM emb
      JOIN "public"."nodes" d ON d."id" = emb.id AND d."type" = 'draw'
                              AND d."owner_id" = it."owner_id" AND d."audience"::text = 'public'
      JOIN "public"."node_embeds" e2 ON e2."from_id" = d."id"
      JOIN "public"."nodes" y ON y."id" = e2."to_id" AND y."owner_id" = it."owner_id"
     WHERE y."audience"::text = 'public' AND y."id" <> it."id"
  )
  SELECT coalesce(array_agg(lower(u."id"::text) ORDER BY u."id"), '{}'::text[]) INTO out_ids
    FROM (SELECT "id" FROM direct UNION SELECT "id" FROM hop) u;
  RETURN out_ids;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_link_served_by_levels"(uuid) FROM PUBLIC;
--> statement-breakpoint

-- Fill the list of every live open link that has none yet. Returns how many
-- links were filled; a second run fills nothing.
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
SELECT * FROM "public"."mantle_link_served_fill"();
