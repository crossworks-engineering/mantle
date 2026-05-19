import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Behaviour packs an agent can be attached to. v1 model: always-loaded —
 * when a skill is in an agent's skill_slugs, its instructions get
 * injected into the system prompt and its tool_slugs are added to the
 * agent's available tools.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    /** Markdown body; rendered verbatim into the system block. */
    instructions: text('instructions').default('').notNull(),
    /** Tools this skill expects the agent to have access to. */
    toolSlugs: text('tool_slugs').array().default(sql`'{}'::text[]`).notNull(),
    /** Initial state shape a heartbeat inherits when bound to this
     *  skill — e.g. {answered: [], expecting_reply: false} for the
     *  profile_interview skill. The heartbeat creation form pre-fills
     *  from this; once a heartbeat exists, its own `state` is the
     *  source of truth (this column is a template, not a live ref).
     *  See docs/heartbeats.md §10 for the well-known state keys
     *  engine code reads. */
    defaultState: jsonb('default_state').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('skills_owner_slug_uq').on(t.ownerId, t.slug),
    index('skills_owner_idx').on(t.ownerId),
  ],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;
