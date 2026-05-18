-- assistant_messages — the web/assistant chat surface (Sarah-on-the-web).
--
-- Mirror of telegram_messages but transport-agnostic: just direction + text +
-- which agent handled the turn. No chat_id because the web assistant is a
-- single continuous conversation per owner (per the "no user-visible sessions"
-- principle).
--
-- The digest_node_id wiring is there for future summarizer support; left
-- unwired in v1 (web volume is too low to trigger digests yet, and the
-- responder loads recent_turns directly from this table).

CREATE TABLE assistant_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  text            text NOT NULL,
  agent_id        uuid REFERENCES agents(id) ON DELETE SET NULL,
  model           text,
  digest_node_id  uuid REFERENCES nodes(id) ON DELETE SET NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assistant_messages_owner_created_idx
  ON assistant_messages(owner_id, created_at DESC);

CREATE INDEX assistant_messages_owner_undigested_idx
  ON assistant_messages(owner_id, created_at)
  WHERE digest_node_id IS NULL;
