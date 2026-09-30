-- Recall v2 R1: the schema the native authoring path needs. Plan: "PLAN:
-- Recall v2, its own content type" (dev brain, roadmap task 5d6ce06a).
--
-- v1 COMPILES page trees into recall_maps / recall_nodes and treats those rows
-- as a build artifact. v2 promotes them to the SOURCE: an edit writes them
-- directly, checked in the same transaction, so there is no compile step, no
-- "last good rev" and no silently stale map. Nothing here changes behaviour;
-- the v1 compiler keeps owning these rows until the native write path (R2)
-- lands, and every column added is optional or defaulted so the running
-- release neither reads nor writes any of them.
--
-- 1. recall_maps gains its node linkage and the native bookkeeping.
--    `node_id` is the map's `recall` node (0201). ON DELETE CASCADE: deleting
--    the item deletes the map row, and 4 below carries the cards with it.
--    A map created natively has id = node_id; v1 rows keep id = root page id
--    and node_id NULL until they are re-authored. No page id is ever reused
--    by a native map, which is why the v1 page hooks (which key on page ids)
--    can never reach a native row.
--
-- 2. `published` gates a map an AGENT created: invisible to recall_index,
--    recall_open and recall_match until the owner publishes it in the UI.
--    Defaults true so every existing row keeps serving.
--
-- 3. `version` is the optimistic-concurrency token the editor and the write
--    tools carry; `former_slugs` is what keeps a remembered slug resolving
--    after a rename (the mantle-recall skill hard-codes one).
--
-- 4. recall_nodes.map_id gets its FK at last, ON DELETE CASCADE, so a map's
--    cards go with it. Orphan rows are deleted first: there are none on the
--    dev brain (checked 2026-09-30) and no other brain has real maps, but a
--    FK that fails at migrate would take a release down.
--
-- 5. recall_nodes gains `rank` (card order in the editor), `prompt_pending`
--    (an agent ASKED for prompt status; the owner confirms, and the card is
--    neither embedded nor matchable until then) and its own `former_slugs`.
--
-- 6. recall_revisions is new: one row per native write, the last 50 per map.
--    It backs undo in the editor and the audit of agent edits, which matters
--    because v2 lets an agent's card edit serve immediately. It is not the
--    flight recorder (v1 S3) and not a walk log.
--
-- The recall tables stay `none` in the access matrix: admin pool only, no
-- viewer role, so no RLS and no policies here (same posture as 0153).
--
-- Rollback: the previous release runs on this schema untouched. It writes
-- recall_maps / recall_nodes through the v1 compiler, which names columns
-- explicitly and so never sees the new ones; the new defaults keep its rows
-- valid. To undo: drop recall_revisions, drop the added columns, drop the
-- two FKs. The enum value from 0200 stays (it cannot be removed) and is
-- harmless unused.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

-- ── 1-3. recall_maps: node linkage and native bookkeeping ──────────────────
ALTER TABLE "public"."recall_maps"
  ADD COLUMN IF NOT EXISTS "node_id" uuid;
--> statement-breakpoint
ALTER TABLE "public"."recall_maps"
  ADD COLUMN IF NOT EXISTS "published" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "public"."recall_maps"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "public"."recall_maps"
  ADD COLUMN IF NOT EXISTS "former_slugs" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "public"."recall_maps"
  DROP CONSTRAINT IF EXISTS "recall_maps_node_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."recall_maps"
  ADD CONSTRAINT "recall_maps_node_id_fk"
  FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recall_maps_node_uq"
  ON "public"."recall_maps" ("node_id");
--> statement-breakpoint

-- ── 4. recall_nodes.map_id: the FK the compiled rows never had ─────────────
DELETE FROM "public"."recall_nodes" rn
 WHERE NOT EXISTS (SELECT 1 FROM "public"."recall_maps" rm WHERE rm."id" = rn."map_id");
--> statement-breakpoint
ALTER TABLE "public"."recall_nodes"
  DROP CONSTRAINT IF EXISTS "recall_nodes_map_id_fk";
--> statement-breakpoint
ALTER TABLE "public"."recall_nodes"
  ADD CONSTRAINT "recall_nodes_map_id_fk"
  FOREIGN KEY ("map_id") REFERENCES "public"."recall_maps"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- ── 5. recall_nodes: card order and the pending-prompt gate ────────────────
ALTER TABLE "public"."recall_nodes"
  ADD COLUMN IF NOT EXISTS "rank" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "public"."recall_nodes"
  ADD COLUMN IF NOT EXISTS "prompt_pending" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."recall_nodes"
  ADD COLUMN IF NOT EXISTS "former_slugs" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- ── 6. recall_revisions: undo in the editor, audit of agent edits ──────────
CREATE TABLE IF NOT EXISTS "public"."recall_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "map_id" uuid NOT NULL REFERENCES "public"."recall_maps"("id") ON DELETE CASCADE,
  -- NULL when the write was the map's own (title, enter-when, publish, folder).
  "card_id" uuid,
  "actor_kind" text NOT NULL,
  "actor_id" uuid,
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "recall_revisions_actor_kind_ck" CHECK ("actor_kind" IN ('owner', 'agent'))
);
--> statement-breakpoint
-- The editor's revisions panel and the keep-last-50 prune, newest first.
CREATE INDEX IF NOT EXISTS "recall_revisions_map_time_idx"
  ON "public"."recall_revisions" ("map_id", "created_at" DESC);
