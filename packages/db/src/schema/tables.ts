import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * Tables: typed database grids (Airtable / Notion-database style). The
 * structured `TableDoc` ({ columns, rows, aggregates, views }) is the source of
 * truth (`data`); `data_text` is a derived markdown rendering the extractor +
 * FTS read. Grid-level metadata (icon, summary, visibility) lives on the parent
 * `nodes` row so tree/index scans stay lean — the same sidecar split as
 * `pages` / `emails` / `secrets`. One row per table (1:1 with its node).
 *
 * Mirrors `pages` deliberately: `data`↔`doc`, `data_text`↔`doc_text`,
 * `draft_data`↔`draft_doc`. Edits autosave to `draft_data`; commit promotes it
 * into `data`, recomputes `data_text`, and fires the extractor — so a long
 * editing session produces exactly one re-index per commit (cost-safe).
 */
export const tables = pgTable('tables', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  dataText: text('data_text').default('').notNull(),
  // Autosaved working copy (null when there are no uncommitted edits). Never
  // rendered or indexed; promoted into `data` on commit.
  draftData: jsonb('draft_data').$type<Record<string, unknown>>(),
  draftUpdatedAt: timestamp('draft_updated_at', { withTimezone: true }),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type TableSidecar = typeof tables.$inferSelect;
export type NewTableSidecar = typeof tables.$inferInsert;
