-- Backfill for the media "filename-only false success" (fixed at intake in
-- v0.232.32). Before the hollow-body guard, a media file whose NAME cleared a
-- 20-char length check had that filename summarised, embedded and chunked as
-- if it were the document, and the trace said success. The guard stops new
-- ones; this clears the EXISTING lies so the sweep re-runs each node once and
-- records the honest terminal skip instead. LLM-FREE by construction: media
-- routes to `unsupported_media` (or the metadata-only spine) without any
-- model call, so re-queuing these cannot cause spend (cost-safety rule).
--
-- Scope is deliberately narrow: file nodes whose stored extension is a media
-- container. Other parserless formats (archives etc.) also carried the bug,
-- but their re-run is equally LLM-free only per-node — media is the common,
-- provably-safe case and the one this release's feature is built on.
UPDATE nodes
SET
  data = data - 'summary' - 'summary_model' - 'summary_at' - 'entities' - 'extract_completed_at',
  embedding = NULL
WHERE
  type = 'file'
  AND data->>'extension' IN ('mp4','mov','webm','mkv','avi','mp3','m4a','wav','ogg','oga','opus','flac','aac')
  AND (data ? 'summary' OR embedding IS NOT NULL);
--> statement-breakpoint
-- Their retrieval chunks are the sharper lie (the filename ranked as passage
-- content); remove them outright.
DELETE FROM content_chunks
WHERE node_id IN (
  SELECT id FROM nodes
  WHERE type = 'file'
    AND data->>'extension' IN ('mp4','mov','webm','mkv','avi','mp3','m4a','wav','ogg','oga','opus','flac','aac')
);
