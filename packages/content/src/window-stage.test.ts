/**
 * The window stage of a book's run (./window-stage.ts, runWindowed with
 * `stage`), the parser's two jobs made up here as in pipeline-windows.test.ts,
 * on a temporary files root:
 *  - a book of 6 windows whose run fails in window 4 (a busy parser, the
 *    extract tries again) resumes at window 4: no cut and no step of windows
 *    1 to 3 again, and the result is the one a run in one go gives;
 *  - a window given up is kept as given up, so a resume reads the run it
 *    would have been;
 *  - new bytes, another Reader version or other options take no kept window;
 *  - a kept window that is not of this run (its sha256 inside differs) is
 *    read again;
 *  - a run with no stage (a test, a compare) keeps nothing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '@mantle/files';

const split = vi.fn();
const step = vi.fn();
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  parserPdfSplit: (...a: unknown[]) => split(...a),
  parserPipelineRun: (...a: unknown[]) => step(...a),
}));

const { ParserError, fileDbsDir, removeWindowStage } = await import('@mantle/files');
const { runWindowed } = await import('./pipeline-runner');
const { windowRunKey } = await import('./window-stage');

const TOTAL = 60;
const WINDOW = { pages: 10, mb: 50 };
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
const SHA = 'a'.repeat(64);
const FILE = { name: 'file.pdf', ext: 'pdf', size: 10, sha256: SHA };
const FILE_ID = '11111111-1111-4111-8111-111111111111';
const KEY = windowRunKey(`made-up-book@1.0.0:${SHA}:pdf::routed`, { kind: 'book' }, WINDOW);
const stage = (over: Partial<{ sha256: string; runKey: string }> = {}) => ({
  fileId: FILE_ID,
  sha256: SHA,
  runKey: KEY,
  ...over,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-window-stage-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  split.mockReset();
  step.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function cut() {
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return { bytes: Buffer.from(`w${o.from}`), pageFrom: o.from, pageTo, pagesTotal: TOTAL };
  });
}

/** The made-up Reader: a Pages row a page, a picture, and the count of
 *  windows read in its state. */
function read(fail: (from: number) => Error | null = () => null) {
  step.mockImplementation(async (body: Buffer, _p: unknown, req: Record<string, unknown>) => {
    const from = req.pageFrom as number;
    const to = req.pageTo as number;
    expect(body.toString()).toBe(`w${from}`);
    const err = fail(from);
    if (err) throw err;
    const rows: (string | number)[][] = [];
    for (let p = from; p <= to; p++) rows.push([p, `page ${p}`]);
    const seen = ((req.state as { windows?: number } | undefined)?.windows ?? 0) + 1;
    return {
      result: {
        status: 'ok',
        state: { windows: seen },
        warnings: [`window ${seen} read`],
        counts: { pages: to - from + 1 },
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
            },
          },
        ],
      },
      pictures: new Map([['p1.png', Buffer.from(`pic${from}`)]]),
    };
  });
}

const busy = () => new ParserError('busy', 'busy', { retryable: true, terminal: false });
const run = (s?: ReturnType<typeof stage>, opts: Record<string, unknown> = {}) =>
  runWindowed(BOOK as never, Buffer.from('book'), FILE, {
    options: opts,
    kind: 'book',
    ...(s ? { stage: s } : {}),
  });
/** The first page of each cut. */
const firstPages = (calls: unknown[][]) => calls.map((c) => (c[1] as { from: number }).from);
const stageFiles = () => {
  try {
    return readdirSync(fileDbsDir()).filter((n) => n.includes('.stage-'));
  } catch {
    return [];
  }
};

