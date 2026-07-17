-- Page draft concurrency control — the `draft_rev` etag on the `pages` sidecar.
--
-- Page drafts had no concurrency control: saveDraft overwrote `draft_doc`
-- unconditionally, and commit/discard cleared it unconditionally. Two autosave
-- streams (a second device, or a user editing while the Pages agent applies
-- block ops) interleaved into silent last-write-wins lost updates. Team-shares
-- made pages multi-person, so this became a real data-loss path.
--
-- `draft_rev` is the optimistic-concurrency etag, exactly mirroring
-- `tables.draft_rev` (migration 0120): bumped on every draft write, commit, and
-- discard. The autosave/commit surfaces round-trip it as a base revision — a
-- stale writer's conditional UPDATE matches zero rows and is reported as a
-- conflict (409) instead of clobbering newer content. Writers serialize on the
-- pages row via SELECT … FOR UPDATE (withPageLock).
--
-- Purely additive, defaulted NOT NULL so existing rows start at 0 and old code
-- paths are untouched. Safe to re-run.

alter table "public"."pages"
  add column if not exists "draft_rev" integer not null default 0;
