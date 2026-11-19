/**
 * "Extract contents" of an archive (docs/files.md, "Archives"). The owner's
 * rule (2026-11-19): an archive is an archive. Nothing reads one on upload
 * (its text is its name, type, size and entry names: ./default-text.ts), and
 * no trigger, timer or sweep unpacks one. Only a person asks, by hand or
 * through an agent or MCP client acting for them (the route
 * POST /api/files/files/:id/extract and the tool `file_extract_archive`).
 *
 * Two halves:
 *
 *  1. The request (startArchiveExtract), in the caller's scope: the file is
 *     the caller's to change (the edit right, as a reindex asks), its name
 *     AND its first bytes say ZIP, TAR or gzip, no extraction of it is under
 *     way, and the caller may add a folder beside it. Then the archive is
 *     stamped `queued` (data.archive_extract, one atomic update, so two asks
 *     never both run), the new folder is made in the caller's scope (where
 *     it lands is the caller's home rule, docs/workspaces.md), and the job
 *     is sent (the `archive_extract` notify, taken by the extract queue's
 *     heavy lane in server/api). Nothing is unpacked in the request.
 *
 *  2. The job (runArchiveExtract), as the system, one at a time on the heavy
 *     lane. It runs only for a `queued` stamp: no stamp, no extraction. It
 *     reads the archive from disk as a stream (./archive-read.ts), checks
 *     the file count and the bytes together before writing anything, then
 *     writes each file into the new folder through the upload path
 *     (spoolUpload, then upsertFile): each is a new file node, read by the
 *     usual pipeline like any upload. The folders inside are kept; past the
 *     tree's depth (three folders below Files) the deeper folder names go
 *     into the file's name (`a-b-c.txt`), never dropped. A name taken in a
 *     folder gets `-2`, `-3`. A nested archive stays an archive: it is one
 *     more file, with its own "Extract contents".
 *
 * Every entry is written or reported: a refused one (a climbing or absolute
 * path, a link, a device, an encrypted or unknown entry, one past the entry
 * cap, one whose bytes do not match the archive's word) is in `refused` with
 * its reason; the macOS and Windows folder files are `skipped` (counted).
 * The stamp holds the progress while it runs and the result after.
 *
 * Rights: the request asks the edit of the archive and makes the folder as
 * the caller, so the folder lands where the caller may write; the job then
 * writes only inside that folder, as the system, and each file and folder it
 * makes takes the home of the folder it lands in (the database's default
 * home with no request home). It re-reads the folder by its id: moved, the
 * files follow it; gone, the job stops.
 */
import { open, stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db,
  isUniqueViolation,
  itemWriteVerdicts,
  nodes,
  notifyArchiveExtract,
  withHeads,
} from '@mantle/db';
import { ConflictError, errorMessage, InputError, UUID_RE } from '@mantle/std';
import { contentKey, getContent } from '@mantle/storage';
import { startTrace, step } from '@mantle/tracing';
import {
  ARCHIVE_LIMITS,
  ArchiveRefusedError,
  archiveBaseName,
  archiveExtOf,
  archiveKindOfHead,
  EntryDamagedError,
  EXTRACTABLE_ARCHIVE_EXTS,
  planArchive,
  walkArchive,
  type ArchiveEntry,
  type ArchiveLimits,
  type EntryRefusal,
} from './archive-read';
import { discardSpooled, spoolUpload, UploadTooLargeError, type SpooledUpload } from './disk';
import { emailAttachmentIds } from './email-attachments';
import { keyWithoutSearch } from './file-data';
import { maxStreamedUploadBytes } from './limits';
import { FILES_MAX_FOLDER_DEPTH, diskPathForFile, filesFolderDepth } from './paths';
import { dashToLtree, folderSlugOf, sanitizeFilename } from './slug';
import { foldedFilePath } from './space-disk';
import { callerMayEditFolder, fileNameTaken, upsertFile } from './ops/files';
import { createFolder, folderDisplayName } from './ops/folders';

/** The key of the stamp on the archive's data. */
export const ARCHIVE_EXTRACT_KEY = 'archive_extract';

/** A `queued` or `running` stamp older than this is taken as dead (the
 *  agent was down when it was sent, or stopped in the middle): a person may
 *  ask again. The job's own time budget is the extract queue's (60 min by
 *  default). */
