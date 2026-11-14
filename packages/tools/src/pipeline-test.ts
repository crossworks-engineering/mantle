/**
 * Test one pipeline on one file (docs/pipelines.md, "Test on one file"):
 * the one function of POST /api/pipelines/:id/test and `pipeline_test`.
 * Nothing is written: no database, no row, no stamp, no word. The result is
 * in memory only, and gives the first rows of each tab.
 *
 *  - A reader: the file's bytes, read in the caller's scope, then
 *    parseFileSheets with no decider. So a PDF the rules leave unsure is
 *    `unsure`, and no model is asked (the rule of the re-read of phase 1:
 *    no caller without a decider starts a model call).
 *  - An `after` pipeline: the file's database at its own bytes, opened read
 *    only; the match rule on its real tabs; then its code. It never reads
 *    the file. A test reads no attach list: an Admin tests before the
 *    attach.
 *
 * `options` are checked by checkOptions, then used over the saved ones, so
 * an Admin tries a value before the save.
 *
 * The parser has one slot. A test waits for it as an interactive call (a
 * person is waiting) and gives `busy` when it does not get it. `busy` is no
 * failure, and a test counts no failure against the bytes: its parser
 * exchanges use a ledger that keeps nothing.
 *
 * No rights check here, by design: the route's policy and the tool's scope
 * (area `settings`) are the check, and the file row is read in the
 * caller's scope on both doors (the route enters the login's scope with
 * withViewer; the tool runs in it). Not a person-only act: it writes
 * nothing and asks no model.
 */
import { afterSheetsOf, parseFileSheets } from '@mantle/content/file-database';
import { pipelineStateOf } from '@mantle/content/pipeline-state';
import {
  AFTER_PIPELINES,
  BUILTIN_PIPELINES,
  afterMatches,
  checkOptions,
  effectiveOptions,
  fileDataExt,
  fileDataRefusal,
  fileDataRow,
  fileDbSqlitePath,
  fileSha256Of,
  isAfterPipeline,
  isParserError,
  pdfFileTabOf,
  readFileNodeBytes,
  shapesOf,
  withParserScope,
  type ParserFailureLedger,
  type PipelineManifest,
} from '@mantle/files';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { describeWorkbook, importMaxRows } from '@mantle/tabledb';
import type { PipelineTestResult } from '@mantle/client-types';
import { FILE_ID_PRE } from './builtins-common';
import type { BuiltinToolDef } from './types';

/** The rows of each tab a test gives. */
export const PIPELINE_TEST_FIRST_ROWS = 5;
/** A cell of those rows is cut here: a drawing's row can hold its SVG. */
export const PIPELINE_TEST_CELL_MAX = 200;
/** A tab name and a column name are cut here. */
export const PIPELINE_TEST_NAME_MAX = 100;
/** The most tabs a test gives. */
export const PIPELINE_TEST_TABS_MAX = 20;
/** The most columns of a tab a test gives, with their cells. */
export const PIPELINE_TEST_COLUMNS_MAX = 100;

/** A failure ledger that keeps nothing: a test counts no failure against
 *  the bytes, so it never changes what a later read of the file does. */
const NO_LEDGER: ParserFailureLedger = {
  get: () => Promise.resolve(null),
  add: () => Promise.resolve(0),
};

export type PipelineTestInput = { fileId: string; options?: unknown };

export type PipelineTestAnswer =
  | { ok: true; result: PipelineTestResult }
  | { ok: false; error: string; missing?: 'pipeline' | 'file' };

const cut = (v: unknown) =>
  typeof v === 'string' && v.length > PIPELINE_TEST_CELL_MAX
    ? v.slice(0, PIPELINE_TEST_CELL_MAX)
    : v;

/** The tabs a write would make of these sheets (the rule of tabsOfSheets:
 *  a sheet with no column or no row makes no tab), each with its first rows.
 *  The answer is bounded: at most PIPELINE_TEST_TABS_MAX tabs and
 *  PIPELINE_TEST_COLUMNS_MAX columns a tab, with one warning each when cut. */
