import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { emailAccounts } from './emails';

/** Predicate language for "when does this rule fire?" */
export interface IngestRuleWhen {
  from?: string; // substring or "@domain"
  to?: string;
  subjectRegex?: string;
  label?: string; // gmail label / m365 category / IMAP flag
  hasAttachment?: boolean;
}

/** Side-effects for a matching message. */
export interface IngestRuleThen {
  addTags?: string[];
  moveUnderPath?: string; // ltree-style "printers.suppliers"
  markRead?: boolean;
  routeNodeId?: string; // explicit parent override
}

export const ingestRules = pgTable(
  'ingest_rules',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    /** Null = applies to all accounts the user owns. */
    accountId: uuid('account_id').references(() => emailAccounts.id, { onDelete: 'cascade' }),
    when: jsonb('when').$type<IngestRuleWhen>().notNull(),
    then: jsonb('then').$type<IngestRuleThen>().notNull(),
    priority: integer('priority').default(100).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('ingest_rules_user_idx').on(t.userId),
    index('ingest_rules_priority_idx').on(t.priority),
  ],
);

export type IngestRule = typeof ingestRules.$inferSelect;
export type NewIngestRule = typeof ingestRules.$inferInsert;
