-- Persisted "not a duplicate" decisions for the entity-merge review surface
-- (/settings/entities). Near-dup candidates are recomputed on every visit;
-- without this, a pair the operator dismissed would reappear forever. Stored
-- as an unordered pair (low_id < high_id) so dismissing (A,B) also suppresses
-- (B,A). See @mantle/content/entity-dedup.
CREATE TABLE IF NOT EXISTS "entity_merge_dismissals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id" uuid NOT NULL,
  "low_id" uuid NOT NULL,
  "high_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_merge_dismissals_pair_uq"
  ON "entity_merge_dismissals" ("owner_id", "low_id", "high_id");
