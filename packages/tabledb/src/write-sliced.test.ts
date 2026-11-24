/**
 * The sliced write of a file database (writeDocFileSliced): the same rows,
 * search index and indexes as the whole-file write, rows from an async
 * source, turns of the event loop while it writes, and the conditional
 * write's one check. Made-up data only.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Column, Row } from './doc-types';
import { writeDocFile, writeDocFileSliced } from './engine';
import { openTableFile } from './sqlite';
import { ConflictError } from '@mantle/std';

const dir = mkdtempSync(path.join(tmpdir(), 'write-sliced-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const columns: Column[] = [
  { id: 'c1', name: 'Tag', type: 'text' },
  { id: 'c2', name: 'Reading', type: 'number' },
  { id: 'c3', name: 'When', type: 'date' },
];
const rowAt = (i: number): Row => ({
  id: `r${String(i).padStart(8, '0')}`,
  cells: { c1: `P-${i}`, c2: i / 4, c3: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` },
});
const meta = { nodeId: 'n1', ownerId: 'o1', fts: true, deleteJournal: true };

function contentOf(abs: string) {
  const db = openTableFile(abs, { readOnly: true });
  try {
    const rows = db.prepare('SELECT _rid, _pos, * FROM t_t1 ORDER BY _pos').all();
    const hits = db
      .prepare(`SELECT count(*) AS n FROM t_t1_fts WHERE t_t1_fts MATCH '"P-12"'`)
      .get() as { n: number };
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 't_t1'`)
      .all()
      .map((r) => String(r.name))
      .sort();
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    return { rows, hits: hits.n, indexes, mode: mode.journal_mode };
  } finally {
    db.close();
  }
}

describe('writeDocFileSliced', () => {
  it('writes the file the whole-file write writes, from an async source, with turns of the loop', async () => {
    const N = 40_000;
    const whole = path.join(dir, 'whole.sqlite');
    writeDocFile(
      whole,
      {
        tabs: [{ name: 'Readings', columns, rows: Array.from({ length: N }, (_, i) => rowAt(i)) }],
      },
      meta,
    );
    async function* source() {
      for (let i = 0; i < N; i++) yield rowAt(i);
    }
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 1);
    const sliced = path.join(dir, 'sliced.sqlite');
    const res = await writeDocFileSliced(
      sliced,
      { tabs: [{ name: 'Readings', columns, rows: source() }] },
      meta,
    );
    clearInterval(timer);
    expect(res.stats.totalRows).toBe(N);
    expect(res.sizeBytes).toBe(statSync(sliced).size);
    expect(contentOf(sliced)).toEqual(contentOf(whole));
    expect(contentOf(sliced).mode).toBe('delete');
    // The write gave the loop turns: the timer ran while it wrote.
    expect(ticks).toBeGreaterThan(0);
  });

  it('refuses a conditional write when the file changed, and leaves no build file', async () => {
    const abs = path.join(dir, 'since.sqlite');
    writeDocFile(abs, { tabs: [{ name: 'A', columns, rows: [rowAt(1)] }] }, meta);
    await expect(
      writeDocFileSliced(
        abs,
        { tabs: [{ name: 'A', columns, rows: [rowAt(2)] }] },
        {
          ...meta,
          since: null,
        },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(contentOf(abs).rows).toHaveLength(1);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('.build-'))).toEqual([]);
  });

  it('a source that throws leaves the old file and no build file', async () => {
    const abs = path.join(dir, 'throws.sqlite');
    writeDocFile(abs, { tabs: [{ name: 'A', columns, rows: [rowAt(1)] }] }, meta);
    async function* broken() {
      yield rowAt(1);
      throw new Error('a broken line');
    }
    await expect(
      writeDocFileSliced(abs, { tabs: [{ name: 'A', columns, rows: broken() }] }, meta),
    ).rejects.toThrow('a broken line');
    expect(contentOf(abs).rows).toHaveLength(1);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('.build-'))).toEqual([]);
  });
});