describe('the window stage', () => {
  it('a book that fails in window 4 of 6 resumes at window 4, with no window read twice', async () => {
    cut();
    read();
    const whole = await run(); // in one go, with no stage: the result to match

    split.mockClear();
    step.mockClear();
    read((from) => (from === 31 ? busy() : null));
    await expect(run(stage())).rejects.toThrow('busy');
    expect(stageFiles()).toHaveLength(3);

    split.mockClear();
    step.mockClear();
    read();
    const resumed = await run(stage());
    // Windows 1 to 3 are neither cut nor read again.
    expect(firstPages(split.mock.calls)).toEqual([31, 41, 51]);
    expect(step.mock.calls.map((c) => (c[2] as { pageFrom: number }).pageFrom)).toEqual([
      31, 41, 51,
    ]);
    // Window 4's state is the one window 3 gave.
    expect((step.mock.calls[0]![2] as { state: unknown }).state).toEqual({ windows: 3 });
    expect(resumed.write).toEqual(whole.write);
    expect(resumed.warnings).toEqual(whole.warnings);
    expect(resumed.counts).toEqual(whole.counts);
    expect(resumed.state).toBe(whole.state);
    expect(resumed.windows).toEqual(whole.windows);
    expect([...resumed.pictures.keys()]).toEqual([...whole.pictures.keys()]);
    expect(resumed.pictures.get('w11-p1.png')!.toString()).toBe('pic11');

    // A run of a book whose every window is kept asks the parser nothing.
    split.mockClear();
    step.mockClear();
    const again = await run(stage());
    expect(split).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(again.write).toEqual(whole.write);

    // The end of the build removes the stage.
    await removeWindowStage(FILE_ID, SHA);
    expect(stageFiles()).toEqual([]);
  });

  it('a window given up is kept as given up, and a resume does not read it again', async () => {
    cut();
    read((from) =>
      from === 11
        ? new ParserError('timeout', 'slow', { retryable: false, terminal: true })
        : from === 41
          ? busy()
          : null,
    );
    await expect(run(stage())).rejects.toThrow('busy');
    split.mockClear();
    step.mockClear();
    read();
    const resumed = await run(stage());
    expect(firstPages(split.mock.calls)).toEqual([41, 51]);
    expect(resumed.windows).toEqual({ pagesTotal: TOTAL, failed: [{ from: 11, to: 20 }] });
    expect(resumed.warnings).toContain('Pages 11 to 20 could not be read.');
  });

  it('new bytes, another Reader version or other options take no kept window', async () => {
    cut();
    read((from) => (from === 31 ? busy() : null));
    await expect(run(stage())).rejects.toThrow('busy');
    read();
    for (const other of [
      stage({ sha256: 'b'.repeat(64) }),
      stage({
        runKey: windowRunKey(`made-up-book@1.0.1:${SHA}:pdf::routed`, { kind: 'book' }, WINDOW),
      }),
      stage({
        runKey: windowRunKey(
          `made-up-book@1.0.0:${SHA}:pdf:1234abcd:routed`,
          { kind: 'book' },
          WINDOW,
        ),
      }),
      stage({
        runKey: windowRunKey(`made-up-book@1.0.0:${SHA}:pdf::routed`, { kind: 'drawing' }, WINDOW),
      }),
    ]) {
      split.mockClear();
      step.mockClear();
      await run(other);
      expect(firstPages(split.mock.calls)).toEqual([1, 11, 21, 31, 41, 51]);
    }
  });

  it('a kept window that is not of this run is read again', async () => {
    cut();
    read((from) => (from === 21 ? busy() : null));
    await expect(run(stage())).rejects.toThrow('busy');
    // The file of window 1 now holds other bytes' window.
    const one = stageFiles().find((n) => n.endsWith('-1.json'))!;
    const abs = path.join(fileDbsDir(), one);
    const body = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    writeFileSync(abs, JSON.stringify({ ...body, sha256: 'c'.repeat(64) }));
    split.mockClear();
    step.mockClear();
    read();
    await run(stage());
    expect(firstPages(split.mock.calls)).toEqual([1, 11, 21, 31, 41, 51]);
  });

  it('a run with no stage keeps nothing', async () => {
    cut();
    read();
    await run();
    expect(stageFiles()).toEqual([]);
  });
});
