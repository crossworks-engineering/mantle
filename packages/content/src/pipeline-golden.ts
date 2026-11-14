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
import { readFileSync } from 'node:fs';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import type { ParsedFile } from './file-database';
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
