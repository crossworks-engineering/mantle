/**
 * The golden files of a move (docs/pipelines.md, "The same-result proof").
 * Before a reader moves to a package, a script runs the old path on the
 * fixed set (`pkg/<id>/fixtures/`) and writes, for each file, the
 * ParsedFile it gave, with goldenOf, into `pkg/<id>/golden/<fixture>.json`.
 * After the move, the compare test runs the step in its own process
 * (inProcessStepJob, @mantle/files/pipelines/test-job), maps the result as
 * readSheets does (parsedFileOfRun, ./file-database.ts), and asks goldenOf
 * again. The two texts must be the same. A golden file is never changed to
 * make a test pass: a real difference goes to the integrator.
 *
 * The form: canonical JSON (keys sorted, two spaces, a newline at the end).
 * A ParsedFile whose JSON is over GOLDEN_INLINE_MAX_BYTES is stored as its
 * sha256 and its counts: the kind, the description, and for each tab its
 * name, columns and row count.
 *
 * An `after` pipeline reads a database, not a file: its fixtures are
 * made-up databases as JSON (fixtureSheets), written as a build writes
 * one (writeFixtureDatabase), and its golden text adds the warnings and
 * the stamp entry (afterGoldenOf).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { isParserError, parseDocumentBytes } from '@mantle/files';
import { cadTableWorkbook, dgnReading, dwgReading, symbolsReading } from '@mantle/files/dwg';
import { extractEmbeddedImages } from '@mantle/files/embedded-images';
import type { CadExt } from '@mantle/files/slug';
import { parseFileSheets, type ParsedFile } from './file-database';
import { writeFileDatabaseDoc } from './table-broker';

/** A ParsedFile larger than this as JSON is stored as its hash and counts. */
export const GOLDEN_INLINE_MAX_BYTES = 256 * 1024;

/** JSON with the keys of every object sorted, so the same value is the same
 *  text. `undefined` keys are left out, as JSON does. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** The golden text of one ParsedFile. The hash of the options in force
 *  (`optionsHash`) is left out: readSheets adds it after the reader for the
 *  stamp, so the old path's read has it and a step run in its own process
 *  does not. The golden file is of the reader's rows; the compare test checks
 *  the options through the stamp (pipelineStampOf with the hash). */
export function goldenOf(parsed: ParsedFile): string {
  const { optionsHash: _stamp, ...rows } = parsed as ParsedFile & { optionsHash?: string };
  const whole = canonicalJson(rows);
  if (Buffer.byteLength(whole, 'utf8') <= GOLDEN_INLINE_MAX_BYTES) return whole;
  return canonicalJson({
    sha256: createHash('sha256').update(whole).digest('hex'),
    kind: parsed.kind,
    ...(parsed.kind === 'sheets'
      ? {
          description: parsed.description,
          tabs: parsed.sheets.map((s) => ({
            name: s.name,
            columns: s.columns.map((c) => `${c.name}:${c.type}`),
            rows: s.rows.length,
          })),
        }
      : {}),
  });
}

/** One tab of a made-up database fixture of an `after` pipeline. With
 *  `repeat`, the rows are a template written `repeat` times, and `{i}` in
 *  a text is the copy's number: a large tab stays a short file. */
type FixtureTab = ParsedSheet & { repeat?: number };

/** The tabs of a fixture file (`pkg/<id>/fixtures/<name>.json`, a made-up
 *  database: `{ note, tabs }`), the repeats written out. */
export function fixtureSheets(file: string): ParsedSheet[] {
  const { tabs } = JSON.parse(readFileSync(file, 'utf8')) as { tabs: FixtureTab[] };
  return tabs.map(({ repeat, ...sheet }) => {
    if (repeat === undefined) return sheet;
    const rows: ParsedSheet['rows'] = [];
    for (let i = 0; i < repeat; i += 1) {
      for (const row of sheet.rows) {
        rows.push(row.map((c) => (typeof c === 'string' ? c.replaceAll('{i}', String(i)) : c)));
      }
    }
    return { ...sheet, rows };
  });
}

/** Write a fixture file as a file's database at `abs`, as a reader's build
 *  writes one (the input of an `after` pipeline), but a tab with no rows is
 *  kept: no reader writes one (tabsOfSheets drops it), and a fixture may
 *  hold one to run the core's "a needed tab with no row" line. */
export function writeFixtureDatabase(file: string, abs: string): void {
  const tabs = fixtureSheets(file).map((sheet) => ({
    ...tableDocFromGrid(sheet),
    name: sheet.name,
  }));
  writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs }), {
    fileId: '00000000-0000-4000-8000-000000000001',
    ownerId: '00000000-0000-4000-8000-000000000002',
  });
}

/** The golden text of one run of an `after` pipeline: its tabs as goldenOf
 *  gives them (inline, or the hash and counts of a large one), its
 *  warnings, and its entry in the stamp key `pipelines_after`. */
export function afterGoldenOf(
  run: { sheets: ParsedSheet[]; warnings: readonly string[] },
  pipelinesAfter: string,
): string {
  return canonicalJson({
    tabs: JSON.parse(goldenOf({ kind: 'sheets', sheets: run.sheets })) as unknown,
    warnings: run.warnings,
    pipelines_after: pipelinesAfter,
  });
}

