/**
 * File coverage: how fully each file type is read, per box, in numbers only
 * (the file ingestion program, its coverage check). Read only, like every
 * check of the corpus audit: one SELECT in a READ ONLY transaction, a
 * listing of the file database folder, and the one-word first line of the
 * `.none` names of its files. It writes nothing and names no file:
 * a row is a file type and its counts.
 *
 * A file is "not full" when one of these is true:
 *  - its read failed, or it was skipped for a reason other than an empty
 *    body (`no_parser`, `no_vision_text`, ...);
 *  - no reader takes its type (the default text: name, type and size; an
 *    archive is read as what it is, by design, so it is no shortfall), or
 *    its read is stamped as that default text (`read_by` reader `none`): a
 *    type that has a reader now and whose file has not been read again (a
 *    code file read as a name card before 2026-11-25);
 *  - it holds a shortcut cut: a reader that read only the first part to save
 *    work (SHORTCUT_CUT_REASONS). A safety cut (a size or a cost bound) is
 *    counted in `cuts` but is not a shortfall;
 *  - its type has a Reader with a file database and its current bytes have
 *    none (the PDF and the types whose Reader takes only some files left
 *    out, as in the file database lines).
 * A file not read yet (`pending`) or indexed by name on purpose (`name_only`)
 * is counted, never "not full".
 *
 * Two ways in, one function: the audit line `file_coverage` (the five types
 * with the most files not full) and `pnpm -C server/web files:coverage`
 * (every type).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { boxPipelines } from '@mantle/content/pipeline-registry';
import { nodes, readOnlyTransaction } from '@mantle/db';
import {
  EXPORT_REQUIRED_EXTS,
  EXTRACTABLE_ARCHIVE_EXTS,
  extOf,
  extractionOf,
  fileSha256Of,
  isVisionImage,
  listFileDbFolder,
  MEDIA_EXTS,
  mimeForExt,
  parserRouteForExt,
  readByOf,
  readFileDbNone,
  SEALED_ARCHIVE_EXTS,
  SOME_FILES_EXTS,
} from '@mantle/files';
import { cutMakesPartial, readCutReason } from '@mantle/files/read-cut';
import type { AuditCheck } from '@mantle/client-types/types/integrity';

/** The folder of file databases, as listFileDbFolder gives it. */
export type FileDbFolder = Awaited<ReturnType<typeof listFileDbFolder>>;

/** The types the coverage check scores (the plan's popular list). Others
 *  are counted and listed, not scored. */
export const POPULAR_EXTS: ReadonlySet<string> = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xlsm',
  'xls',
  'xlsb',
  'csv',
  'tsv',
  'pptx',
  'ppt',
  'odt',
  'ods',
  'odp',
  'rtf',
  'epub',
  'txt',
  'md',
  'html',
  'xml',
  'json',
  'eml',
  'msg',
  'mbox',
  'accdb',
  'mdb',
  'dwg',
  'dxf',
  'dgn',
  'dwf',
  'vsdx',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
  'zip',
]);

/** The types the check names whatever reads them, so they show as
 *  themselves, not as `(other)`: the popular ones, and the plan's gap types
 *  (eml, msg and mbox have the Reader `mail` since A1). A type some route
 *  reads is named by that too. */
const NAMED_TYPES: ReadonlySet<string> = new Set([
  'eml',
  'msg',
  'tsv',
  'log',
  'sql',
  'srt',
  'vtt',
  'ipynb',
  'svg',
  'usfm',
  'usx',
  'osis',
  'fb2',
  'mbox',
  'accdb',
  'mdb',
  'mpp',
  'ifc',
  'stp',
  'step',
  'stl',
  'mobi',
  'azw',
  'azw3',
  'djvu',
  'cbz',
  'cbr',
  'bmp',
]);

