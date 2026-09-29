-- Client level counts: what a box holds at the client and public levels,
-- before and after rolling onto the client logins releases (migrations 0186,
-- 0187 and later; docs/update-prod.md). READ ONLY: one read-only transaction,
-- rolled back at the end; it changes nothing.
--
-- Run from a checkout of this repo (the file is not installed on boxes):
--   ssh <box> "docker exec -i mantle_pg psql -U postgres -d postgres -X -q" < scripts/client-level-counts.sql
-- Works on v0.232.315 and later (needs mantle_brain_id and
-- mantle_workspace_kind, migration 0159).
BEGIN READ ONLY;
\pset footer off
\echo '== 0. box sanity: last migration and login roles'
SELECT max(created_at) AS last_migration_when, count(*) AS migrations FROM drizzle.__drizzle_migrations;
SELECT role, count(*) AS logins, count(*) FILTER (WHERE disabled_at IS NULL) AS active FROM auth.users GROUP BY role ORDER BY role;

\echo '== 1. client-level items in the brain, by type (ws = a workspace kind a client login could read)'
SELECT n.type, mantle_workspace_kind(n.type) AS ws, count(*) AS items
  FROM nodes n
 WHERE n.owner_id = mantle_brain_id() AND n.audience = 'client'
 GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '== 2. links on client-level items (live = what /s still serves; stale = expired, never revoked)'
SELECT count(*) FILTER (WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())) AS live_links,
       count(*) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at <= now())                         AS stale_links,
       count(DISTINCT s.node_id) FILTER (WHERE s.revoked_at IS NULL)                                  AS items_with_unrevoked_link,
       coalesce(sum(s.view_count) FILTER (WHERE s.revoked_at IS NULL), 0)                             AS views_on_unrevoked,
       max(s.last_viewed_at) FILTER (WHERE s.revoked_at IS NULL)                                      AS last_view
  FROM shares s JOIN nodes n ON n.id = s.node_id
 WHERE n.owner_id = mantle_brain_id() AND n.audience = 'client';

\echo '== 2b. client-level items reached through a live link on a FOLDER above them'
SELECT count(DISTINCT i.id) AS client_items_under_linked_folder
  FROM nodes i
  JOIN nodes f ON f.type = 'branch' AND f.owner_id = i.owner_id AND i.path <@ f.path AND f.id <> i.id
  JOIN shares s ON s.node_id = f.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
 WHERE i.owner_id = mantle_brain_id() AND i.audience = 'client';

\echo '== 3. public items (a client login no longer reads these after 0187), by where the level came from'
WITH pub AS (
  SELECT n.id, n.type, n.path, n.owner_id FROM nodes n
   WHERE n.owner_id = mantle_brain_id() AND n.audience = 'public' AND mantle_workspace_kind(n.type)
), tagged AS (
  SELECT p.id, p.type,
         EXISTS (SELECT 1 FROM shares s WHERE s.node_id = p.id AND s.revoked_at IS NULL
                   AND (s.expires_at IS NULL OR s.expires_at > now()))                         AS own_live_link,
         EXISTS (SELECT 1 FROM shares s WHERE s.node_id = p.id AND s.created_at < '2026-09-27') AS link_before_0161,
         EXISTS (SELECT 1 FROM nodes f WHERE f.type = 'branch' AND f.owner_id = p.owner_id
                   AND f.id <> p.id AND p.path <@ f.path AND f.audience = 'public')           AS under_public_folder
    FROM pub p
)
SELECT count(*)                                                   AS public_items,
       count(*) FILTER (WHERE own_live_link)                      AS with_own_live_link,
       count(*) FILTER (WHERE link_before_0161)                   AS likely_set_by_0161_link,
       count(*) FILTER (WHERE under_public_folder)                AS under_public_folder,
       count(*) FILTER (WHERE NOT own_live_link AND NOT under_public_folder) AS no_link_no_folder
  FROM tagged;

\echo '== 4. agents and tool groups at client level (their turns run on the client role: after 0187 they read client items only)'
SELECT 'agent' AS kind, audience, count(*) FROM agents WHERE audience IN ('client', 'public') GROUP BY 1, 2
UNION ALL
SELECT 'tool_group', audience, count(*) FROM tool_groups WHERE audience IN ('client', 'public') GROUP BY 1, 2
ORDER BY 1, 2;
ROLLBACK;