export const ARCHIVE_EXTRACT_STALE_MS = 3 * 60 * 60 * 1000;

/** Refused entries named in the stamp; the rest are counted. */
export const ARCHIVE_REFUSED_LISTED = 100;

/** How often the job writes its progress on the stamp. */
const PROGRESS_FILES = 50;
const PROGRESS_MS = 3_000;

export type ArchiveExtractState = 'queued' | 'running' | 'done' | 'failed';

/** The stamp on the archive (`data.archive_extract`), as stored. */
export type ArchiveExtractStamp = {
  state: ArchiveExtractState;
  folder_id: string | null;
  folder_path: string | null;
  /** When it was asked (ISO). */
  at: string;
  started_at?: string;
  finished_at?: string;
  files: number;
  folders: number;
  bytes: number;
  skipped: number;
  flattened: number;
  refused: { name: string; reason: EntryRefusal }[];
  refused_count: number;
  error?: string;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);
const STATES: readonly ArchiveExtractState[] = ['queued', 'running', 'done', 'failed'];

/** The stamp of a file's data, checked, or null. */
export function archiveExtractOf(
  data: Readonly<Record<string, unknown>> | null | undefined,
): ArchiveExtractStamp | null {
  const raw = data?.[ARCHIVE_EXTRACT_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!STATES.includes(o.state as ArchiveExtractState) || typeof o.at !== 'string') return null;
  const refused = Array.isArray(o.refused)
    ? o.refused
        .filter(
          (r): r is { name: string; reason: EntryRefusal } =>
            !!r &&
            typeof (r as { name?: unknown }).name === 'string' &&
            typeof (r as { reason?: unknown }).reason === 'string',
        )
        .slice(0, ARCHIVE_REFUSED_LISTED)
        .map((r) => ({ name: r.name.slice(0, 220), reason: r.reason }))
    : [];
  return {
    state: o.state as ArchiveExtractState,
    folder_id: strOrNull(o.folder_id),
    folder_path: strOrNull(o.folder_path),
    at: o.at,
    ...(typeof o.started_at === 'string' ? { started_at: o.started_at } : {}),
    ...(typeof o.finished_at === 'string' ? { finished_at: o.finished_at } : {}),
    files: num(o.files),
    folders: num(o.folders),
    bytes: num(o.bytes),
    skipped: num(o.skipped),
    flattened: num(o.flattened),
    refused,
    refused_count: Math.max(num(o.refused_count), refused.length),
    ...(typeof o.error === 'string' ? { error: o.error.slice(0, 500) } : {}),
  };
}

/** Whether a stamp says an extraction is under way now (queued or running,
 *  and not older than ARCHIVE_EXTRACT_STALE_MS). */
export function archiveExtractBusy(stamp: ArchiveExtractStamp | null, now = Date.now()): boolean {
  if (!stamp || (stamp.state !== 'queued' && stamp.state !== 'running')) return false;
  // ISO times compare as text, as the claim's SQL compares them.
  return stamp.at > new Date(now - ARCHIVE_EXTRACT_STALE_MS).toISOString();
}

/** Whether a file is one this box extracts, by its name: the first bytes
 *  are asked too, by the request. */
export function isExtractableArchiveName(filename: string): boolean {
  const ext = archiveExtOf(filename);
  return ext !== null && EXTRACTABLE_ARCHIVE_EXTS.includes(ext);
}

const emptyStamp = (at: string): ArchiveExtractStamp => ({
  state: 'queued',
  folder_id: null,
  folder_path: null,
  at,
  files: 0,
  folders: 0,
  bytes: 0,
  skipped: 0,
  flattened: 0,
  refused: [],
  refused_count: 0,
});

/** Write the stamp on the archive. `onlyIf`: the update holds only while
 *  the stored stamp is still this one (its `at` and state); false when it
 *  did not hold. */
async function writeStamp(
  id: string,
  stamp: ArchiveExtractStamp,
  onlyIf?: { at: string; state: ArchiveExtractState },
): Promise<boolean> {
  const value = JSON.stringify(stamp);
  return withHeads([id], 'update', async (tx) => {
    const rows = await tx
      .update(nodes)
      .set({
        data: sql`coalesce(${nodes.data}, '{}'::jsonb) || jsonb_build_object(${ARCHIVE_EXTRACT_KEY}::text, ${value}::jsonb)`,
      })
      .where(
        and(
          eq(nodes.id, id),
          eq(nodes.type, 'file'),
          onlyIf
            ? sql`${nodes.data}->${ARCHIVE_EXTRACT_KEY}->>'at' = ${onlyIf.at}
                  and ${nodes.data}->${ARCHIVE_EXTRACT_KEY}->>'state' = ${onlyIf.state}`
            : undefined,
        ),
      )
      .returning({ id: nodes.id });
    return rows.length > 0;
  });
}

