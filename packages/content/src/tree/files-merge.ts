/**
 * A Files folder delete that lifts what it holds one level up and MERGES
 * (folder plan section 5, Jason's option B, folder audit C2). Files are
 * directories on disk, and a directory cannot be renamed onto an existing
 * one, so a merge moves children one by one through the Files package's
 * disk-safe operations (disk first, then the database), as move-copy.ts does.
 *
 * The same mapping as the rows-only delete (node-ops.ts
 * deleteNodeFolderMerging): `P.rest` lands at `Q.rest`.
 *  - A subfolder whose landing path is already a folder merges into it,
 *    recursively; that folder keeps its name, look and share.
 *  - Every other subfolder moves up whole.
 *  - A file whose name is taken where it lands gets the repo's de-dup name
 *    first (`report.pdf` becomes `report-2.pdf`, dedupeFilename; the same
 *    `-2` style reconcileAutoFiled uses; sanitizeFilename lower-cases and
 *    dashes, so " (2)" could not survive).
 *  - Members' drafts and folders follow by path (carrySpaceRows).
 *
 * Everything is checked read only FIRST (untracked files on disk in every
 * directory that goes, a name already on disk where a folder moves up), so a
 * refusal leaves nothing half done. A race after the checks can still stop
 * it part way: what moved stays moved, and the error says why.
 */
import { sql } from 'drizzle-orm';
import { carrySpaceRows, db, takeShareWriteLock } from '@mantle/db';
import {
  dashToLtree,
  deleteFolder as deleteFilesFolder,
  diskNamesIn,
  moveFileById,
  moveFolderById,
  renameFileById,
  renameFolderById,
  strayFilesIn,
} from '@mantle/files';
import { treeParentPath } from '@mantle/content-core/tree';
import { dedupeFilename } from '../dedupe-filename';

/** A refusal written for people; write.ts turns it into a TreeError. */
export class FilesMergeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesMergeRefusal';
  }
}

type Folder = { id: string; path: string; slug: string; title: string };
type File = { id: string; filename: string };

/** One folder's part of the plan: where its contents land. */
type Step = {
  source: Folder;
  target: string;
  /** Subfolders that merge into a folder already at their landing path. */
  merges: Step[];
  /** Subfolders that move up whole. */
  moves: Folder[];
  /** Files, with the name they land under when theirs is taken. */
  files: Array<File & { rename?: string }>;
};

const label = (path: string) => path.split('.').at(-1)!;

async function subfolders(ownerId: string, path: string): Promise<Folder[]> {
  return (await db.execute(sql`
    select id::text as id, path::text as path, slug, title from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and path ~ ${`${path}.*{1}`}::lquery
     order by path`)) as unknown as Folder[];
}

async function filesIn(ownerId: string, path: string): Promise<File[]> {
  return (await db.execute(sql`
    select id::text as id, data->>'filename' as filename from nodes
     where owner_id = ${ownerId} and type = 'file' and path = ${path}::ltree
     order by lower(data->>'filename'), id`)) as unknown as File[];
}

