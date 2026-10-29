/**
 * Pages · shared spine — the row/detail shapes every other pages module
 * returns, plus the two tiny pure helpers (`rowOf`, `detailOf`) that build
 * them. The tag normaliser is the content package's one (../tags.ts).
 *
 * Deliberately dependency-light: it imports the DB row TYPE, never a query.
 * That is what keeps the seam acyclic — read/tree/draft/structure/embed all
 * depend on this, and it depends on none of them.
 */
import { type Node, isSnapshotCopy } from '@mantle/db';
import type { PageRow } from '@mantle/client-types';

export const PAGES_ROOT_LABEL = 'pages';

/** An empty ProseMirror document — a single empty paragraph. */
export const EMPTY_DOC: Record<string, unknown> = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

export type PageDetail = PageRow & {
  /** Published document — what's rendered everywhere and what the extractor
   *  indexes. Only changes on commit. */
  doc: Record<string, unknown>;
  /** Autosaved working copy if uncommitted edits exist, else null. Never
   *  rendered to other surfaces; loaded by the editor to resume work. */
  draft: Record<string, unknown> | null;
  /** When the draft was last written (ISO), or null when no draft exists.
   *  Optional: only the `getPage` read path populates it — write paths that
   *  synthesize a PageDetail from the row they just wrote skip it. */
  draftUpdatedAt?: string | null;
  /** Draft etag the editor round-trips on every autosave/commit so a stale
   *  writer can't clobber newer edits (optimistic concurrency). The read path
   *  and `commitPage` populate it; other write paths (create/update) leave it
   *  undefined and the client defaults to 0. */
  draftRev?: number;
  /** The folder of the pages tree the page sits in: a
   *  `branch` id, or null at the top level. Only `getPage` populates it;
   *  write paths that synthesize a PageDetail from the row they just wrote
   *  leave it undefined. */
  folderId?: string | null;
};

export function rowOf(n: Node): PageRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    // Pages do not nest: always null; kept on the wire for older clients,
    // which built a hierarchy from it.
    parentId: null,
    title: n.title,
    // Treat a blank icon as "none" so a cleared icon (stored as '') falls back
    // to the default glyph everywhere instead of rendering as empty.
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    width: d.width === 'wide' ? 'wide' : 'narrow',
    ...(isSnapshotCopy(n) ? { readOnly: true as const } : {}),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

export function detailOf(
  n: Node,
  doc: Record<string, unknown>,
  draft: Record<string, unknown> | null = null,
  extra: { draftRev?: number } = {},
): PageDetail {
  return {
    ...rowOf(n),
    doc,
    draft,
    ...(extra.draftRev !== undefined ? { draftRev: extra.draftRev } : {}),
  };
}
