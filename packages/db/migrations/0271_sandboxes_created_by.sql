-- Workspaces W7a fix rounds 2 and 3: the login that made a sandbox, a
-- heartbeat and an API tool.
--
-- Numbered 0271: 0268 (W7b), 0269 (W7c) and 0270 (W7d) are taken by the
-- W7 parts built alongside. It lands after them (journal when).
--
-- Any Admin user whose settings area is on may use the sandbox tools, and a
-- sandbox may mount a Files folder read-only (sandbox_create's inbox). So a
-- second Admin login could run commands in, or read files out of, a sandbox
-- the brain owner made, folder mount included. A sandbox now records the
-- login that made it: in a workspace scope the sandbox tools work only on
-- the caller's own sandboxes, and the brain owner (the anchor login) on
-- every one. A row made before this column has none, and counts as the
-- brain owner's. Only the brain owner mounts a folder.
--
-- A heartbeat (fix round 3) records the login that set up what it does (its
-- agent, skill, schedule, surface or state), when that is not the brain
-- owner: the tick fires it in that login's scope, so a second Admin login's
-- heartbeat never fires as the brain owner. Null: the brain owner's.
--
-- An API tool (fix round 3) records the login that wrote its templates,
-- when that is not the brain owner: at run time its {{secret:...}} and
-- {{oauth:...}} refs resolve only while that login holds the keys area.
-- Null: the brain owner's (and every tool a sync or the system made).
--
-- No foreign keys: a login that is gone leaves its rows to the rules above
-- (a sandbox to the brain owner; a heartbeat pauses; a tool's secrets stop
-- resolving).

ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS created_by uuid;
--> statement-breakpoint
ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS created_by uuid;
--> statement-breakpoint
ALTER TABLE tools ADD COLUMN IF NOT EXISTS created_by uuid;
