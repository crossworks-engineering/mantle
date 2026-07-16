import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Pages: rich documents authored in the TipTap editor. The ProseMirror JSON
 * is the source of truth (`doc`); `doc_text` is a derived plaintext rendering
 * the extractor + FTS read. Page-level metadata (icon, summary, visibility)
 * lives on the parent `nodes` row so tree/index scans stay lean — same split
 * as `emails` / `secrets`. One row per page (1:1 with its node).
 */
export const pages = pgTable('pages', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  doc: jsonb('doc')
    .$type<Record<string, unknown>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  docText: text('doc_text').default('').notNull(),
  // Autosaved working copy (null when there are no uncommitted edits). Never
  // rendered or indexed; promoted into `doc` on commit.
  draftDoc: jsonb('draft_doc').$type<Record<string, unknown>>(),
  draftUpdatedAt: timestamp('draft_updated_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
