/**
 * Web-side share helpers. Re-exports the owner-side CRUD from @mantle/content
 * and adds the PUBLIC read path: resolve a token → the data a presenter needs,
 * and the asset-scoping check the public file route enforces. None of this
 * calls requireOwner — the public surface trusts a resolved active token and
 * only ever reaches the one shared node (+ its referenced files).
 */
import { and, eq } from 'drizzle-orm';
import { db, nodes, type Share } from '@mantle/db';
import { getPage, referencedFileIds } from '@mantle/content';
import { fileById } from '@/lib/files';

export {
  createShare,
  revokeShare,
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
  | { kind: 'page'; title: string; icon: string | null; width: 'narrow' | 'wide'; doc: Record<string, unknown> }
  | { kind: 'note'; title: string; content: string }
  | { kind: 'task'; title: string; body: string; status: string; priority: string; dueAt: string | null }
  | {
      kind: 'event';
      title: string;
      body: string;
      startsAt: string | null;
      endsAt: string | null;
      location: string | null;
    }
  | { kind: 'file'; fileId: string; filename: string; mimeType: string; size: number };

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
      return { kind: 'note', title: n.title, content: typeof d.content === 'string' ? d.content : '' };
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
      return { kind: 'file', fileId: nodeId, filename: f.filename, mimeType: f.mimeType, size: f.sizeBytes };
    }
    default:
      return null;
  }
}

/** Is `fileId` allowed to be served under this share? A file share serves
 *  itself; a page share serves only the files its doc references. Anything else
 *  is denied — this is the asset route's authorization. */
export async function isAssetAllowed(share: Share, fileId: string): Promise<boolean> {
  if (share.nodeType === 'file') return share.nodeId === fileId;
  if (share.nodeType === 'page') {
    const page = await getPage(share.ownerId, share.nodeId);
    if (!page) return false;
    return referencedFileIds(page.doc).includes(fileId);
  }
  return false;
}
