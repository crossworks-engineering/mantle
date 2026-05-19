-- skills.default_state — initial state shape a heartbeat inherits
-- when bound to this skill. Lets a skill declare its expected
-- starting state once (e.g. {answered: [], expecting_reply: false})
-- instead of every heartbeat using the skill repeating it.
--
-- Heartbeat creation: if the operator doesn't supply an explicit
-- `state` value, the form pre-fills from skills.default_state for
-- the selected skill. Edits to a heartbeat's `state` after creation
-- only affect that heartbeat (this column is not a foreign-key
-- reference; it's a template).
--
-- Free-form jsonb — same shape contract as heartbeats.state. See
-- docs/heartbeats.md §10 for the well-known keys engine code reads.

ALTER TABLE skills
  ADD COLUMN default_state jsonb NOT NULL DEFAULT '{}'::jsonb;