/** The cuts of a reader that read only the first part to save work (the
 *  plan, section 10: "shortcuts"), and pages left unread (a scan's pages,
 *  a book's pages still waiting for their read). Every cut not on this list
 *  is taken as a safety bound (a size, a cost or a model's limit, such as
 *  `text_store`, `legacy_cells`, `pictures`, `vision_answer`) or a digest's
 *  budget whose rows are all in the file's database (`cad_labels`,
 *  `cad_blocks`, `layer_list`): counted in `cuts` only. By the cut's reason
 *  (the key before a `:`). */
export const SHORTCUT_CUT_REASONS: ReadonlySet<string> = new Set([
  'ocr_pages',
  // A scanned drawing's pages its sketch read did not read (a cap, its
  // time, a call that did not run).
  'scan_pages',
  'page_pictures',
  'sheet_rows',
  'sheet_columns',
  'sheet_text',
  'database_size',
  'database_rows',
  'database_time',
  'markup_bytes',
  'agent_text',
  'cad_texts',
  'cad_layers',
  'cad_blocks_cap',
  'cad_geometry',
  'dwf_sheets',
  'dwf_scan',
  'dwf_labels',
]);

/** A skip that is no shortfall: the file has nothing to read. */
const EMPTY_SKIPS: ReadonlySet<string> = new Set(['body_too_short']);

/** How a type is read today. `none`: no reader, the default text. */
export type CoverageRoute =
  'text' | 'parser' | 'pipeline' | 'archive' | 'vision' | 'media' | 'export' | 'none';

export function routeOfExt(ext: string, dbExts: ReadonlySet<string>): CoverageRoute {
  const route = parserRouteForExt(ext);
  if (route === 'utf8') return 'text';
  if (route !== 'none') return 'parser';
  if (dbExts.has(ext)) return 'pipeline';
  // An archive is read as what it is, by design (docs/files.md "Archives"):
  // its name, type and entry names; a person extracts its contents.
  if (EXTRACTABLE_ARCHIVE_EXTS.includes(ext) || SEALED_ARCHIVE_EXTS.includes(ext)) return 'archive';
  if (MEDIA_EXTS.has(ext)) return 'media';
  if (EXPORT_REQUIRED_EXTS.has(ext)) return 'export';
  if (isVisionImage(ext, mimeForExt(ext))) return 'vision';
  return 'none';
}

/** One file, as the check reads it: its type, its read keys, its bytes'
 *  checksum. */
export type CoverageFile = { id: string; ext: string; data: Record<string, unknown> };

export type CoverageRow = {
  ext: string;
  route: CoverageRoute;
  popular: boolean;
  files: number;
  indexed: number;
  partial: number;
  failed: number;
  skipped: number;
  pending: number;
  nameOnly: number;
  /** null: the type has no file database to expect. */
  withDb: number | null;
  noDb: number;
  shortcut: number;
  notFull: number;
  /** Skips and failures by reason. */
  reasons: Record<string, number>;
  /** Files with each cut that makes a file partial, by reason. */
  cuts: Record<string, number>;
};

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** Whether a type's files are expected to have a file database: a Reader
 *  with a database takes the type, and takes every file of it (not the
 *  PDF, whose router sends only drawings and books to a Reader, and not
 *  the types a Reader takes only some files of). */
export function dbExpected(ext: string, dbExts: ReadonlySet<string>): boolean {
  return dbExts.has(ext) && ext !== 'pdf' && !SOME_FILES_EXTS.has(ext);
}

/** The counts by type, from the rows and the database names (`id.sha16`).
 *  Pure: the tests drive it with made-up rows. */
