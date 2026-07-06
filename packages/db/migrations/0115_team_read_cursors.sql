-- Admin unread tracking for Team Chat. One cursor per (owner, contact): the
-- last time the OWNER read that member's thread in /team-admin. Unread = the
-- member's inbound messages created after this cursor. contact_id CASCADEs with
-- the contact (the thread + membership go too), so a stale cursor never
-- outlives its member.

CREATE TABLE IF NOT EXISTS "team_read_cursors" (
  "owner_id"     uuid NOT NULL,
  "contact_id"   uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "last_read_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "contact_id")
);
