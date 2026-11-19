/**
 * A file's read-only database, on disk: its names and nothing else.
 *
 *   <files root>/.file-dbs/<file id>.<sha16>.sqlite   the rows
 *   <files root>/.file-dbs/<file id>.<sha16>.none     one word: why there are none
 *   <files root>/.file-dbs/<file id>.<sha16>.stage-<run16>-<first page>.json
 *                                                     one page window a Reader
 *                                                     read, kept until the build
 *
 * The word is the first line of a `.none`. A file whose Reader gave its text
 * and no tabs (docs/pipelines.md, "Text and pictures from every Reader") has
 * the word `no-rows` and, as a second line, the stamp of that Reader as JSON:
 * the one place its stamp can sit, as it has no database. Every reader of the
 * word reads the first line only (readFileDbNone).
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
 *
 * The window stage (docs/pipelines.md, "Page windows"; a book read again
 * after an expire or a restart): each page window a Reader read in a real
 * read is kept here as it ends, one JSON file a window, named by the file's
 * id, its bytes (the sha16 in the name, the whole sha256 inside), the run
 * (`run16`: the hash of the Reader's run key: its id and version, the sha256,
 * the options and the kind it was named) and the window's first page. A
 * read of the same bytes by the same run takes the windows kept and reads on
 * from the first one that is not. The stage is not a database: the lists
 * below (finishedFileDbNames, fileIdsWithDatabase, listFileDbFolder) never
 * show it. It goes at the end of the build (removeWindowStage), with every
 * name of the file (removeFileDbNames: a delete, a file turned private), and
 * when the file's bytes change (removeOtherFileDbNames and
 * removeOtherWindowStages: the next extract).
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { afterOuterCommit } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { filesRoot } from './paths';

/** Why a file has no rows. */
export const FILE_DB_NONE_WORDS = ['too-large', 'no-rows', 'unreadable'] as const;
export type FileDbNoneWord = (typeof FILE_DB_NONE_WORDS)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9-]+$/;
/** A finished name: the file's id, the sha16, and a database's sidecars. */
const FINISHED_NAME = /^([A-Za-z0-9-]+)\.([0-9a-f]{16})\.(?:none|sqlite(?:-journal|-wal|-shm)?)$/;
/** A window kept by the stage: the file's id, the sha16, the run16 and the
 *  window's first page. */
const STAGE_NAME =
  /^([A-Za-z0-9-]+)\.([0-9a-f]{16})\.stage-([0-9a-f]{16})-([1-9][0-9]{0,8})\.json$/;
const RUN16 = /^[0-9a-f]{16}$/;

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

/** The word of a file at these bytes, if it has one: its first line. Anything
 *  else there reads as unreadable: the file says there are no rows, and why
 *  is lost. */
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
  const word = fileDbWordOf(raw);
  return (FILE_DB_NONE_WORDS as readonly string[]).includes(word)
    ? (word as FileDbNoneWord)
    : 'unreadable';
}

/** The word of a `.none`'s text: its first line, trimmed. */
export function fileDbWordOf(raw: string): string {
  return (raw.split('\n', 1)[0] ?? '').trim();
}

/** The stamp a file's word carries at these bytes (its second line), as the
 *  keys and text values it holds, or null: no word, no second line, or one
 *  that is not a JSON object. Read it with stampOfMeta (./pipelines/stamp.ts). */
export async function readFileDbNoneStamp(
  fileId: string,
  sha256: unknown,
): Promise<Readonly<Record<string, string>> | null> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return null;
  let raw: string;
  try {
    raw = await fs.readFile(names.none, 'utf8');
  } catch {
    return null;
  }
  const second = raw.split('\n')[1]?.trim();
  if (!second) return null;
  try {
    const o = JSON.parse(second) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return Object.fromEntries(
      Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return null;
  }
}

