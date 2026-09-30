/**
 * Pages · where a page sits. Create (in a folder of the pages tree) and
 * delete. Since folder phase 7 (docs/folder-tree.md, "Pages") a page is
 * never the parent of another page: its place is its folder's path, exactly
 * like a note's, and moving it is the tree's job (`moveTreeItems`, the
 * `POST /api/tree/pages/move` route, `page_move`), which asks first when
 * the move changes who can see it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, pages } from '@mantle/db';
import { docToText } from '../doc-to-text';
import { EMPTY_DOC, PAGES_ROOT_LABEL, dedupeTags, detailOf, type PageDetail } from './shared';

/** Lazy-create the `pages` ltree root. Idempotent — every create calls it. */
async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Pages',
      slug: PAGES_ROOT_LABEL,
      path: PAGES_ROOT_LABEL,
      data: { description: 'Rich documents (TipTap). Indexed and embedded automatically.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export type CreatePageInput = {
  title: string;
  doc?: Record<string, unknown>;
  tags?: string[];
  icon?: string;
  /** The folder of the pages tree the page goes in (a `branch` row under
   *  `pages`, from `GET /api/tree/pages` or `tree_folders`); null or absent
   *  is the top level. The folder must be the owner's, or (for a member's
   *  draft) the brain's: a member files drafts at brain folder paths. */
  folderId?: string | null;
  /** The ltree path of the folder, for callers that hold it (the split and
   *  extract operations put the new page next to the one it came from).
   *  Takes precedence over `folderId`; not checked against the folder rows. */
  folderPath?: string;
  /** DEPRECATED (folder phase 7): pages no longer nest. An id here puts the
   *  new page in the SAME FOLDER as that page, so a caller from before the
   *  tree still lands near where it meant to. Ignored when `folderId` or
   *  `folderPath` is given. */
  parentId?: string | null;
  /** Extra `data` keys stamped on the node at creation — the provenance hook
   *  (mirrors `upsertFile`'s `data` param). Derived pages use it for the
   *  `sourceFileId` convention (packages/content/src/derived.ts) so reaping
   *  and the `dangling_source_file` audit see them. Canonical fields
   *  (visibility, icon) are applied AFTER the merge and always win. */
  data?: Record<string, unknown>;
};

/** Thrown by `createPage` when the deprecated `parentId` doesn't resolve to
 *  one of the owner's pages. The API layer maps this to a 400. */
export class ParentPageNotFoundError extends Error {
  constructor() {
    super('createPage: parent page not found');
    this.name = 'ParentPageNotFoundError';
  }
}

/** Thrown by `createPage` when `folderId` is not a folder of the pages tree
 *  the caller may file in. The API layer maps this to a 400. */
export class PageFolderNotFoundError extends Error {
  constructor() {
    super('createPage: folder not found');
    this.name = 'PageFolderNotFoundError';
  }
}

/**
 * The path a new page of `ownerId` is filed at. A folder must be a `branch`
 * row under `pages` (never the root's own row: that is the top level, null)
 * owned by the caller or by the brain (a member's draft sits at a brain
 * folder's path; docs/folder-tree.md, phase 5).
 */
async function pagePathFor(
  ownerId: string,
  input: Pick<CreatePageInput, 'folderId' | 'folderPath' | 'parentId'>,
): Promise<string> {
  if (input.folderPath) return input.folderPath;
  if (input.folderId) {
    const rows = (await db.execute(sql`
      select path::text as path from nodes
       where id = ${input.folderId} and type = 'branch'
         and path <@ ${PAGES_ROOT_LABEL}::ltree and nlevel(path) > 1
         and owner_id in (${ownerId}, public.mantle_brain_id())
       limit 1`)) as unknown as Array<{ path: string }>;
    if (!rows[0]) throw new PageFolderNotFoundError();
    return rows[0].path;
  }
  if (input.parentId) {
    const [page] = await db
      .select({ path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, input.parentId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
      .limit(1);
    if (!page) throw new ParentPageNotFoundError();
    return String(page.path);
  }
  return PAGES_ROOT_LABEL;
}

export async function createPage(ownerId: string, input: CreatePageInput): Promise<PageDetail> {
  await ensureRoot(ownerId);
  const doc = input.doc ?? EMPTY_DOC;
  const docText = docToText(doc);
  const path = await pagePathFor(ownerId, input);

  const result = await db.transaction(async (tx) => {
    // A folder's share reaches the new row through the insert trigger
    // (migration 0204; it takes the share lock itself, 0207).
    const [node] = await tx
      .insert(nodes)
      .values({
        ownerId,
        type: 'page',
        title: input.title.trim().slice(0, 200) || 'Untitled page',
        path,
        data: {
          ...(input.data ?? {}),
          visibility: 'private',
          ...(input.icon ? { icon: input.icon } : {}),
        },
        tags: dedupeTags(input.tags ?? []),
      })
      .returning();
    if (!node) throw new Error('createPage: insert returned no row');
    await tx.insert(pages).values({ nodeId: node.id, doc, docText });
    return detailOf(node, doc);
  });

  return result;
}

export async function deletePage(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id)); // `pages` row cascades.
  return true;
}