const cadFailureOf = (e: unknown) => {
  if (!isParserError(e)) throw e;
  return { throws: { code: e.code, retryable: e.retryable } };
};
const settle = async <T>(f: () => Promise<T>) => {
  try {
    return await f();
  } catch (e) {
    return cadFailureOf(e);
  }
};

/**
 * Every pass of a drawing (the package `drawing-cad`), as the recorder of
 * its golden files ran them on the old path, in that order: the database,
 * the text, the picture with its provenance, the readings of dwg-reindex,
 * then the Table workbook. A typed parser failure is its code. `count`
 * gives the jobs so far: `jobs` is the count before the Table's run.
 */
export async function cadGoldenPasses(bytes: Buffer, ext: CadExt, count: () => number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(goldenOf(await parseFileSheets(bytes, ext)));
  } catch (e) {
    parsed = cadFailureOf(e);
  }
  const text = await settle(async () => {
    const t = await parseDocumentBytes(bytes, ext);
    return { sha256: createHash('sha256').update(t).digest('hex'), length: t.length };
  });
  const pictures = await settle(async () =>
    (await extractEmbeddedImages(bytes, ext)).images.map((i) => ({
      provenance: i.provenance,
      sha256: createHash('sha256').update(i.bytes).digest('hex'),
      bytes: i.bytes.length,
      ext: i.ext,
      width: i.width ?? null,
      height: i.height ?? null,
      altText: i.altText ?? null,
      essential: i.essential === true,
      ordinal: i.ordinal,
    })),
  );
  const readings = {
    dgn: await settle(() => dgnReading(bytes)),
    dwg: await settle(() => dwgReading(bytes)),
    symbols: await settle(() => symbolsReading(bytes, ext)),
  };
  const jobs = count();
  const table = await settle(async () => {
    const t = await cadTableWorkbook(bytes, ext);
    return JSON.parse(
      goldenOf({
        kind: 'sheets',
        sheets: t.sheets,
        ...(t.description ? { description: t.description } : {}),
      }),
    ) as unknown;
  });
  return { parsed, text, pictures: { pictures }, readings, table, jobs };
}

/** The fixed set of `drawing-cad`: the made-up files of its package folder,
 *  and the CAD tier's two test drawings read in place (a public sample DWG
 *  and a made-up DGN, with their licences there), with their golden files
 *  and the CAD tier's recorded reply to each. */
const CAD_PKG = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'files',
  'src',
  'pipelines',
  'pkg',
  'drawing-cad',
);
const CAD_TIER_DATA = path.join(
  CAD_PKG,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'server',
  'parser',
  'cad',
  'tests',
  'data',
);
const CAD_FIXTURES: Record<string, string> = {
  ...Object.fromEntries(
    readdirSync(path.join(CAD_PKG, 'fixtures'))
      .filter((n) => /\.(dwg|dxf|dgn)$/.test(n))
      .map((n) => [n, path.join(CAD_PKG, 'fixtures', n)]),
  ),
  'constructed_tags.dgn': path.join(CAD_TIER_DATA, 'constructed_tags.dgn'),
  'sample_AC1032.dwg': path.join(CAD_TIER_DATA, 'sample_AC1032.dwg'),
};
/** Not their extension's format (the sniff): no job on any pass. */
const CAD_NOT_CAD = ['not-cad.dwg', 'not-cad.dxf', 'office.dgn'];
export const CAD_GOLDEN = {
  names: Object.keys(CAD_FIXTURES).sort(),
  bytesOf: (name: string) => readFileSync(CAD_FIXTURES[name]!),
  extOf: (name: string) => name.slice(name.lastIndexOf('.') + 1) as CadExt,
  golden: (file: string) =>
    JSON.parse(readFileSync(path.join(CAD_PKG, 'golden', file), 'utf8')) as unknown,
  replyOf: (name: string) =>
    JSON.parse(
      gunzipSync(
        readFileSync(path.join(CAD_PKG, 'fixtures', 'replies', `${name}.reply.json.gz`)),
      ).toString('utf8'),
    ) as Record<string, unknown>,
  /**
   * The picture to compare with the golden file. The CAD tier renders the
   * sample DWG to other PNG bytes on every run, on the old path too (three
   * renders by the old image, three hashes; its registry is the same each
   * time), so for that one drawing the picture is its provenance and its
   * form, not its bytes. Every other render is the same picture each time.
   */
  pictureOf: (name: string, got: unknown) =>
    name === 'sample_AC1032.dwg'
      ? JSON.parse(
          JSON.stringify(got, (k, v: unknown) => (k === 'sha256' || k === 'bytes' ? undefined : v)),
        )
      : got,
  /** The jobs of the passes before the Table's: one heavy job a drawing,
   *  none for bytes that are not one; the damaged DWG fails on every pass
   *  (outside an extract's scope each asks again, as before). */
  jobsOf: (name: string) => (CAD_NOT_CAD.includes(name) ? 0 : name === 'damaged.dwg' ? 5 : 1),
};
