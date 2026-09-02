/**
 * Pages · tree shape. The three operations that change WHERE a page sits
 * rather than what it says: create (optionally under a parent), move (with the
 * whole subtree's ltree paths recomputed), and delete.
 *
 * All three notify Recall, because membership of a `recall` tree is decided by
 * position: a create can be born into a map, a move can carry a page out of
 * one and into another, and a delete removes a serving row.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, pages } from '@mantle/db';
import type { PageRow } from '@mantle/client-types';
import { docToText } from '../doc-to-text';
import { childPagePath } from '../page-path';
import {
  findPageRoot,
  recallAfterPageDelete,
  recallAfterPageMove,
  recallAfterPageWrite,
} from '../recall';
import {
  EMPTY_DOC,
  PAGES_ROOT_LABEL,
  dedupeTags,
  detailOf,
  rowOf,
  type PageDetail,
} from './shared';

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
  /** Optional parent page id (Phase 4a sub-pages). When set, the new page
   *  nests under it: `nodes.parent_id` points at the parent and the ltree
   *  `path` extends the parent's, so the child stays a descendant of the
   *  `pages` root. The tree itself is built from `parent_id`; the path is the
   *  materialised mirror. The parent must be a page owned by the same user. */
  parentId?: string | null;
  /** Extra `data` keys stamped on the node at creation — the provenance hook
   *  (mirrors `upsertFile`'s `data` param). Derived pages use it for the
   *  `sourceFileId` convention (packages/content/src/derived.ts) so reaping
   *  and the `dangling_source_file` audit see them. Canonical fields
   *  (visibility, icon) are applied AFTER the merge and always win. */
  data?: Record<string, unknown>;
};

/** Thrown by `createPage` when `parentId` doesn't resolve to one of the
 *  owner's pages. The API layer maps this to a 400. */
export class ParentPageNotFoundError extends Error {
  constructor() {
    super('createPage: parent page not found');
    this.name = 'ParentPageNotFoundError';
  }
}

export async function createPage(ownerId: string, input: CreatePageInput): Promise<PageDetail> {
  await ensureRoot(ownerId);
  const doc = input.doc ?? EMPTY_DOC;
  const docText = docToText(doc);

  // Resolve the parent (if any) up front. It must be a page owned by the same
  // user; we extend its ltree path so the child stays under the `pages` root.
  let parentId: string | null = null;
  let basePath = PAGES_ROOT_LABEL;
  if (input.parentId) {
    const [parent] = await db
      .select({ id: nodes.id, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, input.parentId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
      .limit(1);
    if (!parent) throw new ParentPageNotFoundError();
    parentId = parent.id;
    basePath = parent.path;
  }

  // Generate the id up front so the path can embed it (the path is built before
  // the insert; the explicit id overrides the column's gen_random_uuid()).
  const id = randomUUID();
  const path = parentId ? childPagePath(basePath, id) : PAGES_ROOT_LABEL;

  const result = await db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        id,
        ownerId,
        parentId,
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

  // Recall: a create lands a COMMITTED doc and tags in one write — a page
  // born into a `recall` tree (or born as one) must compile like a commit.
  await recallAfterPageWrite(ownerId, result.id);
  return result;
}

/** Thrown by `movePage` when the requested new parent is the page itself or one
 *  of its own descendants — re-parenting there would detach the subtree into a
 *  cycle. The tool layer maps this to a friendly message. */
export class PageCycleError extends Error {
  constructor() {
    super('movePage: cannot move a page under itself or one of its own descendants');
    this.name = 'PageCycleError';
  }
}

/** True when `maybeDescendantId` is a page beneath `ancestorId` in the
 *  parent_id tree (excludes the ancestor itself). Cycle-safe via UNION. */
async function isDescendantPage(
  ownerId: string,
  ancestorId: string,
  maybeDescendantId: string,
): Promise<boolean> {
  const result = await db.execute<{ hit: boolean }>(sql`
    WITH RECURSIVE descendants AS (
      SELECT id FROM ${nodes}
       WHERE parent_id = ${ancestorId} AND owner_id = ${ownerId} AND type = 'page'
      UNION
      SELECT n.id FROM ${nodes} n
        JOIN descendants d ON n.parent_id = d.id
       WHERE n.owner_id = ${ownerId} AND n.type = 'page'
    )
    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ${maybeDescendantId}) AS hit
  `);
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: Array<{ hit: boolean }> }).rows ?? [])
  ) as Array<{ hit: boolean }>;
  return rows[0]?.hit === true;
}

