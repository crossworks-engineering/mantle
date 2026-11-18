/**
 * Page windows (docs/pipelines.md, "Page windows", P1): the windowed run of
 * a Reader, with the parser's two jobs made up here (the split and the
 * step), so the core's part is pinned on its own: every page is in exactly
 * one window, in order; each request names its window's pages of the
 * ORIGINAL file; the state goes from one window to the next; the writes
 * merge by tab and column; the pictures of two windows keep their own
 * names; a window that cannot be cut or read is counted, never silently
 * lost, and the run goes on; a busy parser fails the run. The real qpdf cut
 * is pinned in server/parser/src/pdf-split.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '@mantle/files';

const split = vi.fn();
const step = vi.fn();
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  parserPdfSplit: (...a: unknown[]) => split(...a),
  parserPipelineRun: (...a: unknown[]) => step(...a),
}));

const { ParserError } = await import('@mantle/files');
const { mergeWindowWrite, pagesReadOf, runWindowed } = await import('./pipeline-runner');

const TOTAL = 120;
const WINDOW = { pages: 50, mb: 50 };
const BOOK = {
  id: 'made-up-book',
  name: 'Made-up book',
  description: 'Reads a made-up book.',
  version: '1.0.0',
  api: 1,
  runtime: 'bun',
  entry: 'step.ts',
  start: 'upload',
  match: { ext: ['pdf'], kind: ['book'] },
  produces: { text: true, pages: true },
  needs: { weight: 'heavy', window: WINDOW },
} as const;
const FILE = { name: 'file.pdf', ext: 'pdf', size: 10, sha256: 'a'.repeat(64) };

/** The made-up split: 50 pages a window, the bytes naming the window. */
function cutBy(fail: (from: number) => Error | null = () => null) {
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const err = fail(o.from);
    if (err) throw err;
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return { bytes: Buffer.from(`w${o.from}`), pageFrom: o.from, pageTo, pagesTotal: TOTAL };
  });
}

/** The made-up Reader: one Pages row a page of its window, the pages of
 *  the ORIGINAL file, a picture, and the count of windows in its state. */
function readByWindow(fail: (from: number) => Error | null = () => null) {
  step.mockImplementation(async (body: Buffer, _p: unknown, req: Record<string, unknown>) => {
    const from = req.pageFrom as number;
    const to = req.pageTo as number;
    expect(body.toString()).toBe(`w${from}`);
    const err = fail(from);
    if (err) throw err;
    const rows: (string | number)[][] = [];
    for (let p = from; p <= to; p++) rows.push([p, `page ${p} of ${req.pagesTotal}`]);
    const seen = ((req.state as { windows?: number } | undefined)?.windows ?? 0) + 1;
    return {
      result: {
        status: 'ok',
        state: { windows: seen },
        calls: [
          {
            call: 'tool',
            tool: 'file_tabs_write',
            input: {
              tabs: [
                {
                  name: 'Pages',
                  columns: [
                    { name: 'Page', type: 'number' },
                    { name: 'Text', type: 'text' },
                  ],
                  rows,
                },
              ],
              text: `## Page ${from}\nwindow ${seen}`,
              pictures: [{ file: 'p1.png', mime: 'image/png' }],
              description: `window ${seen}`,
            },
          },
        ],
      },
      pictures: new Map([['p1.png', Buffer.from(`pic${from}`)]]),
    };
  });
}

beforeEach(() => {
  split.mockReset();
  step.mockReset();
});

