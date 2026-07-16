import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * A named bundle of tools an owner grants to an agent as a unit (e.g. "Pages
 * toolkit", "Calendar", "Memory core"). Capability-only: no instructions, no
 * behaviour — that's what `skills` are for. See docs/tools-and-skills.md.
 *
 * Phase 0 (dormant substrate): the table + `agents.tool_group_slugs` exist and
 * are seeded from the manifest, but the runtime does not yet expand groups into
 * an agent's effective tool set — that's Phase 1's `effectiveToolSlugs` flip.
 */
export const toolGroups = pgTable(
  'tool_groups',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    /** Tool slugs this group confers when granted to an agent. */
    toolSlugs: text('tool_slugs')
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('tool_groups_owner_slug_uq').on(t.ownerId, t.slug),
    index('tool_groups_owner_idx').on(t.ownerId),
  ],
);

export type ToolGroup = typeof toolGroups.$inferSelect;
export type NewToolGroup = typeof toolGroups.$inferInsert;
