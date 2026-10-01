-- Levels drive links (docs/access-levels.md §7). From this release every share
-- change re-derives the item's level and every level change fixes the link.
-- Between 0159 and this release nothing kept the two in step, so re-derive the
-- level once from the links that exist now. Same rules as the code
-- (levelForShareMode in @mantle/content shares.ts), workspace kinds only:
--   a team-only link  -> team
--   an open link      -> stays client or public, anything higher -> public
-- Items without a link keep their level: a closure item is reached through
-- the item that embeds it, not through a link of its own.
UPDATE "public"."nodes" n SET "audience" = 'team'
  FROM "public"."shares" s
  WHERE s.node_id = n.id AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > now())
    AND s.settings->>'mode' = 'team'
    AND "public"."mantle_workspace_kind"(n.type) AND n.audience <> 'team';
--> statement-breakpoint
UPDATE "public"."nodes" n SET "audience" = 'public'
  FROM "public"."shares" s
  WHERE s.node_id = n.id AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > now())
    AND (s.settings->>'mode') IS DISTINCT FROM 'team'
    AND "public"."mantle_workspace_kind"(n.type) AND n.audience IN ('admin', 'team');
--> statement-breakpoint
-- A shared folder's contents come with it, as in 0159. Only ever LOWERS.
-- Inside nested shared folders the DEEPEST folder wins (an item takes the
-- level of the folder nearest it). Boxes that ran the first version of this
-- statement (an arbitrary folder won) keep the levels it set: the runner does
-- not re-run an applied migration.
UPDATE "public"."nodes" c SET "audience" = d.audience
  FROM (
    SELECT DISTINCT ON (i.id) i.id, f.audience
      FROM "public"."nodes" i
      JOIN "public"."nodes" f
        ON f.type = 'branch' AND f.audience <> 'admin'
       AND i.owner_id = f.owner_id AND i.id <> f.id
       AND i.path <@ f.path
     WHERE "public"."mantle_workspace_kind"(i.type) AND i.audience = 'admin'
     ORDER BY i.id, nlevel(f.path) DESC, f.id
  ) d
  WHERE c.id = d.id;
