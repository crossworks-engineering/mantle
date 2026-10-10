/**
 * Pages · where a page sits. Create (in a folder of the pages tree) and
 * delete. Since folder phase 7 (docs/folder-tree.md, "Pages") a page is
 * never the parent of another page: its place is its folder's path, exactly
 * like a note's, and moving it is the tree's job (`moveTreeItems`, the
 * `POST /api/tree/pages/move` route, `page_move`), which asks first when
 * the move changes who can see it; a create in a shared folder asks too
 * (../tree/page-guard.ts).
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  currentSpaceScope,
  db,
  nodes,
  pages,
  takeShareReadLock,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
  withSpaceRows,
} from '@mantle/db';
import { docToText } from '../doc-to-text';
import { guardNewPageIn } from '../tree/page-guard';
import { EMPTY_DOC, PAGES_ROOT_LABEL, dedupeTags, detailOf, type PageDetail } from './shared';

function rootRow(ownerId: string) {
  return {
    ownerId,
    type: 'branch' as const,
    title: 'Pages',
    slug: PAGES_ROOT_LABEL,
    path: PAGES_ROOT_LABEL,
    data: { description: 'Rich documents (TipTap). Indexed and embedded automatically.' },
  };
}

const ROOT_CONFLICT = {
  target: [nodes.ownerId, nodes.path],
  where: sql`${nodes.type} = 'branch'`,
};

/** Lazy-create the `pages` ltree root. Idempotent — every create calls it. */
async function ensureRoot(ownerId: string): Promise<void> {
  if (currentSpaceScope()) return ensureSpaceRoot(ownerId);
  // Heads first (plan U1): a root sits in no folder, so there are none to
  // wait on, but the insert runs in the heads transaction all the same.
  await withNodeInsertHeads(ownerId, [{ type: 'branch', path: PAGES_ROOT_LABEL }], (tx) =>
    tx.insert(nodes).values(rootRow(ownerId)).onConflictDoNothing(ROOT_CONFLICT),
  );
}

/** ensureRoot inside a member's space (withSpace): the space's own rows,
 *  on its transaction (withSpaceRows; personal spaces go in W6b). */
async function ensureSpaceRoot(ownerId: string): Promise<void> {
  await withSpaceRows((tx) =>
    tx.insert(nodes).values(rootRow(ownerId)).onConflictDoNothing(ROOT_CONFLICT),
  );
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
  /** Make the page NEXT TO this page of the owner's (the same folder): the
   *  split and extract operations. The new page is read where the source
   *  already is, so its own row is not asked about; what its document newly
   *  opens (a draft-only embed) still is. Takes precedence over `folderId`. */
  siblingOf?: string;
  /** DEPRECATED (folder phase 7): pages no longer nest. An id here puts the
   *  new page in the SAME FOLDER as that page, so a caller from before the
   *  tree still lands near where it meant to. Ignored when `folderId` or
   *  `siblingOf` is given. */
  parentId?: string | null;
  /** A page in a shared folder is read at the folder's share at once, and
   *  what it embeds with it: refused with the list (TreeVisibilityError)
   *  unless confirmed (docs/folder-tree.md, "Confirm first"). `seen` is the
   *  change count the caller was shown; a different change now is refused
   *  again. */
  confirm?: boolean;
  seen?: number;
  /** Extra `data` keys stamped on the node at creation — the provenance hook
   *  (mirrors `upsertFile`'s `data` param). Derived pages use it for the
   *  `sourceFileId` convention (packages/content/src/derived.ts) so reaping
   *  and the `dangling_source_file` audit see them. Canonical fields
   *  (visibility, icon) are applied AFTER the merge and always win. */
  data?: Record<string, unknown>;
};

/** Thrown by `createPage` when the deprecated `parentId` (or `siblingOf`)
 *  doesn't resolve to one of the owner's pages. The API layer maps this to
 *  a 400. */
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

type Via = Pick<typeof db, 'execute'>;

/**
 * The path a new page of `ownerId` is filed at, read inside the write's
 * transaction with the owner's share lock held (0207: a folder rename, move
 * or delete holds it exclusive while it rewrites paths, so the folder read
 * here is the folder the insert lands in). A folder must be a `branch` row
 * under `pages` (never the root's own row: that is the top level, null)
 * owned by the caller or by the brain: a member's draft sits at a brain
 * folder's path (docs/folder-tree.md, phase 5). Wider than the member
 * tree's own check (memberFilingPath, which also asks whether the member
 * sees the folder): no member reaches this with a folder id, the member
 * routes resolve the path first and pass it on as `opts.path`.
 */
