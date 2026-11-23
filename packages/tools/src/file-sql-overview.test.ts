/**
 * file_sql with no `sql` on a real file database (no Postgres): the made-up
 * piping specification (@mantle/files/pipelines/links-fixture), its Links
 * tabs from the real step of the `links` Transformer, and made-up table
 * tabs so that it has many tabs. The answer is the tool's own describe.
 *  - many tabs: the overview, the count, the pointer to Tables, no entry
 *    for a listed tab, and every statement of the answer runs through the
 *    read-only runner and gives rows;
 *  - few tabs, or no Tables index: no overview (the answer as before);
 *  - no Links tabs: no link help;
 *  - the answer of the fixture stays under a size bound.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureWorkbookDoc, tableDocFromGrid } from '@mantle/content-core/table-model';
import { SHAPES } from '@mantle/files';
import { bodyOf, specSheets } from '@mantle/files/pipelines/links-fixture';
import { PIPELINE_PACKAGES } from '@mantle/files/pipelines/pkg';
import type { StepJob } from '@mantle/files/pipelines/contract';
import { runTableSql } from '@mantle/tabledb';
import { writeDocFile } from '@mantle/tabledb/write';
import { fileSqlDescribe } from './builtins-file-sql';
import { FILE_SQL_TABS_MAX, fileSqlOverview } from './file-sql-overview';

type ParsedSheet = ReturnType<typeof specSheets>[number];

const dir = mkdtempSync(path.join(tmpdir(), 'file-sql-overview-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SHAPE_TABS = Object.fromEntries(SHAPES['pages-v1'].tabs.map((t) => [t.name, t.columns]));
/** The answer of the fixture stays under this many characters (the real
 *  book of 2,441 tabs: under 6,000). */
const ANSWER_MAX_CHARS = 6_000;

/** The fixture's sheets with `extra` more table tabs, each listed in Tables. */
function sheetsWith(extra: number): ParsedSheet[] {
  const sheets = specSheets();
  const tables = sheets.find((s) => s.name === 'Tables')!;
  for (let i = 1; i <= extra; i++) {
    const name = `Extra table ${i} p10`;
    tables.rows.push([name, null, '10', 1]);
    sheets.push({
      name,
      columns: [
        { name: 'Page', type: 'number' },
        { name: 'Size', type: 'text' },
      ],
      rows: [[10, `${i}"`]],
    });
  }
  return sheets;
}

/** The two tabs of the links step on these sheets. */
async function linkSheets(sheets: ParsedSheet[]) {
  const { step } = await PIPELINE_PACKAGES.links!();
  const job = { bytes: async () => Buffer.from(bodyOf(sheets, SHAPE_TABS)) } as unknown as StepJob;
  const out = await step({ api: 1, step: 1, options: {} }, job);
  const input = (out.calls![0] as { input: { tabs: ParsedSheet[]; ftsSkipColumns: string[] } })
    .input;
  return input;
}

let n = 0;
/** A file database of these sheets, as the build writes one. */
async function fileDb(sheets: ParsedSheet[], links: boolean): Promise<string> {
  const abs = path.join(dir, `f${++n}.sqlite`);
  const more = links ? await linkSheets(sheets) : { tabs: [], ftsSkipColumns: [] };
  const tabs = [...sheets, ...more.tabs].map((s) => ({ ...tableDocFromGrid(s), name: s.name }));
  writeDocFile(abs, ensureWorkbookDoc({ tabs }), {
    nodeId: `file-${n}`,
    ownerId: 'owner-1',
    fts: true,
    deleteJournal: true,
    ftsSkipColumns: more.ftsSkipColumns,
    extraMeta: { description: 'A made-up piping specification.' },
  });
  return abs;
}

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  path: 'files.x',
  title: 'spec.pdf',
  data: {},
};
const describeOf = async (abs: string) => {
  const got = await fileSqlDescribe(row, abs, undefined);
  if (got.kind !== 'describe') throw new Error(`expected describe, got ${got.kind}`);
  return got.output;
};
const rowsOf = async (abs: string, sql: string) => (await runTableSql(abs, sql)).rows;

