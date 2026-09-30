/**
 * Auto-filed: the one admin folder that holds everything Mantle files by
 * itself (docs/folder-tree.md). Uploads sent in chat or over Telegram,
 * exports, generated images and video go into a folder per month; pictures
 * extracted from a document go into a folder per document; sandbox exports
 * and stored API docs into one folder each.
 *
 *   files/auto-filed/telegram-uploads/2026-09/photo.jpg
 *   files/auto-filed/extracted-images/<document>/figure-1.png
 *
 * Every folder here is a system folder: its name is locked and it cannot be
 * moved, because the writers find it by its path. Its contents can be moved,
 * renamed and deleted like any other.
 *
 * Brains made before Auto-filed kept these folders at the top of Files, dated
 * by day. `reconcileAutoFiled` moves them in once and merges the day folders
 * into months; the file watcher runs it before it starts watching.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, isUniqueViolation, nodes } from '@mantle/db';
import { dashToLtree, slugifyFolder } from './slug';
import { FILES_ROOT_LABEL } from './paths';
import { ensureFilesRootBranch } from './ops/shared';
import { folderByPath } from './ops/queries';
import { createFolder, deleteFolder } from './ops/folders';
import { renameFileById } from './ops/files';
import { moveFileById, moveFolderById } from './move-copy';

export const AUTO_FILED_SLUG = 'auto-filed';
export const AUTO_FILED_PATH = `${FILES_ROOT_LABEL}.${dashToLtree(AUTO_FILED_SLUG)}`;

type SourceSpec = {
  name: string;
  description: string;
  /** How the source's folder is split: a folder per month, per document, or
   *  none. */
  by: 'month' | 'document' | 'none';
};

export const AUTO_FILED_SOURCES = {
  'assistant-uploads': {
    name: 'Assistant uploads',
    description: 'Files sent to the assistant in chat, a folder per month.',
    by: 'month',
  },
  'telegram-uploads': {
    name: 'Telegram uploads',
    description: 'Files sent over Telegram, a folder per month.',
    by: 'month',
  },
  exports: {
    name: 'Exports',
    description: 'Documents and sheets written by export tools, a folder per month.',
    by: 'month',
  },
  'generated-images': {
    name: 'Generated images',
    description: 'Images made by the generate_image tool, a folder per month.',
    by: 'month',
  },
  'video-ingest': {
    name: 'Video',
    description: 'Audio and video pulled in by the video_ingest tool, a folder per month.',
    by: 'month',
  },
  'extracted-images': {
    name: 'Extracted images',
    description:
      'Pictures pulled out of documents (diagrams, screenshots and charts the text cannot convey), a folder per document.',
    by: 'document',
  },
  'sandbox-exports': {
    name: 'Sandbox exports',
    description:
      'Work exported from CLI sandboxes (sandbox_export): tar.gz snapshots of /files paths, one per export.',
    by: 'none',
  },
  'api-docs': {
    name: 'API docs',
    description:
      'Stored API documentation for integration tool groups: one markdown file per group, written by api_docs_set and read back with api_docs_get.',
    by: 'none',
  },
} as const satisfies Record<string, SourceSpec>;

export type AutoFiledSource = keyof typeof AUTO_FILED_SOURCES;

/** The month folder label of a date: `2026-09`. */
export function autoFiledMonth(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

/** The ltree path of a source's own folder: `files.auto_filed.<source>`. */
export function autoFiledSourcePath(source: AutoFiledSource): string {
  return `${AUTO_FILED_PATH}.${dashToLtree(source)}`;
}

async function branchExists(ownerId: string, path: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch'), sql`${nodes.path}::text = ${path}`),
    )
    .limit(1);
  return !!row;
}

/** Make a system folder under `parentPath` unless it is there; its path. A
 *  concurrent create loses the race harmlessly. */
