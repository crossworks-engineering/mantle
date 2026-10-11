-- Workspaces W7a fix round 2: the login that made a sandbox.
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
-- No foreign key: a login that is gone leaves its sandbox to the brain
-- owner, as a row with no maker does.

ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS created_by uuid;