function tabsOf(sheets: readonly ParsedSheet[]): {
  tabs: PipelineTestResult['tabs'];
  warnings: string[];
} {
  const all = sheets
    .map((sheet, i) => ({ sheet, name: sheet.name || `Sheet${i + 1}` }))
    .filter(({ sheet }) => sheet.columns.length > 0 && sheet.rows.length > 0);
  const warnings: string[] = [];
  if (all.length > PIPELINE_TEST_TABS_MAX) {
    warnings.push(`Only the first ${PIPELINE_TEST_TABS_MAX} of ${all.length} tabs are shown.`);
  }
  let wide = false;
  const tabs = all.slice(0, PIPELINE_TEST_TABS_MAX).map(({ sheet, name }) => {
    if (sheet.columns.length > PIPELINE_TEST_COLUMNS_MAX) wide = true;
    const columns = sheet.columns.slice(0, PIPELINE_TEST_COLUMNS_MAX);
    return {
      name: name.slice(0, PIPELINE_TEST_NAME_MAX),
      rows: sheet.rows.length,
      columns: columns.map((c) => c.name.slice(0, PIPELINE_TEST_NAME_MAX)),
      first: sheet.rows
        .slice(0, PIPELINE_TEST_FIRST_ROWS)
        .map((row) => row.slice(0, columns.length).map(cut)),
    };
  });
  if (wide) {
    warnings.push(`Only the first ${PIPELINE_TEST_COLUMNS_MAX} columns of a tab are shown.`);
  }
  return { tabs, warnings };
}

/** Whether a PDF drawing's sheets say the rules left its kind unsure. */
function pdfUnsure(sheets: readonly ParsedSheet[]): boolean {
  const file = sheets.find((s) => s.name === 'File');
  const row = file?.rows[0];
  if (!file || !row) return false;
  return (
    pdfFileTabOf(
      file.columns.map((c) => c.name),
      row,
    )?.kind === 'unsure'
  );
}

/**
 * Test pipeline `id` on file `fileId`, with `options` over the saved ones.
 * A refusal (no such pipeline, no such file in the caller's scope, a bad
 * option) is a plain sentence; anything else is a PipelineTestResult.
 */
export async function testPipeline(
  ownerId: string,
  id: string,
  input: PipelineTestInput,
): Promise<PipelineTestAnswer> {
  const p: PipelineManifest | undefined = BUILTIN_PIPELINES.find((x) => x.id === id);
  if (!p) {
    return {
      ok: false,
      error: `There is no pipeline "${id.slice(0, 40)}". Find the id with pipeline_list.`,
      missing: 'pipeline',
    };
  }
  let given: Record<string, unknown> = {};
  if (input.options !== undefined) {
    const checked = checkOptions(p, input.options);
    if (!checked.ok) return { ok: false, error: checked.error };
    given = checked.values;
  }
  const row = await fileDataRow(ownerId, input.fileId);
  if (!row) return { ok: false, error: 'There is no file with that id.', missing: 'file' };

  const t0 = Date.now();
  const result = (
    status: PipelineTestResult['status'],
    more: Partial<Pick<PipelineTestResult, 'tabs' | 'warnings' | 'word'>> = {},
  ): PipelineTestAnswer => {
    const tabs = more.tabs ?? [];
    return {
      ok: true,
      result: {
        status,
        pipeline: p.id,
        version: p.version,
        ms: Date.now() - t0,
        tabs,
        shapes: shapesOf(tabs),
        warnings: more.warnings ?? [],
        writes: tabs.length > 0 ? ['file_tabs_write'] : [],
        word: more.word ?? null,
      },
    };
  };

  const ext = fileDataExt(row);
  if (!p.match.ext.includes(ext)) return result('not_mine', { word: 'no-match' });
  // The refusal file_sql gives (fileDataRefusal, one of four: not a table
  // type, no checksum, an email attachment seen below Admin, a private
  // file): a real build skips the file, so the test reads nothing of it.
  const refused = await fileDataRefusal(ownerId, row);
  if (refused) return result('not_mine', { word: refused.code });
  const saved = p.options ? (await pipelineStateOf(ownerId, p)).options : {};
  const options = effectiveOptions(p, { ...saved, ...given });

  if (isAfterPipeline(p)) {
    const after = AFTER_PIPELINES.find((x) => x.id === p.id)!;
    const abs = await fileDbSqlitePath(row.id, fileSha256Of(row));
    if (!abs) return result('not_mine', { word: 'no-database' });
    const tabs = describeWorkbook(abs).map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => c.name),
    }));
    if (!afterMatches(after, ext, tabs)) return result('not_mine', { word: 'no-match' });
    const { sheets, warnings } = afterSheetsOf(after.id, abs, options);
    const shown = tabsOf(sheets);
    return result('ok', { tabs: shown.tabs, warnings: [...warnings, ...shown.warnings] });
  }

  const loaded = await readFileNodeBytes(row);
  if (!loaded) return result('failed', { word: 'unreadable' });
  let parsed: Awaited<ReturnType<typeof parseFileSheets>>;
  try {
    // No decider: a PDF the rules leave unsure asks no model.
    parsed = await withParserScope({ interactive: true, failures: NO_LEDGER }, () =>
      parseFileSheets(loaded.bytes, ext, p.options ? { options } : {}),
    );
  } catch (err) {
    if (isParserError(err) && err.code === 'busy') return result('busy');
    return result('failed', {
      warnings: [isParserError(err) ? `The parser answered ${err.code}.` : 'The read failed.'],
    });
  }
  if (parsed.kind === 'not-plan' || parsed.kind === 'not-drawing') return result('not_mine');
  if (parsed.kind === 'none') return result('failed', { word: parsed.word });
  const rows = parsed.sheets.reduce((n, s) => n + (s.columns.length > 0 ? s.rows.length : 0), 0);
  if (rows > importMaxRows()) return result('failed', { word: 'too-large' });
  const { tabs, warnings } = tabsOf(parsed.sheets);
  if (tabs.length === 0) return result('failed', { word: 'no-rows' });
  return result(p.id === 'drawing-pdf' && pdfUnsure(parsed.sheets) ? 'unsure' : 'ok', {
    tabs,
    warnings,
  });
}