export function coverageOf(
  files: readonly CoverageFile[],
  dbExts: ReadonlySet<string>,
  named: ReadonlySet<string>,
): CoverageRow[] {
  const byExt = new Map<string, CoverageRow>();
  for (const f of files) {
    let row = byExt.get(f.ext);
    if (!row) {
      const expected = dbExpected(f.ext, dbExts);
      row = {
        ext: f.ext,
        route: routeOfExt(f.ext, dbExts),
        popular: POPULAR_EXTS.has(f.ext),
        files: 0,
        indexed: 0,
        partial: 0,
        failed: 0,
        skipped: 0,
        pending: 0,
        nameOnly: 0,
        withDb: expected ? 0 : null,
        noDb: 0,
        shortcut: 0,
        notFull: 0,
        reasons: {},
        cuts: {},
      };
      byExt.set(f.ext, row);
    }
    row.files += 1;
    const ex = extractionOf(f.data);
    let short = false;
    switch (ex.state) {
      case 'indexed':
        row.indexed += 1;
        break;
      case 'partial': {
        row.partial += 1;
        // The cuts that make it partial (a detail, such as small pictures
        // the size gate skipped, does not).
        const reasons = new Set(
          (ex.cuts ?? []).filter((c) => cutMakesPartial(c.key)).map((c) => readCutReason(c.key)),
        );
        for (const r of reasons) {
          bump(row.cuts, r);
          if (SHORTCUT_CUT_REASONS.has(r)) short = true;
        }
        break;
      }
      case 'failed':
        row.failed += 1;
        bump(row.reasons, ex.reason ?? 'failed');
        break;
      case 'skipped':
        row.skipped += 1;
        bump(row.reasons, ex.reason ?? 'skipped');
        break;
      case 'pending':
        row.pending += 1;
        break;
      case 'name_only':
        row.nameOnly += 1;
        break;
    }
    if (short) row.shortcut += 1;
    const read = ex.state === 'indexed' || ex.state === 'partial';
    let noDb = false;
    if (row.withDb !== null && read) {
      const sha = fileSha256Of(f);
      if (typeof sha === 'string' && named.has(`${f.id}.${sha.slice(0, 16)}`)) row.withDb += 1;
      else noDb = true;
    }
    if (noDb) row.noDb += 1;
    const lost =
      ex.state === 'failed' ||
      (ex.state === 'skipped' && !EMPTY_SKIPS.has(ex.reason ?? '')) ||
      (read && (row.route === 'none' || readByOf(f.data)?.reader === 'none')) ||
      short ||
      noDb;
    if (lost) row.notFull += 1;
  }
  return [...byExt.values()].sort((a, b) => b.files - a.files || a.ext.localeCompare(b.ext));
}

/** The keys of `data` the check reads, written out in the SQL: the read
 *  state's own (extractionOf, readCutsOfFile), the checksum, and the name
 *  and type of the file. Never its text. */
const slimData = () => sql<Record<string, unknown>>`jsonb_strip_nulls(jsonb_build_object(
  'filename', ${nodes.data}->'filename',
  'mimeType', ${nodes.data}->'mimeType',
  'sha256', ${nodes.data}->'sha256',
  'indexing_applied', ${nodes.data}->'indexing_applied',
  'extract_skipped', ${nodes.data}->'extract_skipped',
  'extract_parked', ${nodes.data}->'extract_parked',
  'extract_completed_at', ${nodes.data}->'extract_completed_at',
  'read_cut', ${nodes.data}->'read_cut',
  'ocr', ${nodes.data}->'ocr',
  'images', ${nodes.data}->'images'))`;

/**
 * Every live file of the brain, with the keys the check reads, and the file
 * database names: one read-only transaction, then the words of the `.none`
 * names of those files. `folder`: the listing the audit made once for its
 * file database lines too; made here when not given. Made before the rows,
 * so a row is never older than a name it is judged against.
 */
export async function fileCoverage(ownerId: string, given?: FileDbFolder): Promise<CoverageRow[]> {
  const folder = given ?? (await listFileDbFolder());
  const { rows, dbExts } = await readOnlyTransaction(async (tx) => {
    const box = await boxPipelines(ownerId, tx);
    const rows = await tx
      .select({ id: nodes.id, title: nodes.title, data: slimData() })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.type, 'file'),
          isNull(nodes.supersededBy),
          sql`coalesce(${nodes.data}->>'snapshot_of', '') = ''`,
        ),
      );
    return { rows, dbExts: box.dbExts };
  });
  const files = rows.map((r) => {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const name = typeof data.filename === 'string' ? data.filename : (r.title ?? '');
    const mime = typeof data.mimeType === 'string' ? data.mimeType : '';
    return { id: r.id, ext: typeOfName(name, mime, dbExts), data };
  });
  return coverageOf(files, dbExts, await databaseNames(folder, files));
}