/** Whether either name of a file at these bytes exists. */
export async function fileDbNameExists(fileId: string, sha256: unknown): Promise<boolean> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) return false;
  return (await exists(names.sqlite)) || (await exists(names.none));
}

/** Write a file's word: a temp name in the same folder, then a rename, so a
 *  reader never sees half a word. A word from a parse that read the bytes
 *  (`parsed`: no rows, or more rows than the cap) also removes the database
 *  of the same bytes, as a rebuild that ends in that word must not leave the
 *  old rows to answer. A word from a failure (`unreadable`, the parser's
 *  `too_large`) leaves it: a box under load can fail once on bytes whose
 *  database is still right. Left open, by choice: a second build of the same
 *  bytes that runs at the same time can write its database just before this
 *  removes it, and the next build writes it again. Returns the path. */
export async function writeFileDbNone(
  fileId: string,
  sha256: string,
  word: FileDbNoneWord,
  opts: {
    parsed?: boolean;
    /** The stamp of the Reader whose text the file has, for its second line. */
    stamp?: Readonly<Record<string, string>>;
  } = {},
): Promise<string> {
  const names = fileDbPaths(fileId, sha256);
  if (!names) throw new Error('writeFileDbNone: this row cannot name a file database');
  await fs.mkdir(path.dirname(names.none), { recursive: true });
  const build = `${names.none}.build-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(build, `${word}\n${opts.stamp ? `${JSON.stringify(opts.stamp)}\n` : ''}`);
    await fs.rename(build, names.none);
  } finally {
    await fs.rm(build, { force: true });
  }
  if (opts.parsed) {
    for (const side of ['', '-journal', '-wal', '-shm']) {
      await fs.rm(`${names.sqlite}${side}`, { force: true });
    }
  }
  return names.none;
}

/** Remove a file's word at these bytes: its database was built after all. */
export async function removeFileDbNone(fileId: string, sha256: unknown): Promise<void> {
  const names = fileDbPaths(fileId, sha256);
  if (names) await fs.rm(names.none, { force: true });
}

/** A file's finished names on disk, with the sha16 each carries. A database's
 *  sidecars count as its name, and so does a window its stage keeps. Never a
 *  `.build-*`. */
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
    const m = FINISHED_NAME.exec(name) ?? STAGE_NAME.exec(name);
    if (m && m[1] === fileId) out.push({ name, sha16: m[2]! });
  }
  return out;
}

/**
 * Every finished name in the folder (regular files only), from one read of
 * it and no look at a file: a list's look at many rows at once (a file's
 * status in Files), which then checks each row's own names against it.
 * Empty with no folder, or no files mount in this process.
 */
export async function finishedFileDbNames(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(fileDbsDir(), { withFileTypes: true });
    return new Set(
      entries.filter((e) => e.isFile() && FINISHED_NAME.test(e.name)).map((e) => e.name),
    );
  } catch {
    return new Set(); // no folder, or no files mount in this process
  }
}

/**
 * The ids of the files that have a database on disk, at any bytes: one read
 * of the folder, no look at a file. The list of data files asks only for
 * the PDFs among these, so a PDF with no database costs it nothing. A name
 * of older bytes is in it too: the caller still checks each row's own name.
 * `words`: the ids with a word too (the look of the pipelines, which reads
 * the stamp a word of a Reader's text carries). Sorted, the ids with a
 * database first and the ids with a word only after them, so a capped look
 * gives words only the room the databases leave.
 */
export async function fileIdsWithDatabase(opts: { words?: boolean } = {}): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(fileDbsDir());
  } catch {
    return []; // no folder, or no files mount in this process
  }
  const dbs = new Set<string>();
  const words = new Set<string>();
  for (const name of entries) {
    const m = FINISHED_NAME.exec(name);
    if (!m) continue;
    if (name.endsWith('.sqlite')) dbs.add(m[1]!);
    else if (opts.words === true && name.endsWith('.none')) words.add(m[1]!);
  }
  return [...[...dbs].sort(), ...[...words].filter((id) => !dbs.has(id)).sort()];
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

/** One window the stage keeps: its first page and its JSON as written. */
export type StagedWindow = { from: number; body: string };

/** The stage's names of one run of a file at these bytes, or null when the
 *  row cannot name any. */
function stagePrefixOf(fileId: string, sha256: unknown, run16: string): string | null {
  if (!isFileSha256(sha256) || !SAFE_ID.test(fileId) || !RUN16.test(run16)) return null;
  return `${fileId}.${sha256.slice(0, 16)}.stage-${run16}-`;
}

/**
 * The windows the stage keeps of one run of a file at these bytes, by their
 * first page, each read only when asked for (one window in memory at a
 * time): one read of the folder now. The caller checks what each holds (its
 * sha256 and run key) before it uses it. Empty with no folder, no files
 * mount, or a row that names none. A file that cannot be read reads as null:
 * its window is read again.
 */
export async function readWindowStage(
  fileId: string,
  sha256: unknown,
  run16: string,
): Promise<Map<number, () => Promise<string | null>>> {
  const out = new Map<number, () => Promise<string | null>>();
  const prefix = stagePrefixOf(fileId, sha256, run16);
  if (!prefix) return out;
  let entries: string[];
  try {
    entries = await fs.readdir(fileDbsDir());
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const m = STAGE_NAME.exec(name);
    if (!m) continue;
    const abs = path.join(fileDbsDir(), name);
    out.set(Number(m[4]), () => fs.readFile(abs, 'utf8').catch(() => null));
  }
  return out;
}

/**
 * Keep one window of a run: a temp name in the same folder, then a rename, so
 * a reader never sees half a window. Returns false (and logs) when it could
 * not be written: the run goes on, and only a resume loses that window.
 */
export async function writeWindowStage(
  fileId: string,
  sha256: unknown,
  run16: string,
  from: number,
  body: string,
): Promise<boolean> {
  const prefix = stagePrefixOf(fileId, sha256, run16);
  if (!prefix || !Number.isInteger(from) || from < 1) return false;
  const abs = path.join(fileDbsDir(), `${prefix}${from}.json`);
  const build = `${abs}.build-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.mkdir(fileDbsDir(), { recursive: true });
    await fs.writeFile(build, body);
    await fs.rename(build, abs);
    return true;
  } catch (err) {
    log('file-dbs').warn(`a window of ${fileId} was not kept: ${errorMessage(err)}`);
    return false;
  } finally {
    await fs.rm(build, { force: true }).catch(() => {});
  }
}