describe('runWindowed', () => {
  it('reads every page once, in order, each request naming its pages of the original file', async () => {
    cutBy();
    readByWindow();
    const run = await runWindowed(BOOK as never, Buffer.from('book'), FILE, {
      options: {},
      kind: 'book',
      state: { core: true },
    });
    expect(split.mock.calls.map((c) => c[1].from)).toEqual([1, 51, 101]);
    const reqs = step.mock.calls.map((c) => c[2] as Record<string, unknown>);
    expect(reqs.map((r) => [r.pageFrom, r.pageTo, r.pagesTotal])).toEqual([
      [1, 50, 120],
      [51, 100, 120],
      [101, 120, 120],
    ]);
    // The original file, and the kind, in every request.
    expect(reqs.every((r) => (r.file as { sha256: string }).sha256 === FILE.sha256)).toBe(true);
    expect(reqs.every((r) => r.kind === 'book')).toBe(true);
    // State: the core's for window 1, then the window before's.
    expect(reqs.map((r) => r.state)).toEqual([{ core: true }, { windows: 1 }, { windows: 2 }]);
    const pages = run.write!.tabs.find((t) => t.name === 'Pages')!.rows.map((r) => r[0]);
    expect(pages).toEqual(Array.from({ length: TOTAL }, (_, i) => i + 1));
    expect(run.write!.text).toBe(
      '## Page 1\nwindow 1\n\n## Page 51\nwindow 2\n\n## Page 101\nwindow 3',
    );
    expect(run.write!.description).toBe('window 3');
    expect(run.write!.pictures!.map((p) => p.file)).toEqual([
      'w1-p1.png',
      'w51-p1.png',
      'w101-p1.png',
    ]);
    expect(run.pictures.get('w51-p1.png')!.toString()).toBe('pic51');
    expect(run.windows).toEqual({ pagesTotal: TOTAL, failed: [] });
    expect(pagesReadOf(run.windows!)).toBe(TOTAL);
  });

  it('counts a window it cannot read or cut, and goes on with the next from the last state', async () => {
    cutBy((from) =>
      from === 101
        ? new ParserError('failed', 'bad xref', { retryable: false, terminal: false })
        : null,
    );
    readByWindow((from) =>
      from === 51 ? new ParserError('timeout', 'slow', { retryable: false, terminal: true }) : null,
    );
    const run = await runWindowed(BOOK as never, Buffer.from('book'), FILE, { options: {} });
    expect(run.status).toBe('ok');
    expect(run.windows!.failed).toEqual([
      { from: 51, to: 100 },
      { from: 101, to: 120 },
    ]);
    expect(pagesReadOf(run.windows!)).toBe(50);
    expect(run.warnings).toEqual([
      'Pages 51 to 100 could not be read.',
      'Pages 101 to 120 could not be cut from the file.',
    ]);
    const pages = run.write!.tabs[0]!.rows.map((r) => r[0]);
    expect(pages).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('a busy parser fails the run (the extract tries again), and no first window is no run', async () => {
    cutBy();
    readByWindow((from) =>
      from === 51 ? new ParserError('busy', 'busy', { retryable: true, terminal: false }) : null,
    );
    await expect(
      runWindowed(BOOK as never, Buffer.from('b'), FILE, { options: {} }),
    ).rejects.toThrow('busy');
    split.mockReset();
    split.mockRejectedValue(
      new ParserError('failed', 'not a PDF', { retryable: false, terminal: false }),
    );
    await expect(
      runWindowed(BOOK as never, Buffer.from('b'), FILE, { options: {} }),
    ).rejects.toThrow('not a PDF');
  });

  it('not_mine on window 1 is the answer, and reads no further', async () => {
    cutBy();
    step.mockResolvedValue({ result: { status: 'not_mine' }, pictures: new Map() });
    const run = await runWindowed(BOOK as never, Buffer.from('b'), FILE, { options: {} });
    expect(run.status).toBe('not_mine');
    expect(split).toHaveBeenCalledTimes(1);
  });
});

describe('mergeWindowWrite', () => {
  it('appends rows by column name and says what a later window could not keep', () => {
    const warnings: string[] = [];
    const a = mergeWindowWrite(
      undefined,
      {
        tabs: [
          {
            name: 'T',
            columns: [
              { name: 'Page', type: 'number' },
              { name: 'X', type: 'text' },
            ],
            rows: [[1, 'a']],
          },
        ],
      },
      warnings,
    );
    const b = mergeWindowWrite(
      a,
      {
        tabs: [
          {
            name: 'T',
            columns: [
              { name: 'X', type: 'text' },
              { name: 'Y', type: 'text' },
              { name: 'Page', type: 'number' },
            ],
            rows: [['b', 'y', 2]],
          },
          { name: 'U', columns: [{ name: 'Z', type: 'text' }], rows: [['z']] },
        ],
      },
      warnings,
    );
    expect(b.tabs.map((t) => t.name)).toEqual(['T', 'U']);
    expect(b.tabs[0]!.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(warnings[0]).toMatch(/columns the first does not \(Y\)/);
  });
});
