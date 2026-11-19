/**
 * A book's page pictures (G1) never lost in silence: the picture pass takes the PNGs of the Reader's run kept
 * for the extract, and a page the Reader marked for vision with no picture
 * there (no run kept: the memo let it go, or a retry whose database was
 * there; a picture the Reader left out) is drawn by the book's Agent step,
 * with no model. A page with a picture of these bytes already is not drawn
 * again; a page that cannot be drawn is counted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Files from '@mantle/files';

const kept = vi.fn();
const split = vi.fn();
const stepRun = vi.fn();
vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  keptReaderRun: (...a: unknown[]) => kept(...a),
  parserPdfSplit: (...a: unknown[]) => split(...a),
  parserPipelineRun: (...a: unknown[]) => stepRun(...a),
}));
vi.mock('./file-database', async (orig) => ({
  ...(await orig<typeof import('./file-database')>()),
  readFileDbStamp: async () => ({ pipeline_id: 'pdf-pages' }),
}));
const marked = vi.fn<() => Promise<number[]>>();
vi.mock('./book-pages', async (orig) => ({
  ...(await orig<typeof import('./book-pages')>()),
  bookVisionPagesOf: () => marked(),
}));
vi.mock('./pipeline-state', async (orig) => ({
  ...(await orig<typeof import('./pipeline-state')>()),
  pipelineStateOf: async () => ({ options: {}, optionsHash: '' }),
}));
let agents: unknown[] = [];
vi.mock('./pipeline-registry', async (orig) => {
  const files = await import('@mantle/files');
  const byId = (id: string) => {
    const p = files.BUILTIN_PIPELINES.find((b) => b.id === id);
    return p ? { ...p, source: 'builtin' } : null;
  };
  return {
    ...(await orig<typeof import('./pipeline-registry')>()),
    boxPipelines: async () => ({ byId, agents }),
  };
});

const { standingReaderPictures } = await import('./reader-passes');
const { SpooledPictures } = await import('./picture-spool');
const files = await import('@mantle/files');

const SHA = 'b'.repeat(64);
const FILE = { id: '11111111-1111-4111-8111-111111111111', sha256: SHA };
const TOTAL = 40;
const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]);

beforeEach(() => {
  kept.mockReset();
  split.mockReset();
  stepRun.mockReset();
  marked.mockReset();
  agents = [
    { ...files.BUILTIN_PIPELINES.find((b) => b.id === 'pdf-page-read')!, source: 'builtin' },
  ];
  split.mockImplementation(async (_b: Buffer, o: { from: number; pages: number }) => {
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return { bytes: Buffer.from('w'), pageFrom: o.from, pageTo, pagesTotal: TOTAL };
  });
  stepRun.mockImplementation(
    async (_b: Buffer, _p: unknown, req: { state: { visionPages: number[] } }) => {
      const pictures = new Map<string, Buffer>();
      const calls = req.state.visionPages.map((n) => {
        pictures.set(`page-${n}.png`, png(n));
        return {
          call: 'worker',
          worker: 'vision',
          key: `page-${n}`,
          input: { picture: `page-${n}.png`, page: n },
        };
      });
      return { result: { status: 'ok', calls }, pictures };
    },
  );
});

/** A kept run of the Reader whose pictures are those of `pages`. */
function keptRun(pages: number[]) {
  const spool = new SpooledPictures();
  const pictures = pages.map((n) => {
    const file = `w1-page-${String(n).padStart(5, '0')}.png`;
    spool.put(file, png(n));
    return { file, mime: 'image/png', page: n };
  });
  kept.mockReturnValue(
    Promise.resolve({
      status: 'ok',
      pictures: spool,
      write: { tabs: [], pictures },
      warnings: [],
      counts: {},
    }),
  );
  return spool;
}

describe("a book's page pictures (G1, H1 of audit round 3)", () => {
  it('no run kept (the memo let it go, or a retry): every marked page is drawn by the Agent step, with no ask', async () => {
    kept.mockReturnValue(undefined);
    marked.mockResolvedValue([2, 4, 30]);
    const got = await standingReaderPictures('owner', FILE, Buffer.from('pdf'));
    expect(got!.pictures.map((p) => p.page)).toEqual([2, 4, 30]);
    expect(got!.lost).toBe(0);
    expect(got!.bytes.get(got!.pictures[2]!.file)?.[4]).toBe(30);
    // Two windows of 15 pages: 2 to 16, 30 to 40; no model is asked.
    expect(split).toHaveBeenCalledTimes(2);
    got!.drop();
    expect(got!.bytes.get(got!.pictures[0]!.file)).toBeUndefined();
  });

  it("the kept run's pictures stand; only a marked page it left out is drawn; a page pictured already is neither", async () => {
    keptRun([2, 4]);
    marked.mockResolvedValue([2, 4, 6, 9]);
    const got = await standingReaderPictures('owner', FILE, Buffer.from('pdf'), new Set([9]));
    expect(got!.pictures.map((p) => [p.page, p.file.startsWith('drawn-')])).toEqual([
      [2, false],
      [4, false],
      [6, true],
    ]);
    expect(got!.had).toBe(1);
    expect(stepRun).toHaveBeenCalledTimes(1);
    expect((stepRun.mock.calls[0]![2] as { state: unknown }).state).toEqual({
      readerOptions: {},
      visionPages: [6],
    });
    got!.drop();
  });

  it('every marked page pictured by the kept run: no parser job at all', async () => {
    keptRun([2, 4]);
    marked.mockResolvedValue([2, 4]);
    const got = await standingReaderPictures('owner', FILE, Buffer.from('pdf'));
    expect(got!.pictures).toHaveLength(2);
    expect(split).not.toHaveBeenCalled();
    got!.drop();
  });

  it('no Agent to draw them: the pages are counted lost, so the book shows partial', async () => {
    kept.mockReturnValue(undefined);
    agents = [];
    marked.mockResolvedValue([2, 4]);
    const got = await standingReaderPictures('owner', FILE, Buffer.from('pdf'));
    expect(got!.pictures).toEqual([]);
    expect(got!.lost).toBe(2);
  });
});

describe('a draw that fails costs only its pages', () => {
  it('a first cut that fails (not busy): the marked pages are counted lost, the kept ones stand, no throw', async () => {
    keptRun([2]);
    marked.mockResolvedValue([2, 30]);
    split.mockRejectedValue(
      new files.ParserError('timeout', 'the cut took too long', {
        retryable: true,
        terminal: false,
      }),
    );
    const got = await standingReaderPictures('owner', FILE, Buffer.from('pdf'));
    expect(got!.pictures.map((p) => p.page)).toEqual([2]);
    expect(got!.lost).toBe(1);
    got!.drop();
  });

  it('a busy parser throws: the extract tries again', async () => {
    kept.mockReturnValue(undefined);
    marked.mockResolvedValue([30]);
    split.mockRejectedValue(
      new files.ParserError('busy', 'busy', { retryable: true, terminal: false }),
    );
    await expect(standingReaderPictures('owner', FILE, Buffer.from('pdf'))).rejects.toThrow();
  });
});
