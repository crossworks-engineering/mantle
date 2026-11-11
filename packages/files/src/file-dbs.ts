/**
 * A file's read-only database, on disk: its names and nothing else.
 *
 *   <files root>/.file-dbs/<file id>.<sha16>.sqlite   the rows
 *   <files root>/.file-dbs/<file id>.<sha16>.none     one word: why there are none
 *
 * Both are built from the file row's id and its sha256, so no column or stored
 * pointer names them, and new bytes need new names. Rights are the file row: a
 * caller who cannot read the row never gets here. The dot folder keeps them out
 * of the disk watcher and the staged sweep, as .upload-spool.
 *
 * Here and not in @mantle/content because deleteFileById sits below it. The
 * rows are written by buildFileDatabase (packages/content/src/file-database.ts).
 *
 * Removal only tidies the disk, so it logs and never throws: a missing folder
 * or a process with no files mount must not fail a commit hook or an extract.
 * It matches a file's names by a readdir and a prefix, never a glob, and leaves
 * a `.build-*` alone: that is a write in flight, or residue for the orphans
 * list.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterOuterCommit } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { filesRoot } from './paths';
import { CAD_EXTS } from './slug';

/** The extensions a file database (and an auto Table) can be read from.
 *
 *  `xml` earns its place only conditionally: most XML is not a plan, so the
 *  parse sniffs the content and a non-MSPDI document gets no name. */
export const FILE_DB_EXTS: ReadonlySet<string> = new Set([
  'xlsx',
  'xls',
  'csv',
  'xml',
  'dwf',
  ...CAD_EXTS,
]);

/** Why a file has no rows. */
export const FILE_DB_NONE_WORDS = ['too-large', 'no-rows', 'unreadable'] as const;
export type FileDbNoneWord = (typeof FILE_DB_NONE_WORDS)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9-]+$/;
/** A finished name: the file's id, the sha16, and a database's sidecars. */
const FINISHED_NAME = /^([A-Za-z0-9-]+)\.([0-9a-f]{16})\.(?:none|sqlite(?:-journal|-wal|-shm)?)$/;

/** A sha256 a name can be built from: 64 hex characters. */
export function isFileSha256(sha: unknown): sha is string {
  return typeof sha === 'string' && SHA256.test(sha);
}

/** The sha256 a file row holds, as stored: judge it with isFileSha256. */
export function fileSha256Of(row: { data: unknown }): unknown {
  return (row.data as Record<string, unknown> | null)?.sha256;
}

/** Whether this process can see the files root: worker_runs, among others,
 *  mounts neither it nor the table folder, so a missing name says nothing there. */
export async function filesRootMounted(): Promise<boolean> {
  return exists(filesRoot());
}

/** The folder of every file's names. */
export function fileDbsDir(): string {
  return path.join(filesRoot(), '.file-dbs');
}

/** The two names of a file at these bytes, or null when the row cannot name
 *  any (no valid sha256). */
export function fileDbPaths(
  fileId: string,
  sha256: unknown,
): { sqlite: string; none: string } | null {
  if (!isFileSha256(sha256) || !SAFE_ID.test(fileId)) return null;
  const base = path.join(fileDbsDir(), `${fileId}.${sha256.slice(0, 16)}`);
  return { sqlite: `${base}.sqlite`, none: `${base}.none` };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** The database of a file at these bytes, if it has been built. */
export async function fileDbSqlitePath(fileId: string, sha256: unknown): Promise<string | null> {
  const names = fileDbPaths(fileId, sha256);
  return names && (await exists(names.sqlite)) ? names.sqlite : null;
}

/** The word of a file at these bytes, if it has one. Anything else in the
 *  file reads as unreadable: the file says there are no rows, and why is lost. */
export async function readFileDbNone(
  fileId: string,
  sha256: unknown,
): Promise<FileDbNoneWord | null> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return null;
  let raw: string;
  try {
    raw = await fs.readFile(names.none, 'utf8');
  } catch {
    return null;
  }
  const word = raw.trim();
  return (FILE_DB_NONE_WORDS as readonly string[]).includes(word)
    ? (word as FileDbNoneWord)
    : 'unreadable';
}

/** Whether either name of a file at these bytes exists. */
export async function fileDbNameExists(fileId: string, sha256: unknown): Promise<boolean> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return false;
  return (await exists(names.sqlite)) || (await exists(names.none));
}

/** Write a file's word: a temp name in the same folder, then a rename, so a
 *  reader never sees half a word. A database of the same bytes goes after it
 *  (a rebuild that ends in a word must not leave the old rows to answer).
 *  Returns the path. */
