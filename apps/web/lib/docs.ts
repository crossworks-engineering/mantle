/** Server-side queries for the read-only /docs viewer. Documentation nodes are
 *  synced from disk by the docs-sync worker (see @mantle/files docs.ts); here we
 *  only read them. */
import 'server-only';
import { and, asc, db, eq, nodes, sql } from '@mantle/db';

export type DocRow = {
  id: string;
  title: string;
  relPath: string;
  collection: string;
  origin: string;
  content: string;
  summary: string | null;
  updatedAt: string;
};

function rowFrom(node: { id: string; title: string; data: unknown; updatedAt: Date }): DocRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    title: node.title,
    relPath: typeof d.rel_path === 'string' ? d.rel_path : node.title,
    collection: typeof d.collection === 'string' ? d.collection : 'system',
    origin: typeof d.origin === 'string' ? d.origin : 'system',
    content: typeof d.content === 'string' ? d.content : '',
    summary: typeof d.summary === 'string' ? d.summary : null,
    updatedAt: node.updatedAt.toISOString(),
  };
}

/** All documentation docs for the owner, ordered by collection then path. */
export async function listDocs(ownerId: string): Promise<DocRow[]> {
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data, updatedAt: nodes.updatedAt })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'documentation')))
    .orderBy(asc(sql`${nodes.data}->>'collection'`), asc(sql`${nodes.data}->>'rel_path'`));
  return rows.map(rowFrom);
}

export async function getDoc(ownerId: string, id: string): Promise<DocRow | null> {
  const [node] = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data, updatedAt: nodes.updatedAt })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.id, id), eq(nodes.type, 'documentation')))
    .limit(1);
  return node ? rowFrom(node) : null;
}
