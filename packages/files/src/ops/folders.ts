/**
 * Folder mutations and listings, including the ensure-path helpers.
 *
 * Split out of ops.ts; bodies moved verbatim.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  dashToLtree,
  ensureDir,
  FILES_ROOT_LABEL,
  isFilesPath,
  removeFolder as removeFolderOnDisk,
  renameFolder as renameFolderOnDisk,
  slugifyFolder,
} from '../index';
import { db, nodes } from '@mantle/db';
import { folderCounts, folderRowFromNode, type FolderRow } from './shared';
import { folderById } from './queries';

/**
 * Create a folder under `parentPath` with the given disk slug + description.
 * Throws if the parent isn't a host-mirrored branch or the slug collides.
 */
export async function createFolder(args: {
  ownerId: string;
  parentPath: string;
  slug: string;
  description?: string;
}): Promise<FolderRow> {
  if (!isFilesPath(args.parentPath)) {
    throw new Error(`createFolder: parent '${args.parentPath}' is outside the files root`);
  }
  const slug = slugifyFolder(args.slug);
  if (!slug) {
    throw new Error(`createFolder: invalid slug '${args.slug}'`);
  }
  const childLabel = dashToLtree(slug);
  const childPath = `${args.parentPath}.${childLabel}`;

  // Make sure parent ltree node exists (when parent is `files`, the
  // lazy root-creation handles it; deeper parents must already exist).
  const [parent] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${args.parentPath}`,
      ),
    )
    .limit(1);
  if (!parent) {
    throw new Error(`createFolder: parent folder '${args.parentPath}' not found`);
  }

  // DB first — if the unique index trips, we don't want a leftover dir
  // confusing the next attempt.
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'branch',
      title: slug,
      slug,
      path: childPath,
      data: {
        description: args.description ?? '',
      },
      tags: [],
    })
    .returning();
  if (!row) throw new Error('createFolder: insert returned no row');

  await ensureDir(childPath);

  return folderRowFromNode(row, 0, 0);
}

/**
 * Ensure `files.<topSlug>.<YYYY-MM-DD>` exists (both levels) and return the
 * per-day folder's ltree path. The upload surfaces (web /assistant, Telegram)
 * use this to file an incoming image under a dated folder before persisting
 * the bytes. Idempotent — tolerates the unique-index race when two uploads
 * land in the same second. Note ltree labels use underscores, so the stored
 * path uses `dashToLtree(slug)` while `createFolder` keeps the dash slug as
 * the disk dir name (mirrors the original per-surface helpers).
 */
export async function ensureDatedUploadFolder(args: {
  ownerId: string;
  topSlug: string;
  topDescription?: string;
}): Promise<string> {
  const { ownerId, topSlug } = args;
  const topLtree = `files.${dashToLtree(topSlug)}`;
  const dateSlug = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  for (const [parent, slug, description] of [
    ['files', topSlug, args.topDescription ?? ''],
    [topLtree, dateSlug, `Uploads from ${dateSlug}.`],
  ] as const) {
    const childPath = `${parent}.${dashToLtree(slug)}`;
    const [exists] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${childPath}`,
        ),
      )
      .limit(1);
    if (!exists) {
      try {
        await createFolder({ ownerId, parentPath: parent, slug, description });
      } catch (err) {
        if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
      }
    }
  }
  return `${topLtree}.${dashToLtree(dateSlug)}`;
}

/**
 * Ensure `files/extracted-images/<source-doc>/` exists and return its ltree
 * path.
 *
 * One folder per source document rather than one shared bucket: a single
 * 40-image manual would otherwise bury every other document's pictures, and
 * the per-document folder makes "everything that came out of this file"
 * answerable by browsing as well as by search.
 *
 * The folder slug is derived from the source document's own slug, so
 * re-ingesting the same file lands in the same place. Idempotent — a
 * concurrent create loses the race harmlessly, same as
 * {@link ensureDatedUploadFolder}.
 */