// ─── The request ───────────────────────────────────────────────────────

/** Why a request was refused, and the HTTP status of it. */
export type ArchiveExtractRefusal = {
  ok: false;
  status: 400 | 403 | 404 | 409;
  reason: 'not-found' | 'not-allowed' | 'not-archive' | 'sealed' | 'busy' | 'too-deep';
  error: string;
};

export type ArchiveExtractStarted = {
  ok: true;
  stamp: ArchiveExtractStamp;
  folder: { id: string; path: string; name: string };
};

type ArchiveRow = {
  id: string;
  title: string;
  path: string;
  data: Record<string, unknown>;
};

/** The archive file the caller reads (current, in its scope), or null. */
async function archiveRowFor(ownerId: string, fileId: string): Promise<ArchiveRow | null> {
  if (!UUID_RE.test(fileId)) return null;
  const [row] = await db
    .select({ id: nodes.id, title: nodes.title, path: nodes.path, data: nodes.data })
    .from(nodes)
    .where(
      and(
        eq(nodes.id, fileId),
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        isNull(nodes.supersededBy),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    path: String(row.path),
    data: (row.data ?? {}) as Record<string, unknown>,
  };
}

/** The name the file has on disk (data.filename), else its title. */
const fileNameOf = (row: ArchiveRow) =>
  typeof row.data.filename === 'string' && row.data.filename ? row.data.filename : row.title;

/** The first bytes of the archive, from disk or storage, or null. */
async function headOf(row: ArchiveRow, n: number): Promise<Buffer | null> {
  const { loadFileHead } = await import('./file-read');
  return loadFileHead(row, n);
}

/** Whether a file can be extracted, by its name and its first bytes: null
 *  when it can, else the refusal. Read only. */
export async function archiveExtractableRefusal(row: {
  id: string;
  title: string;
  path: string;
  data: Record<string, unknown>;
}): Promise<ArchiveExtractRefusal | null> {
  const name = fileNameOf(row);
  const ext = archiveExtOf(name);
  if (ext === '7z' || ext === 'rar') {
    return {
      ok: false,
      status: 400,
      reason: 'sealed',
      error: `This box cannot extract ${ext === '7z' ? '7z' : 'RAR'} archives: only ZIP, TAR and gzip (.zip, .tar, .tar.gz, .tgz, .gz).`,
    };
  }
  const notArchive: ArchiveExtractRefusal = {
    ok: false,
    status: 400,
    reason: 'not-archive',
    error:
      'This file is not an archive this box extracts: only ZIP, TAR and gzip (.zip, .tar, .tar.gz, .tgz, .gz).',
  };
  if (!ext) return notArchive;
  const head = await headOf(row, 512);
  const kind = head ? archiveKindOfHead(head) : null;
  if (kind === '7z' || kind === 'rar') {
    return { ...notArchive, reason: 'sealed', error: `This box cannot extract ${kind} archives.` };
  }
  if (kind !== 'zip' && kind !== 'tar' && kind !== 'gzip') {
    return {
      ...notArchive,
      error: head
        ? `The file is named as an archive, but its bytes are not a ZIP, a TAR or a gzip.`
        : "The file's bytes could not be read now, so it cannot be extracted.",
    };
  }
  return null;
}

/** The folder made for an extraction: the archive's name without its
 *  archive ending, `-2`, `-3` when taken. */
async function newFolderFor(
  ownerId: string,
  parentPath: string,
  archiveName: string,
): Promise<{ id: string; path: string; name: string }> {
  const base = folderDisplayName(archiveBaseName(archiveName)) || 'archive';
  for (let n = 1; n <= 50; n += 1) {
    const name = n === 1 ? base : folderDisplayName(`${base} ${n}`);
    const slug = folderSlugOf(name);
    if (!slug) break;
    try {
      const folder = await createFolder({
        ownerId,
        parentPath,
        slug,
        name,
        description: `The contents of ${archiveName.slice(0, 200)}, extracted on request.`,
      });
      return { id: folder.id, path: folder.path, name };
    } catch (err) {
      if (isUniqueViolation(err) || err instanceof ConflictError) continue;
      throw err;
    }
  }
  throw new InputError('No free folder name was found beside the archive.');
}

/**
 * Ask for the contents of an archive, in the caller's scope. The answer is
 * the queued stamp and the new folder, or the refusal: the file is not
 * there for the caller (`not-found`), not the caller's to change
 * (`not-allowed`, also when the caller may not add a folder beside it),
 * not an archive this box extracts (`not-archive`, `sealed`: 7z, RAR), one
 * whose extraction is under way (`busy`), or one in a folder with no room
 * for another below it (`too-deep`: move it up first).
 */
export async function startArchiveExtract(
  ownerId: string,
  fileId: string,
): Promise<ArchiveExtractStarted | ArchiveExtractRefusal> {
  const notFound: ArchiveExtractRefusal = {
    ok: false,
    status: 404,
    reason: 'not-found',
    error: 'No such file.',
  };
  const id = fileId.trim().toLowerCase();
  const row = await archiveRowFor(ownerId, id);
  if (!row) return notFound;
  // An API key without the Search area does not reach an email attachment
  // (access matrix M4), as on the file lists and a reindex.
  if (keyWithoutSearch() && (await emailAttachmentIds(ownerId, [id])).has(id)) return notFound;

  // The one rights check on the archive: whoever may change it by hand.
  const verdict = (await itemWriteVerdicts([id], 'edit')).get(id);
  if (verdict === 'no_read') return notFound;
  if (verdict !== 'ok') {
    return {
      ok: false,
      status: 403,
      reason: 'not-allowed',
      error: 'You may not change this file, so you may not extract it.',
    };
  }

  const refusal = await archiveExtractableRefusal(row);
  if (refusal) return refusal;

  if (archiveExtractBusy(archiveExtractOf(row.data))) {
    return {
      ok: false,
      status: 409,
      reason: 'busy',
      error: 'This archive is being extracted now. Its status shows the progress.',
    };
  }
  if (filesFolderDepth(row.path) + 1 > FILES_MAX_FOLDER_DEPTH) {
    return {
      ok: false,
      status: 400,
      reason: 'too-deep',
      error: `The archive is in a folder ${FILES_MAX_FOLDER_DEPTH} levels deep, so no folder for its contents fits beside it. Move it to a folder higher up, then extract it.`,
    };
  }
  // The folder beside it: the caller adds to it (the root is checked by the
  // create itself).
  if (row.path.includes('.') && (await callerMayEditFolder(ownerId, row.path)) === false) {
    return {
      ok: false,
      status: 403,
      reason: 'not-allowed',
      error: 'You may not add a folder where this archive is, so you may not extract it there.',
    };
  }

  // The claim: one atomic update, so two asks never both run.
  const at = new Date().toISOString();
  const cutoff = new Date(Date.now() - ARCHIVE_EXTRACT_STALE_MS).toISOString();
  const stamp = emptyStamp(at);
  const claimed = await withHeads([id], 'update', async (tx) => {
    const rows = await tx
      .update(nodes)
      .set({
        data: sql`coalesce(${nodes.data}, '{}'::jsonb) || jsonb_build_object(${ARCHIVE_EXTRACT_KEY}::text, ${JSON.stringify(stamp)}::jsonb)`,
      })
      .where(
        and(
          eq(nodes.id, id),
          eq(nodes.type, 'file'),
          sql`not (coalesce(${nodes.data}->${ARCHIVE_EXTRACT_KEY}->>'state', '') in ('queued', 'running')
                   and coalesce(${nodes.data}->${ARCHIVE_EXTRACT_KEY}->>'at', '') > ${cutoff})`,
        ),
      )
      .returning({ id: nodes.id });
    return rows.length > 0;
  });
  if (!claimed) {
    return {
      ok: false,
      status: 409,
      reason: 'busy',
      error: 'This archive is being extracted now. Its status shows the progress.',
    };
  }

  // The folder, made as the caller: its create checks the caller may add
  // here, and its home is the caller's home rule.
  let folder: { id: string; path: string; name: string };
  try {
    folder = await newFolderFor(ownerId, row.path, row.title || fileNameOf(row));
  } catch (err) {
    const failed: ArchiveExtractStamp = {
      ...stamp,
      state: 'failed',
      finished_at: new Date().toISOString(),
      error: 'The folder for its contents could not be made.',
    };
    await writeStamp(id, failed, { at, state: 'queued' }).catch(() => false);
    return {
      ok: false,
      status: 403,
      reason: 'not-allowed',
      error: `The folder for its contents could not be made beside the archive: ${errorMessage(err).slice(0, 200)}`,
    };
  }
  const queued: ArchiveExtractStamp = { ...stamp, folder_id: folder.id, folder_path: folder.path };
  await writeStamp(id, queued, { at, state: 'queued' });
  await notifyArchiveExtract(id);
  return { ok: true, stamp: queued, folder };
}

/** The state of the last extraction of a file the caller reads, and
 *  whether it can be extracted: for GET .../extract and the tool's `check`. */
export async function archiveExtractStatus(
  ownerId: string,
  fileId: string,
): Promise<
  | {
      ok: true;
      file: { id: string; name: string };
      extractable: boolean;
      why?: string;
      stamp: ArchiveExtractStamp | null;
    }
  | ArchiveExtractRefusal
> {
  const id = fileId.trim().toLowerCase();
  const row = await archiveRowFor(ownerId, id);
  const notFound: ArchiveExtractRefusal = {
    ok: false,
    status: 404,
    reason: 'not-found',
    error: 'No such file.',
  };
  if (!row) return notFound;
  if (keyWithoutSearch() && (await emailAttachmentIds(ownerId, [id])).has(id)) return notFound;
  const refusal = await archiveExtractableRefusal(row);
  return {
    ok: true,
    file: { id: row.id, name: fileNameOf(row) },
    extractable: refusal === null,
    ...(refusal ? { why: refusal.error } : {}),
    stamp: archiveExtractOf(row.data),
  };
}

// ─── The job ───────────────────────────────────────────────────────────

/** The bytes of an archive as a file on disk: its own file, or a copy from
 *  storage spooled for the job (removed after). */
async function archiveOnDisk(
  row: ArchiveRow,
): Promise<{ path: string; temp: SpooledUpload | null } | null> {
  const filename = fileNameOf(row);
  const own = foldedFilePath(row) ?? diskPathForFile(row.path, filename);
  if (own) {
    try {
      if ((await stat(own)).isFile()) return { path: own, temp: null };
    } catch {
      // not on disk: storage below
    }
  }
  const sha = row.data.sha256;
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  try {
    const { body } = await getContent(contentKey(sha));
    const temp = await spoolUpload(body as Readable, { maxBytes: maxStreamedUploadBytes() });
    return { path: temp.tempPath, temp };
  } catch {
    return null;
  }
}

/** The first `n` bytes of a file on disk. */
async function diskHead(file: string, n: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Faults that stop the whole job (the disk is full), not one entry. */
function fatal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EROFS';
}

/** An entry fault, by its kind. */
function refusalOf(err: unknown): EntryRefusal {
  if (err instanceof EntryDamagedError) return 'damaged';
  if (err instanceof UploadTooLargeError) return 'too-large';
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code.startsWith('Z_') || code.startsWith('ERR_ZLIB'))) {
    return 'damaged';
  }
  return 'not-written';
}

