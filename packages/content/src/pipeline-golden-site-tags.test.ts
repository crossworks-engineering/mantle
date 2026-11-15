/**
 * The golden compare of the move of `site-tags` (docs/pipelines.md, "The
 * same-result proof of a move"). The golden files in
 * packages/files/src/pipelines/pkg/site-tags/golden/ were written by the OLD
 * path (the adapter in file-database.ts, in the brain's process) before the
 * move, in their own commit, for each made-up database of fixtures/ with
 * the defaults and with the one set of options of fixtures/options.json.
 * Here afterSheetsOf, the one core function every caller runs, reads the
 * same database; the parser is faked at the fetch by the real step run in
 * this process (pipelineRunAnswer). It must give the same rows, the same
 * warnings and the same entry of `pipelines_after`. A golden file is never
 * changed to make this pass. The case through a real parser job is in
 * ./pipeline-runner.test.ts.
 *
 * Two edges, stated:
 *  - No Texts tab (no-texts) and a Texts tab with no row (empty-texts): the
 *    old read gave a `Site tags` tab with no rows; now the core sees there
 *    is no work, asks no parser job and gives no tab. No writer keeps a tab
 *    with no rows (tabsOfSheets, and the Test's tabsOf), so what is written
 *    and shown is the same: nothing. No reader writes a Texts tab with no
 *    row; the fixture database keeps it (writeFixtureDatabase), so the
 *    core's line for it runs here.
 *  - A tab past the row cap (500,000) whose step stops early at its own cap
 *    (100,000 tags, or 16,000,000 characters) would now get both warnings,
 *    where the old read, which stopped the scan, gave only the step's. No
 *    reader writes a Texts tab that long (a PDF at most 300,000 words, a CAD
 *    drawing 20,000 texts), and a warning is no row and no stamp. The large
 *    fixture passes the row cap with few tags, so it has the one warning.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PIPELINES,
  effectiveOptions,
  optionsHash,
  resetParserFailures,
  withAfterEntry,
} from '@mantle/files';
import { pipelineRunAnswer } from '@mantle/files/pipelines/test-job';
import { describeWorkbook } from '@mantle/tabledb';
import { afterSheetsOf } from './file-database';
import { afterGoldenOf, writeFixtureDatabase } from './pipeline-golden';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..', '..', 'files', 'src', 'pipelines', 'pkg', 'site-tags');
const SITE = BUILTIN_PIPELINES.find((p) => p.id === 'site-tags')!;
const OPTIONS = (
  JSON.parse(readFileSync(path.join(PKG, 'fixtures', 'options.json'), 'utf8')) as {
    options: Record<string, unknown>;
  }
).options;
const FIXTURES = readdirSync(path.join(PKG, 'fixtures'))
  .filter((n) => n.endsWith('.json') && n !== 'options.json')
  .map((n) => n.replace(/\.json$/, ''))
  .sort();
const NO_WORK = new Set(['no-texts', 'empty-texts']);
const dir = mkdtempSync(path.join(os.tmpdir(), 'site-tags-golden-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const golden = (name: string, set: string) =>
  JSON.parse(readFileSync(path.join(PKG, 'golden', `${name}.${set}.json`), 'utf8')) as {
    tabs: { sheets?: { rows: unknown[] }[] };
    warnings: string[];
  };

let jobs: string[] = [];
beforeEach(() => {
  jobs = [];
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      jobs.push(new URL(String(url)).pathname);
      return pipelineRunAnswer(init);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

const databases = new Map<string, string>();
function databaseOf(name: string): string {
  let abs = databases.get(name);
  if (!abs) {
    abs = path.join(dir, `${name}.sqlite`);
    writeFixtureDatabase(path.join(PKG, 'fixtures', `${name}.json`), abs);
    databases.set(name, abs);
  }
  return abs;
}

describe('site-tags: the package gives what the old path gave', () => {
  it('the fixed set is the nine made-up databases', () => {
    expect(FIXTURES).toEqual([
      'cad-unit',
      'chars-cap',
      'empty-texts',
      'large',
      'long-cell',
      'no-texts',
      'odd-values',
      'pdf-pid',
      'tags-cap',
    ]);
    expect(SITE).toMatchObject({ id: 'site-tags', runtime: 'bun', entry: 'step.ts' });
  });

  for (const name of FIXTURES.filter((n) => !NO_WORK.has(n))) {
    for (const [set, given] of [
      ['defaults', {}],
      ['options', OPTIONS],
    ] as const) {
      it(`${name}, ${set}: the same rows, warnings and pipelines_after entry, by one job`, async () => {
        const options = effectiveOptions(SITE, given);
        const run = await afterSheetsOf(SITE, databaseOf(name), options);
        const entry = withAfterEntry(undefined, SITE, optionsHash(SITE, options));
        expect(JSON.parse(afterGoldenOf(run, entry))).toEqual(golden(name, set));
        expect(jobs).toEqual(['/pipeline/run']);
      }, 120_000);
    }
  }

  for (const name of NO_WORK) {
    it(`${name}: the old empty tab, and now no job and no tab, which no writer keeps either way`, async () => {
      for (const [set, given] of [
        ['defaults', {}],
        ['options', OPTIONS],
      ] as const) {
        const want = golden(name, set);
        expect(want.tabs.sheets?.map((s) => s.rows.length)).toEqual([0]);
        expect(want.warnings).toEqual([]);
        const run = await afterSheetsOf(SITE, databaseOf(name), effectiveOptions(SITE, given));
        expect(run).toEqual({ sheets: [], warnings: [] });
      }
      expect(jobs).toEqual([]);
    });
  }

  it('empty-texts holds a Texts tab with no row; no-texts holds none', () => {
    const texts = (name: string) =>
      describeWorkbook(databaseOf(name)).filter((t) => t.name === 'Texts').length;
    expect([texts('empty-texts'), texts('no-texts')]).toEqual([1, 0]);
  });

  it('the options change the rows: the one set is not the defaults', () => {
    for (const name of ['cad-unit', 'pdf-pid', 'long-cell']) {
      expect(golden(name, 'options')).not.toEqual(golden(name, 'defaults'));
    }
  });
});
