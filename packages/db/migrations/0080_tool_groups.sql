-- Tools & Skills split, Phase 0 (docs/tools-and-skills.md): the dormant substrate.
--
-- `tool_groups` = named, owner-scoped bundles of tool slugs an agent can be
-- granted as a unit (capability-only; instructions live on skills). `agents`
-- gains `tool_group_slugs` to reference them. Both are SEEDED from the manifest
-- but inert: the runtime does not yet expand groups into an agent's effective
-- tool set — that's the Phase 1 `effectiveToolSlugs` flip. Additive, behavior-
-- preserving: every existing agent gets an empty `{}` grant.

CREATE TABLE "tool_groups" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"    uuid NOT NULL,
  "slug"        text NOT NULL,
  "name"        text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "tool_slugs"  text[] DEFAULT '{}'::text[] NOT NULL,
  "enabled"     boolean DEFAULT true NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tool_groups_owner_slug_uq" ON "tool_groups" USING btree ("owner_id","slug");
--> statement-breakpoint
CREATE INDEX "tool_groups_owner_idx" ON "tool_groups" USING btree ("owner_id");
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tool_group_slugs" text[] DEFAULT '{}'::text[] NOT NULL;
