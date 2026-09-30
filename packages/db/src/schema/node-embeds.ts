import { index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';
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