/** The stage of a file at these bytes, every run of it: its build is done.
 *  Logs and never throws. */
export async function removeWindowStage(fileId: string, sha256: unknown): Promise<void> {
  if (!isFileSha256(sha256)) return;
  const sha16 = sha256.slice(0, 16);
  await removeStages(fileId, (s) => s !== sha16);
}

/** The stage of a file at any bytes but these (no valid sha256: all of it):
 *  the bytes changed, and no read of the new ones takes the old windows.
 *  Logs and never throws. */
export async function removeOtherWindowStages(fileId: string, sha256: unknown): Promise<void> {
  const current = isFileSha256(sha256) ? sha256.slice(0, 16) : null;
  await removeStages(fileId, (s) => s === current);
}

async function removeStages(fileId: string, keep: (sha16: string) => boolean): Promise<void> {
  if (!SAFE_ID.test(fileId)) return;
  try {
    const dir = fileDbsDir();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // no folder, or no files mount in this process
    }
    for (const name of entries) {
      const m = STAGE_NAME.exec(name);
      if (m && m[1] === fileId && !keep(m[2]!)) await fs.rm(path.join(dir, name), { force: true });
    }
  } catch (err) {
    log('file-dbs').warn(`could not remove the window stage of ${fileId}: ${errorMessage(err)}`);
  }
}