/** A file name not yet used in the folder: `name`, `name-2`, `name-3`. */
function unusedName(used: Set<string>, filename: string): string {
  if (!used.has(filename)) return filename;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const next = `${stem.slice(0, 170)}-${n}${ext}`;
    if (!used.has(next)) return next;
  }
}

/** Where one file lands below the extraction's folder: the archive's
 *  folders while the tree has room, and the rest of them in its name. */
export function placeEntry(
  segments: readonly string[],
  room: number,
): { folders: string[]; name: string; title: string; flattened: boolean } {
  const dirs = segments.slice(0, -1);
  const base = segments[segments.length - 1] ?? '';
  const keep = dirs.slice(0, Math.max(0, room));
  const extra = dirs.slice(keep.length);
  return {
    folders: keep,
    name: [...extra, base].join('-'),
    title: [...extra, base].join('/'),
    flattened: extra.length > 0,
  };
}

export type ArchiveExtractJobOptions = {
  /** Lower limits, for the tests. */
  limits?: Partial<ArchiveLimits>;
};

/**
 * The job: extract the archive `archiveId` into the folder its `queued`
 * stamp names. Never throws for the archive's own faults: the stamp says
 * `failed` and why. Returns the last stamp, or null when there was no
 * queued request (nothing runs without one).
 */
