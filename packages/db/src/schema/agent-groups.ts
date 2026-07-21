import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Worker groups / panels (runner queues slice 3 WP5, migration 0133). A
 * group is a NAMED SET of worker agents: a `worker_invoke` plan node naming
 * a group macro-expands at plan/append time into `par(one worker_invoke per
 * member)` followed by a PANEL audit in the enclosing seq — so the engine
 * only ever executes shapes it already knows, and the par-audit redo
 * refusal is never hit (a blocking panel verdict escalates `needs_human`).
 *
 * `member_slugs` are SOFT refs to `agents.slug` (the runs idiom — history
 * must survive agent deletion): plan-time routing resolution validates each
 * member is an enabled worker agent and teaches otherwise.
 */
export const agentGroups = pgTable(
  'agent_groups',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    memberSlugs: text('member_slugs')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_groups_owner_slug_uq').on(t.ownerId, t.slug)],
);

export type AgentGroup = typeof agentGroups.$inferSelect;