/**
 * Re-parent a page (Phase 4d). Moves `id` to nest UNDER `newParentId` — making
 * it a sub-page — or back to the top level when `newParentId` is null. The
 * page's whole subtree moves with it: every descendant's ltree `path` is
 * recomputed from the page's new path in one recursive pass, mirroring the
 * `parentPath.childLabel` rule `createPage` uses (see page-path.ts).
 *
 * Structural only — body, tags, sharing, draft, and the brain index are all
 * untouched and nothing re-indexes (a move changes a page's place, not its
 * text). Only the moved node's `updated_at` is bumped so the move surfaces in
 * the "recently edited" sort. Guards:
 *  - `id` must be one of the owner's pages (returns null otherwise).
 *  - `newParentId`, when set, must be one of the owner's pages
 *    (`ParentPageNotFoundError`) and must NOT be the page itself or one of its
 *    descendants (`PageCycleError`).
 * A move that's already in place is a no-op (returns the current row).
 */
export async function movePage(
  ownerId: string,
  id: string,
  newParentId: string | null,
): Promise<PageRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return null;

  const target = newParentId ?? null;
  let newPath: string = PAGES_ROOT_LABEL;

  if (target) {
    if (target === id) throw new PageCycleError();
    const [parent] = await db
      .select({ id: nodes.id, path: nodes.path })
      .from(nodes)
      .where(and(eq(nodes.id, target), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
      .limit(1);
    if (!parent) throw new ParentPageNotFoundError();
    // The new parent must not live inside the moved page's own subtree.
    if (await isDescendantPage(ownerId, id, target)) throw new PageCycleError();
    newPath = childPagePath(parent.path, id);
  }

  // Already where it's being asked to go — nothing to write.
  if ((node.parentId ?? null) === target) return rowOf(node);

  // Recall: a move can carry a page out of one map and into another —
  // remember the tree it is LEAVING so both maps recompile afterwards.
  const recallOldRoot = await findPageRoot(ownerId, id).catch(() => null);

  await db.transaction(async (tx) => {
    await tx
      .update(nodes)
      .set({ parentId: target, path: sql`${newPath}::ltree`, updatedAt: new Date() })
      .where(eq(nodes.id, id));
    // Rebuild every descendant's path from the moved node's new path down. The
    // moved node's children still point at it via parent_id (only the moved
    // node's own parent_id changed), so the walk reaches exactly its subtree;
    // each level composes parentNewPath || '.' || idLabel (== childPagePath).
    await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id, ${newPath}::text AS new_path
          FROM ${nodes} WHERE id = ${id}
        UNION ALL
        SELECT n.id, s.new_path || '.' || replace(n.id::text, '-', '_')
          FROM ${nodes} n
          JOIN subtree s ON n.parent_id = s.id
         WHERE n.owner_id = ${ownerId} AND n.type = 'page'
      )
      UPDATE ${nodes} SET path = subtree.new_path::ltree
        FROM subtree
       WHERE ${nodes}.id = subtree.id AND subtree.id <> ${id}
    `);
  });

  await recallAfterPageMove(ownerId, id, recallOldRoot?.id ?? null);

  const [updated] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  return updated ? rowOf(updated) : null;
}

export async function deletePage(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return false;
  // Recall needs the tree root BEFORE the delete severs `parent_id`.
  const recallRoot = await findPageRoot(ownerId, id).catch(() => null);
  await db.delete(nodes).where(eq(nodes.id, id)); // `pages` row cascades.
  await recallAfterPageDelete(ownerId, id, recallRoot?.id ?? null);
  return true;
}
