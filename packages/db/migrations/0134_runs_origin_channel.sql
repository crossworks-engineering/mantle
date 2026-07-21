-- 0134 — runner queues slice 3: channel-routed resume delivery (the WP2
-- riding-along). Captures the surface the run was created FROM (e.g.
-- {"kind":"telegram","chat_id":"…"}) so the ROOT resume's report is
-- delivered back to that channel instead of landing web-only. NULL = web /
-- background origin (today's behavior).

ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "origin_channel" jsonb;