async function ensureSystemFolder(
  ownerId: string,
  parentPath: string,
  slug: string,
  name: string,
  description: string,
): Promise<string> {
  const clean = slugifyFolder(slug);
  if (!clean) throw new Error(`auto-filed: invalid folder slug '${slug}'`);
  const path = `${parentPath}.${dashToLtree(clean)}`;
  if (await branchExists(ownerId, path)) return path;
  try {
    await createFolder({ ownerId, parentPath, slug: clean, name, description, system: true });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  return path;
}

async function ensureAutoFiledRoot(ownerId: string): Promise<void> {
  await ensureFilesRootBranch(ownerId);
  await ensureSystemFolder(
    ownerId,
    FILES_ROOT_LABEL,
    AUTO_FILED_SLUG,
    'Auto-filed',
    'Everything Mantle files by itself: uploads, exports, generated and extracted images. Admins only; clean it up freely.',
  );
}

/**
 * The folder a source files into now, made if missing; its ltree path. A
 * month source files into this month's folder (or `date`'s); the extracted
 * images of a document into that document's folder.
 */
export async function ensureAutoFiledFolder(
  ownerId: string,
  source: AutoFiledSource,
  opts: { date?: Date; document?: { slug: string; title: string } } = {},
): Promise<string> {
  const spec: SourceSpec = AUTO_FILED_SOURCES[source];
  await ensureAutoFiledRoot(ownerId);
  const top = await ensureSystemFolder(
    ownerId,
    AUTO_FILED_PATH,
    source,
    spec.name,
    spec.description,
  );
  if (spec.by === 'month') {
    const month = autoFiledMonth(opts.date);
    return ensureSystemFolder(ownerId, top, month, month, `${spec.name} from ${month}.`);
  }
  if (spec.by === 'document') {
    const doc = opts.document;
    if (!doc) throw new Error(`auto-filed: ${source} files by document; name the document`);
    const docSlug = slugifyFolder(doc.slug) ?? 'document';
    const name = doc.title.trim().slice(0, 60) || docSlug;
    return ensureSystemFolder(ownerId, top, docSlug, name, `Images extracted from ${doc.title}.`);
  }
  return top;
}

/**
 * The folder a document's extracted pictures go into, made if missing:
 * `files/auto-filed/extracted-images/<source-doc>/`. One folder per document
 * rather than one shared bucket, so a 40-image manual does not bury every
 * other document's pictures and "everything that came out of this file" is
 * answerable by browsing. The slug comes from the source document's own slug,
 * so re-ingesting it lands in the same place.
 */
export async function ensureExtractedImagesFolder(args: {
  ownerId: string;
  sourceSlug: string;
  sourceTitle: string;
}): Promise<string> {
  return ensureAutoFiledFolder(args.ownerId, 'extracted-images', {
    document: { slug: args.sourceSlug, title: args.sourceTitle },
  });
}

// ─── The one-time move of the older top-level folders ────────────────────────

type Row = { id: string; path: string; title: string; filename: string | null };

async function childFolders(ownerId: string, path: string): Promise<Row[]> {
  return (await db.execute(sql`
    select id, path::text as path, title, null as filename from nodes
     where owner_id = ${ownerId} and type = 'branch'
       and path ~ ${`${path}.*{1}`}::lquery
     order by path`)) as unknown as Row[];
}

async function filesIn(ownerId: string, path: string): Promise<Row[]> {
  return (await db.execute(sql`
    select id, path::text as path, title, data->>'filename' as filename from nodes
     where owner_id = ${ownerId} and type = 'file' and path = ${path}::ltree
     order by id`)) as unknown as Row[];
}

async function filenameTaken(ownerId: string, path: string, filename: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1 from nodes
     where owner_id = ${ownerId} and type = 'file' and path = ${path}::ltree
       and lower(data->>'filename') = lower(${filename})
     limit 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** Move a file into `dest`; when the name is taken there, it becomes
 *  `name-2.ext` (then -3, ...) first, so nothing is overwritten. */
async function moveFileKeepingBoth(ownerId: string, file: Row, dest: string): Promise<void> {
  const filename = file.filename ?? file.title;
  if (await filenameTaken(ownerId, dest, filename)) {
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let n = 2;
    while (
      (await filenameTaken(ownerId, dest, `${stem}-${n}${ext}`)) ||
      (await filenameTaken(ownerId, file.path, `${stem}-${n}${ext}`))
    ) {
      n += 1;
    }
    await renameFileById({ ownerId, fileId: file.id, newStem: `${stem}-${n}` });
  }
  await moveFileById({ ownerId, fileId: file.id, destPath: dest });
}

/** Move everything in folder `from` into folder `into`, merging a subfolder
 *  into a same-named one there, then delete `from`. */
async function mergeFolderInto(ownerId: string, from: Row, into: string): Promise<void> {
  for (const child of await childFolders(ownerId, from.path)) {
    const label = child.path.split('.').at(-1)!;
    const target = `${into}.${label}`;
    if (await branchExists(ownerId, target)) await mergeFolderInto(ownerId, child, target);
    else await moveFolderById({ ownerId, folderId: child.id, destParentPath: into });
  }
  for (const file of await filesIn(ownerId, from.path))
    await moveFileKeepingBoth(ownerId, file, into);
  const res = await deleteFolder({ ownerId, folderId: from.id, allowSystem: true });
  if (!res.ok) throw new Error(`auto-filed: could not remove '${from.path}': ${res.reason}`);
}

export type AutoFiledReport = {
  /** Older top-level folders moved (or merged) into Auto-filed. */
  moved: AutoFiledSource[];
  /** Day folders merged into their month. */
  mergedDays: number;
};

const DAY_LABEL = /^(\d{4})_(\d{2})_\d{2}$/;

/**
 * Bring an older brain's machine folders into Auto-filed, once: each
 * `files.<source>` moves to `files.auto_filed.<source>` (merging when both
 * exist), and every day folder of a month source merges into its month.
 * Idempotent: a second run finds nothing to do. Run it where no file watcher
 * reacts to the moves (the watcher runs it before it starts).
 */
export async function reconcileAutoFiled(ownerId: string): Promise<AutoFiledReport> {
  const report: AutoFiledReport = { moved: [], mergedDays: 0 };
  for (const source of Object.keys(AUTO_FILED_SOURCES) as AutoFiledSource[]) {
    const spec: SourceSpec = AUTO_FILED_SOURCES[source];
    const legacyPath = `${FILES_ROOT_LABEL}.${dashToLtree(source)}`;
    const legacy = await folderByPath({ ownerId, path: legacyPath });
    const target = autoFiledSourcePath(source);
    if (legacy) {
      await ensureAutoFiledRoot(ownerId);
      if (await branchExists(ownerId, target)) {
        await mergeFolderInto(ownerId, { ...legacy, filename: null }, target);
      } else {
        await moveFolderById({ ownerId, folderId: legacy.id, destParentPath: AUTO_FILED_PATH });
      }
      report.moved.push(source);
    }
    if (spec.by === 'month' && (await branchExists(ownerId, target))) {
      for (const day of await childFolders(ownerId, target)) {
        const m = DAY_LABEL.exec(day.path.split('.').at(-1)!);
        if (!m) continue;
        const month = await ensureSystemFolder(
          ownerId,
          target,
          `${m[1]}-${m[2]}`,
          `${m[1]}-${m[2]}`,
          `${spec.name} from ${m[1]}-${m[2]}.`,
        );
        await mergeFolderInto(ownerId, day, month);
        report.mergedDays += 1;
      }
    }
  }
  if (report.moved.length || report.mergedDays) {
    // Folders that came from before Auto-filed get its names and its lock.
    for (const source of report.moved) {
      const spec: SourceSpec = AUTO_FILED_SOURCES[source];
      await db.execute(sql`
        update nodes set title = ${spec.name}, updated_at = now()
         where owner_id = ${ownerId} and type = 'branch'
           and path = ${autoFiledSourcePath(source)}::ltree`);
    }
    await db.execute(sql`
      update nodes set data = coalesce(data, '{}'::jsonb) || '{"system": true}'::jsonb
       where owner_id = ${ownerId} and type = 'branch'
         and path <@ ${AUTO_FILED_PATH}::ltree
         and coalesce((data->>'system')::boolean, false) = false`);
  }
  return report;
}
