import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { nodes } from './nodes';

/**
 * The embed edges (migration 0208): `from_id` (a page, drawing or note)
 * embeds `to_id`. Kept by triggers from pages.doc, draws.file_refs and a
 * note's markdown, never written by code; nodes.embedded_level is derived
 * from them. Admin pool only (docs/folder-tree.md, "Sharing a folder").
 */
export const nodeEmbeds = pgTable(
  'node_embeds',
  {
    fromId: uuid('from_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
    toId: uuid('to_id')
      .notNull()
      .references(() => nodes.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId] }), index('node_embeds_to_idx').on(t.toId)],
);

/**
 * Old summaries made before always fold (migration 0247, workspaces W2): a
 * page, note or drawing with embeds whose summary may hold an embed's words.
 * Moved here out of nodes.data so no reader of the row and no keyword search
 * sees it; admin pool only (no grant to any limited role). The extractor
 * deletes the row when it writes a summary from folded text.
 */
export const nodeMixedSummaries = pgTable('node_mixed_summaries', {
  nodeId: uuid('node_id')
    .primaryKey()
    .references(() => nodes.id, { onDelete: 'cascade' }),
  summary: text('summary'),
  summaryModel: text('summary_model'),
  summaryAt: text('summary_at'),
  entities: jsonb('entities'),
  movedAt: timestamp('moved_at', { withTimezone: true }).defaultNow().notNull(),
});
