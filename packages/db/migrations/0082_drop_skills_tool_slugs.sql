-- Tools & Skills split, Phase 4 (docs/tools-and-skills.md): retire the dead
-- skills.tool_slugs column.
--
-- Skills are pure teaching now. Agent skills were drained in P1; the only other
-- user was the heartbeat fire path, which unioned a bound skill's tool_slugs into
-- the turn — but the sole such skill (profile_interview) carried only heartbeat
-- control tools, which the fire path already grants unconditionally via
-- HEARTBEAT_CONTROL_TOOLS. So the column confers nothing anywhere; dropping it is
-- behavior-identical. The fire-path union + all schema/code reads are removed in
-- the same change.

ALTER TABLE "skills" DROP COLUMN IF EXISTS "tool_slugs";
