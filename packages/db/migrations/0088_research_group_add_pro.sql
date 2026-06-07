-- The manifest 'research' tool group now grants web_search_pro alongside
-- web_search. Existing brains' group rows predate it (applyManifest only runs at
-- onboarding), so append it here. Idempotent: only rows missing it are touched.
UPDATE "tool_groups"
SET tool_slugs = array_append(tool_slugs, 'web_search_pro'), updated_at = now()
WHERE slug = 'research' AND NOT ('web_search_pro' = ANY(tool_slugs));
