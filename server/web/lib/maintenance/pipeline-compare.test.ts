/**
 * The pure parts of `pipeline-compare` (./pipeline-compare.ts): a database's
 * tabs as the compare sees them, the kinds of difference, and the refusals
 * of the task before it reads anything. No Postgres; the databases are
 * scratch SQLite files written by the writer of a real build.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import { tabsOfSheets } from '@mantle/content/file-database';
import { writeFileDatabaseDoc } from '@mantle/content/table-broker';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { BAD_LIMIT } from './dwg-reindex';
import { differencesOf, runPipelineCompare, tabSumsOf } from './pipeline-compare';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pipeline-compare-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sheet = (rows: (string | number | null)[][], name = 'Lines'): ParsedSheet => ({
  name,
  columns: [
    { name: 'Tag', type: 'text' },
    { name: 'Size', type: 'number' },
  ],
  rows,
});

function dbOf(sheets: ParsedSheet[]): string {
  const abs = path.join(dir, `${randomUUID()}.sqlite`);
  writeFileDatabaseDoc(abs, ensureWorkbookDoc({ tabs: tabsOfSheets(sheets) }), {
    fileId: randomUUID(),
    ownerId: randomUUID(),
  });
  return abs;
}

describe('pipeline-compare', () => {
  it('the same sheets give equal sums; each change is its own kind', () => {
    const base = [
      sheet([
        ['P-101', 50],
        ['P-102', 80],
      ]),
    ];
    const a = tabSumsOf(dbOf(base));
    expect(a).toEqual([
      {
        name: 'Lines',
        columns: ['Tag', 'Size'],
        rows: 2,
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(differencesOf(a, tabSumsOf(dbOf(base)))).toEqual([]);
    expect(differencesOf(a, tabSumsOf(dbOf([sheet([['P-101', 50]])])))).toEqual(['rows']);
    expect(
      differencesOf(
        a,
        tabSumsOf(
          dbOf([
            sheet([
              ['P-101', 50],
              ['P-102', 81],
            ]),
          ]),
        ),
      ),
    ).toEqual(['hash']);
    expect(differencesOf(a, tabSumsOf(dbOf([sheet([['P-101', 50]], 'Other')])))).toEqual(['tabs']);
    const wider: ParsedSheet = {
      ...base[0]!,
      columns: [...base[0]!.columns, { name: 'Note', type: 'text' }],
      rows: [
        ['P-101', 50, null],
        ['P-102', 80, null],
      ],
    };
    expect(differencesOf(a, tabSumsOf(dbOf([wider])))).toEqual(['columns']);
  });

  it('refuses before it reads anything: no pipeline, a bad id, a bad limit', async () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    expect(await runPipelineCompare([], print)).toBe(2);
    expect(lines.pop()).toMatch(/--pipeline=<id> is needed/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--file=nope'], print)).toBe(2);
    expect(lines.pop()).toMatch(/not an id/);
    expect(await runPipelineCompare(['--pipeline=sheet', '--limit=0'], print)).toBe(2);
    expect(lines.pop()).toContain(BAD_LIMIT);
  });
});