/** The names (`id.sha16`) of the files that have a database. A `.none`
 *  name is a word, not a database: `no-rows` (read, nothing in it) and
 *  `too-large` (said by its own cut) count as one, `unreadable` (the parser
 *  refused it for good) does not. Its word is read for these files only. */
async function databaseNames(
  folder: FileDbFolder,
  files: readonly CoverageFile[],
): Promise<Set<string>> {
  const named = new Set(folder.names.map((n) => `${n.fileId}.${n.sha16}`));
  const words = new Set(
    folder.names.filter((n) => n.name.endsWith('.none')).map((n) => `${n.fileId}.${n.sha16}`),
  );
  for (const f of files) {
    const sha = fileSha256Of(f);
    if (typeof sha !== 'string') continue;
    const key = `${f.id}.${sha.slice(0, 16)}`;
    if (words.has(key) && (await readFileDbNone(f.id, sha)) === 'unreadable') named.delete(key);
  }
  return named;
}

/**
 * The type the check names for a file: its extension, or with none the
 * subtype of its media type (an email attachment titled "Scan" with type
 * application/pdf is a `pdf`). Named only when this brain knows it (on a
 * list, or read by some route); else `(other)`, or `(none)` with no
 * extension. Everything after a file name's last dot is its extension, and
 * "Letter to J.Smith" must not print "smith".
 */
export function typeOfName(name: string, mime: string, dbExts: ReadonlySet<string>): string {
  const ext = extOf(name);
  const type = ext || (mime.split(';')[0]!.trim().toLowerCase().split('/')[1] ?? '');
  if (type && (NAMED_TYPES.has(type) || routeOfExt(type, dbExts) !== 'none')) return type;
  return ext ? '(other)' : '(none)';
}

/** One line of a row, numbers only. */
export function coverageLine(r: CoverageRow): string {
  const parts = [
    `failed ${r.failed}`,
    `skipped ${r.skipped}`,
    r.route === 'none' ? 'no reader' : null,
    `shortcut cuts ${r.shortcut}`,
    r.withDb !== null ? `no database ${r.noDb}` : null,
  ].filter(Boolean);
  return `${r.notFull} of ${r.files} not full (${parts.join(', ')})`;
}

/** The audit line: the files of the popular types not read in full. */
export function coverageCheck(rows: readonly CoverageRow[]): AuditCheck {
  const scored = rows.filter((r) => r.popular && r.notFull > 0);
  scored.sort((a, b) => b.notFull - a.notFull || a.ext.localeCompare(b.ext));
  const count = scored.reduce((n, r) => n + r.notFull, 0);
  return {
    key: 'file_coverage',
    label: 'Files of popular types not read in full',
    severity: 'medium',
    note: 'A file of a popular type whose read failed, was skipped (an empty file is not counted), has no reader, holds a shortcut cut (a reader that read only the first part), or has no file database where its Reader makes one. A Reader that is off in the workspace of a file leaves it with no database on purpose: `pipeline_list` shows where. Numbers by type only. Every type, with its states and cuts: `pnpm -C server/web files:coverage`.',
    count,
    capped: false,
    ok: count === 0,
    samples: scored.slice(0, 5).map((r) => ({ id: r.ext, kind: 'type', detail: coverageLine(r) })),
    oldestAt: null,
    newestAt: null,
  };
}

export async function fileCoverageChecks(
  ownerId: string,
  folder?: FileDbFolder,
): Promise<AuditCheck[]> {
  return [coverageCheck(await fileCoverage(ownerId, folder))];
}
