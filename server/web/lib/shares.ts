/**
 * Web-side share helpers. Re-exports the owner-side CRUD from @mantle/content
 * and adds the PUBLIC read path: resolve a token → the data a presenter needs,
 * and the asset-scoping check the public file route enforces. None of this
 * calls requireOwner — the public surface trusts a resolved active token and
 * only ever reaches the one shared node (+ its referenced files).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, tables, type Share } from '@mantle/db';
import {
  getPage,
  getApp,
  referencedFileIds,
  ensureTableDoc,
  emptyTableDoc,
  type Column,
  type Row,
} from '@mantle/content';
import { describeWorkbook, resolveStoragePath } from '@mantle/tabledb';
import { fileById, folderById } from '@/lib/files';

export {
  createShare,
  revokeShare,
  revokeShareTree,
  applyShareMode,
  setShareCascade,
  getActiveShareForNode,
  resolveActiveShareByToken,
  recordShareView,
  isShareable,
  type ShareSummary,
} from '@mantle/content';

export function buildShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/s/${token}`;
}

export type ShareView =
  | {
      kind: 'page';
      title: string;
      icon: string | null;
      width: 'narrow' | 'wide';
      doc: Record<string, unknown>;
    }
  | { kind: 'note'; title: string; content: string }
  | {
      kind: 'task';
      title: string;
      body: string;
      status: string;
      priority: string;
      dueAt: string | null;
    }
  | {
      kind: 'event';
      title: string;
      body: string;
      startsAt: string | null;
      endsAt: string | null;
      location: string | null;
    }
  | { kind: 'file'; fileId: string; filename: string; mimeType: string; size: number }
  | { kind: 'app'; appId: string; title: string }
  | {
      kind: 'table';
      tableId: string;
      title: string;
      icon: string | null;
      /** File-backed workbooks: tab list + the column set rows are keyed by
       *  (formula columns are not stored, so they don't appear on the public
       *  surface). Rows page in through GET /s/[token]/rows. */
      tabs: Array<{
        id: string;
        name: string;
        rowCount: number;
        columns: Array<{ id: string; name: string; type: string }>;
      }> | null;
      /** Legacy JSONB tables (pre-registry, small): the whole doc inline. */
      legacyDoc: { columns: Column[]; rows: Row[] } | null;
    }
  | { kind: 'folder'; folderId: string; title: string; path: string };

async function loadNode(ownerId: string, nodeId: string) {
  const [row] = await db
    .select({ title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** Resolve the shared node into the shape its presenter renders. Returns null
 *  if the underlying node vanished (deleted after the link was minted). */
export async function loadShareView(share: Share): Promise<ShareView | null> {
  const { ownerId, nodeId, nodeType } = share;
  switch (nodeType) {
    case 'page': {
      const page = await getPage(ownerId, nodeId);
      if (!page) return null;
      return { kind: 'page', title: page.title, icon: page.icon, width: page.width, doc: page.doc };
    }
    case 'note': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'note',
        title: n.title,
        content: typeof d.content === 'string' ? d.content : '',
      };
    }
    case 'task': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'task',
        title: n.title,
        body: typeof d.body === 'string' ? d.body : '',
        status: typeof d.status === 'string' ? d.status : 'open',
        priority: typeof d.priority === 'string' ? d.priority : 'normal',
        dueAt: typeof d.due_at === 'string' ? d.due_at : null,
      };
    }
    case 'event': {
      const n = await loadNode(ownerId, nodeId);
      if (!n) return null;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return {
        kind: 'event',
        title: n.title,
        body: typeof d.body === 'string' ? d.body : '',
        startsAt: typeof d.starts_at === 'string' ? d.starts_at : null,
        endsAt: typeof d.ends_at === 'string' ? d.ends_at : null,
        location: typeof d.location === 'string' ? d.location : null,
      };
    }
    case 'file': {
      const f = await fileById({ ownerId, fileId: nodeId });
      if (!f) return null;
      return {
        kind: 'file',
        fileId: nodeId,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.sizeBytes,
      };
    }
    case 'app': {
      // Only a PUBLISHED app is shareable — never expose a draft build publicly.
      const app = await getApp(ownerId, nodeId);
      if (!app || !app.publishedBuild?.ok) return null;
      return { kind: 'app', appId: nodeId, title: app.title };
    }
    case 'table': {
      // PUBLISHED state only — the draft file is the owner's working copy and
      // never crosses the share boundary (same rule as page drafts).
      const [row] = await db
        .select({
          title: nodes.title,
          data: nodes.data,
          storagePath: tables.storagePath,
          doc: tables.data,
        })
        .from(nodes)
        .leftJoin(tables, eq(tables.nodeId, nodes.id))
        .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'table')))
        .limit(1);
      if (!row) return null;
      const d = (row.data ?? {}) as Record<string, unknown>;
      const icon = typeof d.icon === 'string' ? d.icon : null;
      if (row.storagePath) {
        let tabs: NonNullable<Extract<ShareView, { kind: 'table' }>['tabs']>;
        try {
          tabs = describeWorkbook(resolveStoragePath(row.storagePath)).map((t) => ({
            id: t.tabId,
            name: t.name,
            rowCount: t.rowCount,
            columns: t.columns.map((c) => ({ id: c.colId, name: c.name, type: c.type })),
          }));
        } catch {
          // Published file missing/unreadable (e.g. never committed) — treat
          // as vanished rather than leak an error page.
          return null;
        }
        return { kind: 'table', tableId: nodeId, title: row.title, icon, tabs, legacyDoc: null };
      }
      const doc = ensureTableDoc(row.doc ?? emptyTableDoc());
      return {
        kind: 'table',
        tableId: nodeId,
        title: row.title,
        icon,
        tabs: null,
        legacyDoc: { columns: doc.columns, rows: doc.rows },
      };
    }
    case 'branch': {
      const folder = await folderById({ ownerId, folderId: nodeId });
      if (!folder) return null;
      return { kind: 'folder', folderId: nodeId, title: folder.slug, path: folder.path };
    }
    default:
      return null;
  }
}

/** Is `fileId` allowed to be served under this share? A file share serves
 *  itself; a page share serves only the files its doc references; a folder
 *  share serves every file under the folder's subtree (recursive, evaluated
 *  per request — a file moved out is denied on its next fetch). Anything else
 *  is denied — this is the asset route's authorization. */
export async function isAssetAllowed(share: Share, fileId: string): Promise<boolean> {
  if (share.nodeType === 'file') return share.nodeId === fileId;
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page) return false;
    return referencedFileIds(page.doc).includes(fileId);
  }
  if (share.nodeType === 'branch') {
    // Hot path (one call per file/download under a folder share): fetch only
    // the folder's path — folderById would also run two folderCounts queries
    // whose results this check never reads.
    const [folder] = await db
      .select({ path: nodes.path })
      .from(nodes)
      .where(
        and(eq(nodes.id, share.nodeId), eq(nodes.ownerId, share.ownerId), eq(nodes.type, 'branch')),
      )
      .limit(1);
    if (!folder?.path) return false;
    const [hit] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, fileId),
          eq(nodes.ownerId, share.ownerId),
          eq(nodes.type, 'file'),
          sql`${nodes.path} <@ ${folder.path}::ltree`,
        ),
      )
      .limit(1);
    return !!hit;
  }
  return false;
}
