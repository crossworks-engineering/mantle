/**
 * A missing file database: one rule for the coverage check
 * (server/web/lib/integrity/file-coverage.ts, its `noDb`) and the build of
 * the missing ones (`pipeline_reread` with `missing`, packages/tools), so the
 * count the check gives is the count the build takes.
 *
 * A file misses its database when all of these are true:
 *  - its type has a Reader with a database that takes every file of it
 *    (dbExpected: not the PDF, whose router sends only drawings and books to
 *    a Reader, and not a type a Reader takes only some files of);
 *  - it was read (indexed or partial): a file not read yet gets its database
 *    from its read, and a skipped one needs a read of its text first;
 *  - its current bytes have no name in the folder (`id.sha16`): no database,
 *    and no word that stands for one. `no-rows` (read, nothing in it) and
 *    `too-large` (said by its own cut) stand for one; `unreadable` (the
 *    parser refused the bytes) does not, so a newer parser may read it.
 *
 * Mostly a file read before its Reader shipped. Its database comes from one
 * run of the Reader, with no model (server/api extract/pipeline-run.ts).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { extractionOf } from './extraction-status';
import { fileSha256Of, readFileDbNone, type listFileDbFolder } from './file-dbs';
import type { FileDataRow } from './file-data';
import { SOME_FILES_EXTS } from './slug';

/** The folder of file databases, as listFileDbFolder gives it. */
export type FileDbFolder = Awaited<ReturnType<typeof listFileDbFolder>>;

/** One file, as the rule reads it: its type, its read keys, its bytes'
 *  checksum (in `data`, from fileReadStateKeys). */
export type ReadStateFile = { id: string; ext: string; data: Record<string, unknown> };

/** Whether a type's files are expected to have a file database: a Reader
 *  with a database takes the type, and takes every file of it (not the
 *  PDF, whose router sends only drawings and books to a Reader, and not
 *  the types a Reader takes only some files of). `dbExts`: the box's
 *  (boxPipelines). */
export function dbExpected(ext: string, dbExts: ReadonlySet<string>): boolean {
  return dbExts.has(ext) && ext !== 'pdf' && !SOME_FILES_EXTS.has(ext);
}

/** The key a file's database name carries for these bytes, or null with no
 *  checksum. */
export function fileDbKeyOf(file: Pick<ReadStateFile, 'id' | 'data'>): string | null {
  const sha = fileSha256Of(file);
  return typeof sha === 'string' ? `${file.id}.${sha.slice(0, 16)}` : null;
}

/**
 * The keys (`id.sha16`) that hold a database, or a word that stands for one,
 * of the folder. The word of a `.none` name is read for these files only
 * (one small read each), and `unreadable` does not stand for a database.
 */
export async function heldDatabaseKeys(
  folder: FileDbFolder,
  files: readonly Pick<ReadStateFile, 'id' | 'data'>[],
): Promise<Set<string>> {
  const held = new Set(folder.names.map((n) => `${n.fileId}.${n.sha16}`));
  const words = new Set(
    folder.names.filter((n) => n.name.endsWith('.none')).map((n) => `${n.fileId}.${n.sha16}`),
  );
  for (const f of files) {
    const key = fileDbKeyOf(f);
    if (key === null || !words.has(key)) continue;
    if ((await readFileDbNone(f.id, fileSha256Of(f))) === 'unreadable') held.delete(key);
  }
  return held;
}

/** Whether this file was read: its text is there (indexed or partial). */
export function fileWasRead(data: Readonly<Record<string, unknown>>): boolean {
  const state = extractionOf(data).state;
  return state === 'indexed' || state === 'partial';
}

/** Whether this file misses its database (the rule at the top). `held`:
 *  heldDatabaseKeys of the folder. */
export function missesDatabase(
  file: ReadStateFile,
  dbExts: ReadonlySet<string>,
  held: ReadonlySet<string>,
): boolean {
  if (!dbExpected(file.ext, dbExts) || !fileWasRead(file.data)) return false;
  const key = fileDbKeyOf(file);
  return key === null || !held.has(key);
}

/** The keys of `data` the rule and the coverage check read, written out in
 *  the SQL: the read state's own (extractionOf, readCutsOfFile), the read's
 *  stamp (`read_by`), the checksum, and the name and type of the file.
 *  Never its text. */
export const fileReadStateKeys = () => sql<Record<string, unknown>>`jsonb_strip_nulls(jsonb_build_object(
  'filename', ${nodes.data}->'filename',
  'mimeType', ${nodes.data}->'mimeType',
  'sha256', ${nodes.data}->'sha256',
  'indexing_applied', ${nodes.data}->'indexing_applied',
  'extract_skipped', ${nodes.data}->'extract_skipped',
  'extract_parked', ${nodes.data}->'extract_parked',
  'extract_completed_at', ${nodes.data}->'extract_completed_at',
  'read_cut', ${nodes.data}->'read_cut',
  'ocr', ${nodes.data}->'ocr',
  'images', ${nodes.data}->'images',
  'read_by', ${nodes.data}->'read_by'))`;

/**
 * The live file rows of these types (by the name's extension, as
 * fileDataExt reads it), by id, after `after`, at most `limit`, with the
 * keys the rule reads (fileReadStateKeys). In the caller's scope. An
 * extension that is not a short word of letters and digits is left out of
 * the pattern rather than escaped (a manifest's extension is one).
 */
export async function fileRowsOfTypes(
  ownerId: string,
  exts: readonly string[],
  opts: { after?: string; limit: number },
): Promise<FileDataRow[]> {
  const words = exts.filter((ext) => /^[a-z0-9]{1,16}$/.test(ext));
  if (words.length === 0) return [];
  return db
    .select({ id: nodes.id, path: nodes.path, title: nodes.title, data: fileReadStateKeys() })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        isNull(nodes.supersededBy),
        sql`coalesce(${nodes.data}->>'snapshot_of', '') = ''`,
        sql`lower(coalesce(${nodes.data}->>'filename', ${nodes.title})) ~ ${`\\.(${words.join('|')})$`}`,
        opts.after ? sql`${nodes.id} > ${opts.after}::uuid` : undefined,
      ),
    )
    .orderBy(asc(nodes.id))
    .limit(opts.limit);
}
