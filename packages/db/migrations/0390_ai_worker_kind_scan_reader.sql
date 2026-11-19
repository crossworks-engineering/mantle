-- Add the `scan_reader` worker kind: the Scan reader, a cheap model that
-- reads the text of a scanned page picture (docs/ai-workers.md, "The Scan
-- reader"). ADD VALUE only: nothing here uses the value, the first row is
-- written by the onboarding seed. Optional worker: a brain with none keeps
-- the old path of a scanned page (Tesseract, then the vision worker).
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'scan_reader';