export async function runArchiveExtract(
  ownerId: string,
  archiveId: string,
  opts: ArchiveExtractJobOptions = {},
): Promise<ArchiveExtractStamp | null> {
  if (!UUID_RE.test(archiveId)) return null;
  const row = await archiveRowFor(ownerId, archiveId);
  const asked = row ? archiveExtractOf(row.data) : null;
  if (!row || !asked || asked.state !== 'queued' || !asked.folder_id) return null;

  return startTrace(
    {
      kind: 'content_ingest',
      ownerId,
      subjectId: row.id,
      subjectKind: 'node',
      data: { source: 'archive_extract' },
    },
    () =>
      step(
        {
          name: 'archive_extract',
          kind: 'compute',
          input: { archive: row.id, folder: asked.folder_id },
        },
        async (h) => {
          const last = await extractInto(ownerId, row, asked, opts);
          h.setMeta({
            state: last.state,
            files: last.files,
            folders: last.folders,
            bytes: last.bytes,
            refused: last.refused_count,
            skipped: last.skipped,
            flattened: last.flattened,
          });
          if (last.state === 'failed' && last.error) h.setError(last.error);
          return last;
        },
      ),
  );
}

async function extractInto(
  ownerId: string,
  row: ArchiveRow,
  asked: ArchiveExtractStamp,
  opts: ArchiveExtractJobOptions,
): Promise<ArchiveExtractStamp> {
  const cur: ArchiveExtractStamp = { ...asked, refused: [], refused_count: 0 };
  const fail = async (error: string): Promise<ArchiveExtractStamp> => {
    cur.state = 'failed';
    cur.error = error;
    cur.finished_at = new Date().toISOString();
    await writeStamp(row.id, cur).catch(() => false);
    return cur;
  };

  // The folder by its id, now: moved, the files follow it.
  const [folder] = await db
    .select({ path: nodes.path })
    .from(nodes)
    .where(
      and(eq(nodes.id, asked.folder_id!), eq(nodes.ownerId, ownerId), eq(nodes.type, 'branch')),
    )
    .limit(1);
  if (!folder) {
    // The claim first, so a second job of the same ask does nothing.
    if (
      !(await writeStamp(row.id, { ...cur, state: 'running' }, { at: asked.at, state: 'queued' }))
    ) {
      return asked;
    }
    return fail('The folder made for its contents is gone. Ask again to extract it.');
  }
  const destPath = String(folder.path);
  cur.folder_path = destPath;
  cur.state = 'running';
  cur.started_at = new Date().toISOString();
  if (!(await writeStamp(row.id, cur, { at: asked.at, state: 'queued' }))) return asked;

  const limits: ArchiveLimits = {
    ...ARCHIVE_LIMITS,
    maxEntryBytes: Math.min(ARCHIVE_LIMITS.maxEntryBytes, maxStreamedUploadBytes()),
    ...opts.limits,
  };

  const local = await archiveOnDisk(row);
  if (!local) return fail("The archive's bytes could not be read now.");
  try {
    const kind = archiveKindOfHead(await diskHead(local.path, 512));
    if (kind !== 'zip' && kind !== 'tar' && kind !== 'gzip') {
      return fail('The bytes are not a ZIP, a TAR or a gzip.');
    }
    // The whole archive's count and bytes, before anything is written.
    try {
      await planArchive(local.path, kind, limits);
    } catch (err) {
      if (err instanceof ArchiveRefusedError) return fail(err.message);
      throw err;
    }
    await writeEntries(ownerId, row, local.path, kind, destPath, limits, cur);
    cur.state = 'done';
    cur.finished_at = new Date().toISOString();
    await writeStamp(row.id, cur);
    return cur;
  } catch (err) {
    if (err instanceof ArchiveRefusedError) return fail(err.message);
    return fail(
      `The extraction stopped after ${cur.files} files: ${errorMessage(err).slice(0, 300)}`,
    );
  } finally {
    if (local.temp) await discardSpooled(local.temp);
  }
}

