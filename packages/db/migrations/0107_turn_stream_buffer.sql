-- Short-lived replay buffer for live turn events (live-turn-streaming Phase 4).
-- Postgres NOTIFY has no backlog, so a subscriber whose SSE socket drops and
-- reconnects (mobile background/foreground, a network blip, navigation) misses
-- every delta emitted during the gap. The producer (publishTurnEvent in
-- @mantle/turn-stream) writes each TurnEvent here keyed by (turn_id, seq); the
-- SSE route replays seq > N for a reconnecting client that sends
-- `Last-Event-ID: N` before live-tailing. See docs/live-turn-streaming.md §2/§7.
--
-- Ephemeral, NOT durable: liveness only. The authoritative answer is the
-- assistant_messages row (journaled by DBOS, entirely separately) — a lost
-- buffer row is as cosmetic as a lost delta. The producer sweeps rows past a
-- short TTL lazily (on each turn-start), so the table stays small. Plain DDL,
-- fully reversible (DROP TABLE).
--
-- turn_id is the client-minted idempotency-key (also the workflow id + stream
-- correlation id), so text, not a generated uuid. (turn_id, seq) is the natural
-- key AND the index the replay query range-scans (turn_id =, seq >). The
-- created_at index drives the TTL sweep.
CREATE TABLE "turn_stream_buffer" (
  "turn_id" text NOT NULL,
  "seq" integer NOT NULL,
  "owner_id" uuid NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "turn_stream_buffer_turn_id_seq_pk" PRIMARY KEY ("turn_id", "seq")
);
--> statement-breakpoint
CREATE INDEX "turn_stream_buffer_created_idx" ON "turn_stream_buffer" ("created_at");
