-- The Excalidraw version that produced the stored `scene_svg`.
--
-- The snapshot is a CACHE of a render, not a source of truth: it can be
-- regenerated from `scene` by the browser sidecar (see docs/draw-render-fallback-plan.md).
-- Stamping the engine makes an upgrade recoverable — a mismatch marks the
-- snapshot stale, so it re-renders lazily on the next owner view, or in bulk
-- via the `draws:re-render` maintenance task.
--
-- Nullable with no backfill on purpose: NULL means "rendered before we tracked
-- this", which is exactly the same thing as stale, and needs no special case.

ALTER TABLE "draws" ADD COLUMN IF NOT EXISTS "svg_engine" text;
