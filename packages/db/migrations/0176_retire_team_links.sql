-- Member logins, Phase 6 stage 6: team-mode share links are retired. Members
-- read team items by level with their own logins, and nothing admits a team
-- code holder on /s any more, so every team link still live is revoked here.
-- An expired team link that was never revoked is revoked too: it still holds
-- the item's one-link slot (shares_node_active_uq is WHERE revoked_at IS NULL).
--
-- The item keeps its level: nodes.audience is not touched (the level is the
-- truth; a team item stays at team with no link, docs/access-levels.md
-- section 7). Public links are untouched. A visitor who opens an old team
-- /s link is told to sign in as a member.
--
-- Idempotent: only rows with no revoked_at are written. Cheap: team links are
-- few, and the statement touches only those rows.
UPDATE "shares"
   SET "revoked_at" = now()
 WHERE "revoked_at" IS NULL
   AND "settings"->>'mode' = 'team';
