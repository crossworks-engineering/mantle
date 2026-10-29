/**
 * The four tier levels of every node as they were when the workspace grants
 * became the only truth (migration 0261). Read by no
 * product code (an archive: the level-reads sweep skips this folder); the
 * node columns themselves are frozen from then on. No grant to any role:
 * definer functions and the admin pool only.
 */
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const archiveNodeLevels = pgTable('archive_node_levels', {
  nodeId: uuid('node_id').primaryKey(),
  ownerId: uuid('owner_id'),
  audience: text('audience'),
  shareLevel: text('share_level'),
  inheritedLevel: text('inherited_level'),
  embeddedLevel: text('embedded_level'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});
