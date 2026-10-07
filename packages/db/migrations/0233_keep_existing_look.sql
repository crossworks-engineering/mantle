-- Keep the look an existing brain shows today (feat/default-look, 2026-10-07).
--
-- From this release a brain that never chose its look reads as the
-- fresh-install one: the Jackdaw theme, Lorelei avatars and the Neat
-- background (FRESH_APPEARANCE in @mantle/client-types). That is for FRESH
-- installs only. An existing brain must keep the look it shows today, so this
-- writes the OLD effective value into every existing profile row that has no
-- value of its own:
--
--   colorTheme      'clean-slate'  the old baseline theme
--   avatarStyle     'thumbs'       the old default avatar style
--   neatBackground  ''             off, the value the Settings switch stores
--
-- "No value" means the key is absent or JSON null. For colorTheme and
-- avatarStyle an empty or blank string also counts, because it read as the
-- old default too. For neatBackground '' is already "off" and stays. A value
-- that is present is never touched.
--
-- Every row, not only the anchor's: the brain-level fields are read from the
-- anchor owner's row, but which row is the anchor is decided at run time
-- (resolveSingleOwnerId), and a brain-level key on a personal row is ignored,
-- so filling all rows is both complete and harmless. A fresh install has no
-- profile rows when migrations run, so this is a no-op there, and rows made
-- later get DEFAULT_PREFERENCES (the new look).
--
-- Plain data, no trigger, no job. Idempotent: a second run finds nothing.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
UPDATE "public"."profiles"
SET "preferences" = "preferences" || jsonb_strip_nulls(jsonb_build_object(
  'colorTheme',
    CASE WHEN coalesce(btrim("preferences"->>'colorTheme'), '') = '' THEN 'clean-slate' END,
  'avatarStyle',
    CASE WHEN coalesce(btrim("preferences"->>'avatarStyle'), '') = '' THEN 'thumbs' END,
  'neatBackground',
    CASE WHEN "preferences"->>'neatBackground' IS NULL THEN '' END
))
WHERE coalesce(btrim("preferences"->>'colorTheme'), '') = ''
   OR coalesce(btrim("preferences"->>'avatarStyle'), '') = ''
   OR "preferences"->>'neatBackground' IS NULL;
