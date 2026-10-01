-- Client logins, Phase C3: old client links retire (plan section 10,
-- decision 4 A). Before C1, "client" meant "anyone with the link"; since C2
-- clients sign in and read client items in the portal. So every link on an
-- item at CLIENT level is revoked here and marked `settings.retired =
-- 'client'`, and /s answers such a token with "Sign in as a client" (410, no
-- item title) instead of the content.
--
--   - a live link, and an expired one that was never revoked (it still
--     holds the item's one-link slot, shares_node_active_uq): revoked now
--     and marked;
--   - a link on a client item revoked earlier without the mark (client
--     logins audit A21: some C1 revokes did not write it): marked, its
--     revoked_at kept;
--   - links on items at any other level: untouched (a public item keeps
--     its link; an admin moved an item to public before C3 to keep one).
--
-- The item keeps its level: nodes.audience is not touched. Idempotent (a
-- second run finds nothing to write). Cheap: client-level links are few, and
-- lock_timeout keeps it from queueing behind a long reader.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."shares" s
   SET "revoked_at" = coalesce(s."revoked_at", now()),
       "settings" = coalesce(s."settings", '{}'::jsonb) || '{"retired":"client"}'::jsonb
  FROM "public"."nodes" n
 WHERE n."id" = s."node_id"
   AND n."audience" = 'client'
   AND (s."revoked_at" IS NULL
        OR coalesce(s."settings"->>'retired', '') <> 'client');