export async function writeFileDbNone(
  fileId: string,
  sha256: string,
  word: FileDbNoneWord,
): Promise<string> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) throw new Error('writeFileDbNone: this row cannot name a file database');
  await fs.mkdir(path.dirname(names.none), { recursive: true });
  const build = `${names.none}.build-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(build, `${word}\n`);
    await fs.rename(build, names.none);
  } finally {
    await fs.rm(build, { force: true });
  }
  for (const side of ['', '-journal', '-wal', '-shm']) {
    await fs.rm(`${names.sqlite}${side}`, { force: true });
  }
  return names.none;
}

/** Remove a file's word at these bytes: its database was built after all. */
export async function removeFileDbNone(fileId: string, sha256: unknown): Promise<void> {
  const names = fileDbPaths(fileId, sha256);
  if (names) await fs.rm(names.none, { force: true });
}

/** A file's finished names on disk, with the sha16 each carries. A database's
 *  sidecars count as its name. Never a `.build-*`. */
async function namesOf(fileId: string): Promise<{ name: string; sha16: string }[]> {
  if (!SAFE_ID.test(fileId)) return [];
  let entries: string[];
  try {
    entries = await fs.readdir(fileDbsDir());
  } catch {
    return []; // no folder, or no files mount in this process
  }
  const out: { name: string; sha16: string }[] = [];
  for (const name of entries) {
    const m = FINISHED_NAME.exec(name);
    if (m && m[1] === fileId) out.push({ name, sha16: m[2]! });
  }
  return out;
}

/** One finished name in the folder. */
export type FileDbEntry = { name: string; fileId: string; sha16: string; bytes: number };
/** One `.build-*` in the folder: a write in flight, or residue. */
export type FileDbBuildEntry = { name: string; bytes: number; mtimeMs: number };

/**
 * What the folder holds, for the orphans list and the integrity screen. Regular
 * files only, never through a symlink. Anything else in it is not this module's
 * and is not listed. Empty with no folder, or no files mount in this process.
 */
export async function listFileDbFolder(): Promise<{
  names: FileDbEntry[];
  builds: FileDbBuildEntry[];
}> {
  const names: FileDbEntry[] = [];
  const builds: FileDbBuildEntry[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(fileDbsDir());
  } catch {
    return { names, builds };
  }
  for (const name of entries) {
    const stat = await fs.lstat(path.join(fileDbsDir(), name)).catch(() => null);
    if (!stat?.isFile()) continue; // gone since the readdir, or not a file
    const m = FINISHED_NAME.exec(name);
    if (m) names.push({ name, fileId: m[1]!, sha16: m[2]!, bytes: stat.size });
    else if (name.includes('.build-')) {
      builds.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return { names, builds };
}

/** Remove one entry the listing gave, by its exact name. */
export async function removeFileDbEntry(name: string): Promise<void> {
  await fs.rm(path.join(fileDbsDir(), path.basename(name)), { force: true });
}

/** Whether this process may write the folder: a box's maintenance container
 *  mounts the files root read-only unless it is asked not to. */
export async function fileDbsWritable(): Promise<boolean> {
  try {
    await fs.mkdir(fileDbsDir(), { recursive: true });
    await fs.access(fileDbsDir(), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeNames(fileId: string, keep: (sha16: string) => boolean): Promise<void> {
  try {
    const dir = fileDbsDir();
    for (const { name, sha16 } of await namesOf(fileId)) {
      if (!keep(sha16)) await fs.rm(path.join(dir, name), { force: true });
    }
  } catch (err) {
    console.error(`[file-dbs] could not remove the names of ${fileId}:`, errorMessage(err));
  }
}

/** Remove every name of a file. Logs and never throws. */
export function removeFileDbNames(fileId: string): Promise<void> {
  return removeNames(fileId, () => false);
}

/** Remove the names of a file whose sha16 is not this sha256's (no valid
 *  sha256: all of them). Logs and never throws. */
export function removeOtherFileDbNames(fileId: string, sha256: unknown): Promise<void> {
  const current = isFileSha256(sha256) ? sha256.slice(0, 16) : null;
  return removeNames(fileId, (sha16) => sha16 === current);
}

/**
 * A deleted file's names go once its row's delete has committed: inside an
 * outer transaction that may still roll back, they stay until then. Logs and
 * never throws, for a commit hook must not fail on a tidy-up. A process with no
 * files mount leaves an orphan, which is unreachable, as rights are the row.
 */
export async function removeFileDbNamesAfterCommit(fileId: string): Promise<void> {
  await afterOuterCommit(() => removeFileDbNames(fileId));
}