export const pipeline_test: BuiltinToolDef = {
  slug: 'pipeline_test',
  // An Admin user's own client tests with it; no agent is granted it (no
  // tool group holds it in phase 2).
  mcpOnly: true,
  policy: {
    // The file is read in the caller's scope; a pipeline is no item.
    matrix: { action: 'read', param: 'file_id', kinds: ['file'] },
    effect: 'read',
    spends: 'none',
    // The route's area (POST /api/pipelines/:id/test). Not systemWhole: it
    // reads the file in the caller's scope, as pipeline_list reads in it.
    scope: { area: 'settings' },
    recipe: { step: 'forbidden' },
  },
  preconditions: FILE_ID_PRE,
  name: 'Test a pipeline',
  description:
    "Test one pipeline on one file and give the result: `status`, each tab with its row count, columns and first 5 rows, the shapes, warnings, and the calls it would make. **Nothing is written**: no database, no row, no stamp. `options` are tried in place of the saved ones, so a value can be tried before `pipeline_set` saves it. A reader reads the file's bytes with no model: a PDF the rules leave unsure gives `unsure`. An `after` pipeline reads the file's database. `busy`: the parser was busy, try again. For the pipelines and their ids use `pipeline_list`; for all the rows of a file use `file_sql`.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        enum: BUILTIN_PIPELINES.map((p) => p.id),
        description: "The pipeline's id, e.g. 'site-tags'.",
      },
      file_id: {
        type: 'string',
        format: 'uuid',
        description: 'The file to test it on, from `file_list` or `search`.',
      },
      options: {
        type: 'object',
        // The names are the pipeline's own: checkOptions refuses one it
        // does not declare.
        additionalProperties: true,
        description:
          'Option values to try in place of the saved ones, e.g. {"not_tags": ["NOTE"]}.',
      },
    },
    required: ['id', 'file_id'],
  },
  handler: async (input, ctx) => {
    const res = await testPipeline(ctx.ownerId, String(input.id ?? ''), {
      fileId: String(input.file_id ?? ''),
      options: input.options,
    });
    if (res.ok) return { ok: true, output: res.result };
    return {
      ok: false,
      error:
        res.missing === 'file'
          ? `There is no file "${String(input.file_id ?? '').slice(0, 40)}" you can read. Find its id with file_list.`
          : res.error,
    };
  },
};