async function folderAt(ownerId: string, path: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from nodes
     where owner_id = ${ownerId} and type = 'branch' and path = ${path}::ltree
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * Plan (read only) how `source`'s contents land at `target`, refusing over
 * anything that would stop the delete part way. `deleted` is the folder
 * being deleted: a subfolder named like it lands at its path, which is free
 * once it is renamed out of the way (`renameFirst`).
 */
async function plan(
  ownerId: string,
  source: Folder,
  target: string,
  deleted: Folder,
  flags: { renameFirst: boolean },
): Promise<Step> {
  const [children, files, onDisk, sourceNames] = await Promise.all([
    subfolders(ownerId, source.path),
    filesIn(ownerId, source.path),
    diskNamesIn(target),
    diskNamesIn(source.path),
  ]);
  const stray = await strayFilesIn(
    source.path,
    new Set(files.map((f) => f.filename.toLowerCase())),
    5,
    new Set(children.map((c) => c.slug.toLowerCase())),
  );
  if (stray.length) {
    throw new FilesMergeRefusal(
      `'${source.title}' holds file(s) on disk the brain does not track (${stray.join(', ')}); move or delete them first`,
    );
  }
  const step: Step = { source, target, merges: [], moves: [], files: [] };
  for (const c of children) {
    const landing = `${target}.${label(c.path)}`;
    if (landing === deleted.path) {
      // Named like the folder being deleted: that path is free once the
      // folder is renamed out of the way.
      flags.renameFirst = true;
      step.moves.push(c);
    } else if (await folderAt(ownerId, landing)) {
      step.merges.push(await plan(ownerId, c, landing, deleted, flags));
    } else if (onDisk.has(c.slug.toLowerCase())) {
      throw new FilesMergeRefusal(
        `'${c.slug}' is already on disk where '${c.title}' would move up, and the brain does not track it; move or rename it first`,
      );
    } else {
      step.moves.push(c);
    }
  }
  // Names taken where the files land (on disk and in the brain). A renamed
  // file is renamed where it is first, so its new name must be free there
  // too.
  const taken = new Set(onDisk);
  for (const f of await filesIn(ownerId, target)) taken.add(f.filename.toLowerCase());
  for (const f of files) {
    if (!taken.has(f.filename.toLowerCase())) {
      taken.add(f.filename.toLowerCase());
      step.files.push(f);
      continue;
    }
    const name = dedupeFilename(f.filename, new Set([...taken, ...sourceNames]));
    taken.add(name.toLowerCase());
    sourceNames.add(name.toLowerCase());
    step.files.push({ ...f, rename: name });
  }
  return step;
}

/** Carry out a checked plan, deepest merges first; `source` goes last. */
async function run(ownerId: string, step: Step, isRoot: boolean): Promise<void> {
  for (const m of step.merges) await run(ownerId, m, false);
  for (const c of step.moves) {
    await moveFolderById({ ownerId, folderId: c.id, destParentPath: step.target });
  }
  for (const f of step.files) {
    if (f.rename) {
      const dot = f.rename.lastIndexOf('.');
      const stem = dot > 0 ? f.rename.slice(0, dot) : f.rename;
      await renameFileById({ ownerId, fileId: f.id, newStem: stem });
    }
    await moveFileById({ ownerId, fileId: f.id, destPath: step.target });
  }
  if (!isRoot) {
    // A merged folder's members' rows land in the folder it merged into
    // (the final delete below would lift them to its old parent instead).
    await db.transaction(async (tx) => {
      await takeShareWriteLock(tx, ownerId);
      await carrySpaceRows(tx, ownerId, step.source.path, step.target);
    });
  }
  const res = await deleteFilesFolder({ ownerId, folderId: step.source.id });
  if (!res.ok) throw new FilesMergeRefusal(`'${step.source.title}' could not go: ${res.reason}`);
}

/** A free slug to park the deleted folder under while a subfolder named
 *  like it moves up into its place. */
async function parkingSlug(ownerId: string, folder: Folder): Promise<string> {
  const parent = treeParentPath(folder.path);
  const taken = await diskNamesIn(parent);
  for (let i = 1; ; i++) {
    const slug = `${folder.slug}-deleting${i === 1 ? '' : `-${i}`}`;
    if (!taken.has(slug) && !(await folderAt(ownerId, `${parent}.${dashToLtree(slug)}`))) {
      return slug;
    }
  }
}

/** Delete a Files folder, lifting and merging what it holds (see above). */
export async function deleteFilesFolderMerging(ownerId: string, folderId: string): Promise<void> {
  const load = async (): Promise<Folder> => {
    const [row] = (await db.execute(sql`
      select id::text as id, path::text as path, slug, title from nodes
       where id = ${folderId} and owner_id = ${ownerId} and type = 'branch'`)) as unknown as Folder[];
    if (!row) throw new FilesMergeRefusal('folder not found');
    return row;
  };
  let folder = await load();
  const flags = { renameFirst: false };
  let step = await plan(ownerId, folder, treeParentPath(folder.path), folder, flags);
  if (flags.renameFirst) {
    await renameFolderById({ ownerId, folderId, newSlug: await parkingSlug(ownerId, folder) });
    folder = await load();
    step = await plan(ownerId, folder, treeParentPath(folder.path), folder, { renameFirst: false });
  }
  await run(ownerId, step, true);
}
