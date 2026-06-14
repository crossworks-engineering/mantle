-- Per-(owner, agent) read cursor for the assistant inbox. `last_read_at` is how
-- far the operator has read that agent's forever-thread; unread = outbound
-- messages newer than this. Surfaced in the mobile companion's conversations
-- list. See packages/db/src/schema/assistant-read-cursors.ts.
CREATE TABLE "assistant_read_cursors" (
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL REFERENCES "agents"(id) ON DELETE CASCADE,
	"last_read_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "assistant_read_cursors_owner_id_agent_id_pk" PRIMARY KEY("owner_id","agent_id")
);