/** The write pass: every entry written or reported on `cur`. */
async function writeEntries(
  ownerId: string,
  row: ArchiveRow,
  file: string,
  kind: 'zip' | 'tar' | 'gzip',
  destPath: string,
  limits: ArchiveLimits,
  cur: ArchiveExtractStamp,
): Promise<void> {
  const room = FILES_MAX_FOLDER_DEPTH - filesFolderDepth(destPath);
  /** Folder made for each archive folder, by its ltree path. */
  const made = new Set<string>([destPath]);
  /** File names written in each folder this run. */
  const used = new Map<string, Set<string>>();
  let lastWrite = Date.now();
  let sinceWrite = 0;

  const refuse = (name: string, reason: EntryRefusal) => {
    cur.refused_count += 1;
    if (cur.refused.length < ARCHIVE_REFUSED_LISTED) cur.refused.push({ name, reason });
  };

  const ensureFolders = async (segments: readonly string[]): Promise<string> => {
    let parent = destPath;
    for (const seg of segments) {
      const name = folderDisplayName(seg) || 'folder';
      const slug = folderSlugOf(name) ?? 'folder';
      const childPath = `${parent}.${dashToLtree(slug)}`;
      if (!made.has(childPath)) {
        try {
          await createFolder({ ownerId, parentPath: parent, slug, name });
          cur.folders += 1;
        } catch (err) {
          // Made by an earlier entry of another spelling ("Docs", "docs"),
          // or by someone meanwhile: it is the same folder.
          if (!isUniqueViolation(err) && !(err instanceof ConflictError)) throw err;
          const [there] = await db
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
          if (!there) throw err;
        }
        made.add(childPath);
      }
      parent = childPath;
    }
    return parent;
  };

  const progress = async () => {
    sinceWrite += 1;
    if (sinceWrite < PROGRESS_FILES && Date.now() - lastWrite < PROGRESS_MS) return;
    sinceWrite = 0;
    lastWrite = Date.now();
    await writeStamp(row.id, cur).catch(() => false);
  };

  const archiveName = fileNameOf(row);
  await walkArchive(file, kind, limits, async (entry: ArchiveEntry) => {
    if (entry.type === 'refused') return refuse(entry.name, entry.reason);
    if (entry.type === 'skipped') {
      cur.skipped += 1;
      return;
    }
    if (entry.type === 'dir') {
      // An empty folder is kept too, as far as the tree has room.
      try {
        await ensureFolders(entry.segments.slice(0, Math.max(0, room)));
      } catch (err) {
        if (fatal(err)) throw err;
        refuse(shownName(`${entry.segments.join('/')}/`), 'not-written');
      }
      return;
    }
    // A lone gzip's one file has the archive's name without `.gz`.
    const segments = entry.segments.length > 0 ? entry.segments : [archiveBaseName(archiveName)];
    const shown = segments.join('/');
    const place = placeEntry(segments, room);
    let spooled: SpooledUpload | null = null;
    try {
      const parentPath = await ensureFolders(place.folders);
      spooled = await spoolUpload(entry.open(), { maxBytes: limits.maxEntryBytes });
      const names = used.get(parentPath) ?? new Set<string>();
      used.set(parentPath, names);
      const ext = /\.([a-z0-9]{1,16})$/i.exec(place.name)?.[1]?.toLowerCase();
      const clean =
        sanitizeFilename(place.name) ??
        `file-${cur.files + cur.refused_count + 1}${ext ? `.${ext}` : ''}`;
      // A name taken in the folder (by an earlier entry of this archive,
      // or by someone meanwhile) gets the next number. A race lost after
      // this look is the entry's refusal (`not-written`), never an
      // overwrite.
      let filename = unusedName(names, clean);
      for (
        let tries = 0;
        tries < 20 && (await fileNameTaken(ownerId, parentPath, filename));
        tries += 1
      ) {
        names.add(filename);
        filename = unusedName(names, clean);
      }
      names.add(filename);
      await upsertFile({
        ownerId,
        parentPath,
        filename,
        spooled,
        title: place.title.slice(0, 200),
        data: { from_archive: { id: row.id, path: shown.slice(0, 500) } },
      });
      cur.files += 1;
      cur.bytes += spooled.size;
      if (place.flattened) cur.flattened += 1;
    } catch (err) {
      if (fatal(err)) throw err;
      refuse(shownName(shown), refusalOf(err));
    } finally {
      if (spooled) await discardSpooled(spooled);
    }
    await progress();
  });
}

const shownName = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);
