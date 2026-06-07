-- Add the two web-search worker kinds. ADD VALUE only — used (inserted) in the
-- next migration (0087), because Postgres forbids using a new enum value in the
-- same transaction it was added (the runner commits each migration separately).
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'search';--> statement-breakpoint
ALTER TYPE "ai_worker_kind" ADD VALUE IF NOT EXISTS 'search_advanced';
