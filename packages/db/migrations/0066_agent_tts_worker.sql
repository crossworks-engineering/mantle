-- Per-agent voice: an agent may pin which `kind='tts'` ai_worker synthesises
-- its spoken replies. NULL = fall back to the owner's default TTS worker
-- (getDefaultWorker(owner,'tts')) exactly as today, so existing agents keep
-- their current behaviour with no backfill. The worker owns provider + voice +
-- model + key; the agent only references it. ON DELETE SET NULL so deleting a
-- TTS worker simply reverts the agents that used it back to the default.
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS tts_worker_id uuid
  REFERENCES public.ai_workers(id) ON DELETE SET NULL;