export async function ensureExtractedImagesFolder(args: {
  ownerId: string;
  sourceSlug: string;
  sourceTitle: string;
}): Promise<string> {
  const docSlug = slugifyFolder(args.sourceSlug) ?? 'document';
  const topLtree = `files.${dashToLtree(EXTRACTED_IMAGES_SLUG)}`;
  for (const [parent, slug, description] of [
    [
      'files',
      EXTRACTED_IMAGES_SLUG,
      'Pictures pulled out of documents — diagrams, screenshots and charts that the text of a file cannot convey.',
    ],
    [topLtree, docSlug, `Images extracted from ${args.sourceTitle}.`],
  ] as const) {
    const childPath = `${parent}.${dashToLtree(slug)}`;
    const [exists] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, args.ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${childPath}`,
        ),
      )
      .limit(1);
    if (!exists) {
      try {
        await createFolder({ ownerId: args.ownerId, parentPath: parent, slug, description });
      } catch (err) {
        if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
      }
    }
  }
  return `${topLtree}.${dashToLtree(docSlug)}`;
}

/** Top-level folder holding every document's extracted pictures. */
export const EXTRACTED_IMAGES_SLUG = 'extracted-images';

/** How deep below `files` an agent may bring a folder chain into existence.
 *  Generous for real filing, short enough that a malformed path cannot walk a
 *  tree of empty folders into the store. */
const MAX_ENSURED_DEPTH = 6;

/**
 * Bring every missing folder on an ltree path under `files` into existence and
 * return the path. The `mkdir -p` every other writer here already performs for
 * itself — {@link ensureDatedUploadFolder} for uploads,
 * {@link ensureExtractedImagesFolder} for the extractor — lifted to one place so
 * an AGENT writing a file gets it too.
 *
 * Why it is needed: a skill can name a folder ("save the SVG under
 * `files/diagrams`") that nothing on a fresh brain ever creates, and `upsertFile`
 * refuses an absent parent. The agent then either fails or improvises a
 * different folder, and the artifact lands somewhere the instructions did not
 * intend — measured on the Draftsman, whose every first diagram errored and then
 * landed in the files ROOT instead.
 *
 * Deliberately narrow: `files` only (never a new top-level root), depth-capped,
 * and each segment must survive {@link slugifyFolder}, so a malformed path is
 * still an error rather than a tree of junk. Idempotent, and a concurrent create
 * loses the race harmlessly — same contract as the two helpers above.
 */
export async function ensureFolderPath(args: {
  ownerId: string;
  path: string;
  description?: string;
}): Promise<string> {
  const segments = args.path.split('.');
  if (segments[0] !== 'files') {
    throw new Error(`ensureFolderPath: '${args.path}' is not under 'files'`);
  }
  if (segments.length > MAX_ENSURED_DEPTH) {
    throw new Error(
      `ensureFolderPath: '${args.path}' is deeper than ${MAX_ENSURED_DEPTH} levels — create it deliberately with folder_create`,
    );
  }
  let parent = 'files';
  for (const label of segments.slice(1)) {
    const childPath = `${parent}.${label}`;
    const [exists] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, args.ownerId),
          eq(nodes.type, 'branch'),
          sql`${nodes.path}::text = ${childPath}`,
        ),
      )
      .limit(1);
    if (!exists) {
      try {
        await createFolder({
          ownerId: args.ownerId,
          parentPath: parent,
          // ltree labels use `_` where a slug uses `-`; createFolder slugifies
          // again, so hand it the slug form rather than the stored label.
          slug: label.replace(/_/g, '-'),
          description: args.description ?? '',
        });
      } catch (err) {
        if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
      }
    }
    parent = childPath;
  }
  return args.path;
}

export async function updateFolderDescription(args: {
  ownerId: string;
  folderId: string;
  description: string;
}): Promise<FolderRow | null> {
  const [existing] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!existing || existing.type !== 'branch') return null;
  const data = (existing.data ?? {}) as Record<string, unknown>;
  const [row] = await db
    .update(nodes)
    .set({
      data: { ...data, description: args.description },
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, args.folderId))
    .returning();
  if (!row) return null;
  const counts = await folderCounts(args.ownerId, row.path);
  return folderRowFromNode(row, counts.childFolderCount, counts.fileCount);
}

/**
 * Delete a folder. Refuses if it still has children (folders or files)
 * so the operator has to do it bottom-up — guards against accidental
 * mass-delete via a single click.
 */
export async function deleteFolder(args: {
  ownerId: string;
  folderId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [folder] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!folder || folder.type !== 'branch') {
    return { ok: false, reason: 'not-found' };
  }
  if (folder.path === FILES_ROOT_LABEL) {
    return { ok: false, reason: 'cannot delete the files root' };
  }
  const counts = await folderCounts(args.ownerId, folder.path);
  if (counts.childFolderCount > 0 || counts.fileCount > 0) {
    return { ok: false, reason: 'folder is not empty — delete its contents first' };
  }
  await db.delete(nodes).where(eq(nodes.id, args.folderId));
  await removeFolderOnDisk(folder.path);
  return { ok: true };
}

export async function listFolders(args: {
  ownerId: string;
  parentPath: string;
}): Promise<FolderRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        // Direct children only — nlevel = parent_level + 1 and prefix match.
        sql`${nodes.path} ~ ${`${args.parentPath}.*{1}`}::lquery`,
      ),
    );
  // Add counts per row.
  const results: FolderRow[] = [];
  for (const row of rows) {
    const counts = await folderCounts(args.ownerId, row.path);
    results.push(folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
  }
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return results;
}

/** All descendant folders, used to build the tree rail in one query. */
export async function listAllFolders(ownerId: string): Promise<FolderRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path} <@ ${FILES_ROOT_LABEL}::ltree`,
      ),
    );
  const out: FolderRow[] = [];
  for (const row of rows) {
    const counts = await folderCounts(ownerId, row.path);
    out.push(folderRowFromNode(row, counts.childFolderCount, counts.fileCount));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Swap the LAST label of an ltree path for `newLabel`, keeping the parent
 *  prefix. Pure (no DB/disk) so the path math is unit-testable. The root
 *  `files` (no dot) returns just `newLabel`, but callers reject renaming root. */
export function renamedFolderPath(oldPath: string, newLabel: string): string {
  const dot = oldPath.lastIndexOf('.');
  return dot === -1 ? newLabel : `${oldPath.slice(0, dot)}.${newLabel}`;
}

/**
 * Rename a folder in place (same parent, new label). Rewrites the ltree path
 * of the folder AND every descendant — folders and files alike, since a file's
 * `path` IS its parent folder's path — in one cascade, and renames the matching
 * directory on disk (the whole subtree moves with it). Throws on the root, an
 * invalid name, or a name collision. Returns null only when the id isn't a
 * folder the owner has.
 */
export async function renameFolderById(args: {
  ownerId: string;
  folderId: string;
  /** New display name; slugified the same way createFolder does. */
  newSlug: string;
}): Promise<FolderRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, args.folderId), eq(nodes.ownerId, args.ownerId)))
    .limit(1);
  if (!node || node.type !== 'branch') return null;
  if (node.path === FILES_ROOT_LABEL) {
    throw new Error('renameFolderById: cannot rename the files root');
  }
  const slug = slugifyFolder(args.newSlug);
  if (!slug) throw new Error(`renameFolderById: invalid name '${args.newSlug}'`);
  const newLabel = dashToLtree(slug);
  const oldPath = node.path;
  const newPath = renamedFolderPath(oldPath, newLabel);
  if (newPath === oldPath) {
    const counts = await folderCounts(args.ownerId, oldPath);
    return folderRowFromNode(node, counts.childFolderCount, counts.fileCount);
  }

  // Collision: another branch already at the target path. The
  // nodes_branch_owner_path_uq index also enforces this; we check first for a
  // clean error rather than a constraint-violation string.
  const [clash] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'branch'),
        sql`${nodes.path}::text = ${newPath}`,
      ),
    )
    .limit(1);
  if (clash) {
    throw new Error(`renameFolderById: a folder named '${slug}' already exists here`);
  }

  // Disk first (atomic fs.rename of the directory), then the DB cascade in a
  // transaction. If the DB write fails, put the directory back so disk and DB
  // never diverge.
  await renameFolderOnDisk(oldPath, newPath);
  try {
    await db.transaction(async (tx) => {
      // Rewrite the prefix for the folder itself + every descendant (folders and
      // files — a file's path IS its parent folder's path). The folder itself is
      // handled by the CASE: `subpath(path, nlevel(oldPath))` would throw
      // "invalid positions" when offset == nlevel (the self row), so map it to
      // newPath directly; descendants keep their tail under the new prefix.
      await tx.execute(sql`
        UPDATE ${nodes}
        SET path = CASE
              WHEN path = ${oldPath}::ltree THEN text2ltree(${newPath})
              ELSE (text2ltree(${newPath}) || subpath(path, nlevel(${oldPath}::ltree)))::ltree
            END,
            updated_at = now()
        WHERE owner_id = ${args.ownerId} AND path <@ ${oldPath}::ltree
      `);
      // The folder's own label fields (path already rewritten above).
      const data = (node.data ?? {}) as Record<string, unknown>;
      await tx
        .update(nodes)
        .set({ title: slug, slug, data: { ...data, slug }, updatedAt: new Date() })
        .where(eq(nodes.id, node.id));
    });
  } catch (err) {
    await renameFolderOnDisk(newPath, oldPath).catch(() => {});
    throw err;
  }
  return folderById({ ownerId: args.ownerId, folderId: args.folderId });
}