async function pagePathFor(
  via: Via,
  ownerId: string,
  input: Pick<CreatePageInput, 'folderId' | 'siblingOf' | 'parentId'>,
): Promise<string> {
  const beside = input.siblingOf ?? input.parentId;
  if (input.siblingOf || (!input.folderId && beside)) {
    const rows = (await via.execute(sql`
      select path::text as path from nodes
       where id = ${beside} and owner_id = ${ownerId} and type = 'page'
       limit 1`)) as unknown as Array<{ path: string }>;
    if (!rows[0]) throw new ParentPageNotFoundError();
    return rows[0].path;
  }
  if (input.folderId) {
    const rows = (await via.execute(sql`
      select path::text as path from nodes
       where id = ${input.folderId} and type = 'branch'
         and path <@ ${PAGES_ROOT_LABEL}::ltree and nlevel(path) > 1
         and owner_id in (${ownerId}, public.mantle_brain_id())
       limit 1`)) as unknown as Array<{ path: string }>;
    if (!rows[0]) throw new PageFolderNotFoundError();
    return rows[0].path;
  }
  return PAGES_ROOT_LABEL;
}

export async function createPage(ownerId: string, input: CreatePageInput): Promise<PageDetail> {
  await ensureRoot(ownerId);
  const doc = input.doc ?? EMPTY_DOC;
  const docText = docToText(doc);
  const title = input.title.trim().slice(0, 200) || 'Untitled page';

  if (currentSpaceScope()) return createSpacePage(ownerId, input, title, doc, docText);

  // Heads first (plan U1): the folder the page lands in, shared. Its path is
  // read here for the heads and again inside, under the share lock; the
  // folder keeps its id if it moves meanwhile, so the heads still hold.
  const at = await pagePathFor(db, ownerId, input);
  const result = await withNodeInsertHeads(ownerId, [{ type: 'page', path: at }], async (tx) => {
    const path = await placeNewPage(tx, ownerId, input, title, doc);
    const [node] = await tx
      .insert(nodes)
      .values(pageRow(ownerId, input, title, path))
      .returning();
    if (!node) throw new Error('createPage: insert returned no row');
    await tx.insert(pages).values({ nodeId: node.id, doc, docText });
    return detailOf(node, doc);
  });

  return result;
}

/** createPage inside a member's space (withSpace): the space's own rows,
 *  on its transaction (withSpaceRows; personal spaces go in W6b). */
async function createSpacePage(
  ownerId: string,
  input: CreatePageInput,
  title: string,
  doc: Record<string, unknown>,
  docText: string,
): Promise<PageDetail> {
  return withSpaceRows((space) =>
    space.transaction(async (tx) => {
      const path = await placeNewPage(tx, ownerId, input, title, doc);
      const [node] = await tx
        .insert(nodes)
        .values(pageRow(ownerId, input, title, path))
        .returning();
      if (!node) throw new Error('createPage: insert returned no row');
      await tx.insert(pages).values({ nodeId: node.id, doc, docText });
      return detailOf(node, doc);
    }),
  );
}

/** Inside the create's transaction: the share lock, the path, the guard. */
async function placeNewPage(
  tx: Via,
  ownerId: string,
  input: CreatePageInput,
  title: string,
  doc: Record<string, unknown>,
): Promise<string> {
  // The share lock (shared) first, then the folder, then the row (0207).
  await takeShareReadLock(tx, ownerId);
  const path = await pagePathFor(tx, ownerId, input);
  // A folder's share reaches the new row through the insert trigger
  // (0204) and what the doc embeds through 0208's edges: asked first. A
  // page made next to another (split, extract) is read where its source
  // already is, so its own row is not asked about; what its document
  // opens still is (a draft-only embed of the source is not open yet).
  if (path !== PAGES_ROOT_LABEL) {
    await guardNewPageIn(tx, ownerId, path, title, doc, {
      confirm: input.confirm,
      seen: input.seen,
      ownRow: !input.siblingOf,
    });
  }
  return path;
}

function pageRow(ownerId: string, input: CreatePageInput, title: string, path: string) {
  return {
    ownerId,
    type: 'page' as const,
    title,
    path,
    data: {
      ...(input.data ?? {}),
      visibility: 'private',
      ...(input.icon ? { icon: input.icon } : {}),
    },
    tags: dedupeTags(input.tags ?? []),
  };
}

export async function deletePage(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return false;
  if (currentSpaceScope()) {
    await deleteSpacePage(id);
    return true;
  }
  // Heads first (plan V4): the page and its folder.
  await withDeadlockRetry(() =>
    withNodeDeleteHeads([id], (tx) => tx.delete(nodes).where(eq(nodes.id, id))),
  ); // `pages` row cascades.
  return true;
}

/** deletePage inside a member's space (withSpace): the space's own rows,
 *  on its transaction (withSpaceRows; personal spaces go in W6b). */
async function deleteSpacePage(id: string): Promise<void> {
  await withSpaceRows((tx) => tx.delete(nodes).where(eq(nodes.id, id))); // `pages` row cascades.
}