describe('file_sql with no sql, the overview', () => {
  const extra = FILE_SQL_TABS_MAX;
  const listedNames = sheetsWith(extra)
    .find((s) => s.name === 'Tables')!
    .rows.map((r) => String(r[0]));

  it('many tabs: the tabs Tables does not list, the count, the pointer, no listed tab', async () => {
    const abs = await fileDb(sheetsWith(extra), true);
    const out = await describeOf(abs);
    expect(Object.keys(out)).toEqual([
      'file_id',
      'title',
      'description',
      'tabs',
      'listed',
      'links',
      'hint',
    ]);
    expect(out.tabs.map((t) => t.name)).toEqual(['Pages', 'Tables', 'File', 'Links', 'Link nodes']);
    expect(out.tabs.some((t) => listedNames.includes(t.name))).toBe(false);
    const count = listedNames.length;
    expect(out.listed).toMatchObject({ count, in: 'Tables' });
    expect(out.listed!.how).toContain(`${count} more tabs are not described here`);
    expect(out.listed!.how).toContain('"Tables"');
    // Its statements run and give rows.
    expect(await rowsOf(abs, out.listed!.find!)).not.toHaveLength(0);
    expect(await rowsOf(abs, out.listed!.columns)).toHaveLength(1);
    expect(out.description).toBe('A made-up piping specification.');
  });

  it('the link help: kinds, coverage, the patterns, and each pattern gives rows', async () => {
    const abs = await fileDb(sheetsWith(extra), true);
    const links = (await describeOf(abs)).links!;
    expect(links.about).toMatch(/^Links holds the links/);
    expect(links.link_kinds).toMatchObject({ HAS_PAGE: 10, CLASS_ROW: expect.any(Number) });
    expect(links.node_kinds).toMatchObject({ page: 10, coverage: expect.any(Number) });
    // The coverage lines but the two the help says itself.
    expect(links.coverage).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^1 of 10 pages have no text/),
        expect.stringMatching(/^Rule pack .*: on/),
      ]),
    );
    expect(links.coverage.some((c) => /^Links holds|: \d+ links$/.test(c))).toBe(false);
    expect(links.sql.map((s) => s.for)).toEqual([
      expect.stringMatching(/^nodes by words/),
      expect.stringMatching(/links to, and what links to it$/),
      expect.stringMatching(/^two links: the rows of /),
      expect.stringMatching(/^a row node to its row: row:/),
    ]);
    for (const s of links.sql) expect(await rowsOf(abs, s.sql), s.sql).not.toHaveLength(0);
    // The row of the last pattern is the row its node names.
    const rowId = /(row:\S.*#\d+) is row/.exec(links.sql[3]!.for)![1]!;
    const [nodeText] = (
      await rowsOf(abs, `SELECT text FROM "Link nodes" WHERE id = '${rowId.replaceAll("'", "''")}'`)
    )[0]!;
    const cells = (await runTableSql(abs, links.sql[3]!.sql)).rows[0]!.slice(3);
    expect(
      cells
        .filter((c) => c !== null)
        .map(String)
        .join(' | '),
    ).toBe(nodeText);
    expect(links.materials).toMatch(/specification number only/);
  });

  it('many tabs and no Links tabs: no link help', async () => {
    const out = await describeOf(await fileDb(sheetsWith(extra), false));
    expect(out.listed?.count).toBe(listedNames.length);
    expect(out).not.toHaveProperty('links');
  });

  it('few tabs: no overview, the answer as before', async () => {
    const abs = await fileDb(sheetsWith(0), true);
    expect(fileSqlOverview(abs)).toBeNull();
    const out = await describeOf(abs);
    expect(out).not.toHaveProperty('listed');
    expect(out).not.toHaveProperty('links');
    expect(out.tabs).toHaveLength(specSheets().length + 2);
  });

  it('many tabs and no Tables index: no overview', async () => {
    const sheets = sheetsWith(extra).filter((s) => s.name !== 'Tables');
    expect(fileSqlOverview(await fileDb(sheets, false))).toBeNull();
  });

  it(`the answer of the fixture stays under ${ANSWER_MAX_CHARS} characters`, async () => {
    const out = await describeOf(await fileDb(sheetsWith(extra), true));
    expect(JSON.stringify(out).length).toBeLessThan(ANSWER_MAX_CHARS);
  });
});
