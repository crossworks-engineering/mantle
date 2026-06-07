-- Backfill the two web-search workers for existing brains (new brains get them
-- from onboarding-provision.ts). One default per kind, on the owner's OpenRouter
-- key (preferring the 'default' label, else the earliest). Idempotent: skips any
-- owner that already has a worker of that kind, and ON CONFLICT on (owner, slug).
INSERT INTO "ai_workers" ("owner_id","slug","name","kind","provider","model","api_key_id","is_default","enabled")
SELECT k.user_id, 'web-search', 'Web search', 'search', 'openrouter', 'perplexity/sonar', k.id, true, true
FROM (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM "api_keys"
  WHERE service = 'openrouter'
  ORDER BY user_id, (label = 'default') DESC, created_at ASC
) k
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_workers" w WHERE w.owner_id = k.user_id AND w.kind = 'search'
)
ON CONFLICT ("owner_id","slug") DO NOTHING;--> statement-breakpoint
INSERT INTO "ai_workers" ("owner_id","slug","name","kind","provider","model","api_key_id","is_default","enabled")
SELECT k.user_id, 'web-search-pro', 'Deep web search', 'search_advanced', 'openrouter', 'perplexity/sonar-pro', k.id, true, true
FROM (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM "api_keys"
  WHERE service = 'openrouter'
  ORDER BY user_id, (label = 'default') DESC, created_at ASC
) k
WHERE NOT EXISTS (
  SELECT 1 FROM "ai_workers" w WHERE w.owner_id = k.user_id AND w.kind = 'search_advanced'
)
ON CONFLICT ("owner_id","slug") DO NOTHING;
