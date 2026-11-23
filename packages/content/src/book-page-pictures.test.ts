/**
 * A book's page pictures have ONE owner, the Agent pdf-page-read, in its
 * own run (G1, ./book-page-pictures.ts): render (the step draws the marked
 * pages of a window), read (the tab by hash, else one paid call), save (the
 * text row, then the page picture with that text). On a real file database
 * of a made-up book, with three stand-ins: the parser's cut and step, the
 * paid ask, and the place pictures are saved. No Postgres and no model.
 *
 * Pinned here:
 *  - the first run draws only the windows that hold a marked page, pays one
 *    call a page, and saves each page's picture with the text it read;
 *  - a run again with every page done cuts nothing, draws nothing and pays
 *    nothing, and keeps the paid rows;
 *  - a page whose picture was not saved is drawn again and saved with the
 *    text of its row, taken by hash: no second paid call;
 *  - a page whose read failed is not saved (no empty picture), and the
 *    count is asked at the end of every run;
 *  - an answer that keeps an older row after a stop saves no picture;
 *  - M4: in a book the Agent's page text goes to the passages by page (no
 *    text of its own); in a PDF drawing (its office pages, by lane) it goes
 *    to the file's text, as any Agent's, so no paid page text is out of
 *    search.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkbookDoc } from '@mantle/content-core/table-model';
import type * as Files from '@mantle/files';
import type { PipelineCallAnswer } from '@mantle/files';
import type { BookPagePicture, BookPagePictures } from './book-page-pictures';
import type { AgentAsk } from './pipeline-agent';
import type { BoxPipelines } from './pipeline-registry';

const dir = mkdtempSync(path.join(tmpdir(), 'book-page-pictures-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOTAL = 40;
const PNG = (n: number) =>
  Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`page ${n}`)]);

const h = vi.hoisted(() => ({
  /** What happened, in order: `cut:<from>`, `step:<from>`, `ask:<key>`. */
  events: [] as string[],
  /** The state each step got. */
  states: [] as unknown[],
  row: { sha256: '' },
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof Files>()),
  fileDbPaths: (id: string, sha: unknown) =>
    typeof sha === 'string' ? { sqlite: path.join(dir, `${id}.sqlite`), none: '' } : null,
  // The cut: 15 pages from `from`.
  parserPdfSplit: vi.fn(async (_b: Buffer, o: { from: number; pages: number }) => {
    h.events.push(`cut:${o.from}`);
    const pageTo = Math.min(TOTAL, o.from + o.pages - 1);
    return { bytes: Buffer.from(`w${o.from}`), pageFrom: o.from, pageTo, pagesTotal: TOTAL };
  }),
  // The Agent's step, as pdf-page-read answers it: one ask a marked page
  // of its window, with the page's picture (render, no model).
  parserPipelineRun: vi.fn(
    async (
      _b: Buffer,
      _p: unknown,
      req: {
        state: { visionPages: number[]; donePages?: number[] };
        pageFrom: number;
        pageTo: number;
      },
    ) => {
      h.events.push(`step:${req.pageFrom}`);
      h.states.push(req.state);
      const pictures = new Map<string, Buffer>();
      const done = new Set(req.state.donePages ?? []);
      const calls = req.state.visionPages
        .filter((n) => n >= req.pageFrom && n <= req.pageTo && !done.has(n))
        .map((n) => {
          pictures.set(`page-${n}.png`, PNG(n));
          return {
            call: 'worker',
            worker: 'vision',
            key: `page-${n}`,
            input: { picture: `page-${n}.png`, fields: [{ name: 'Text' }], page: n },
          };
        });
      return { result: { status: 'ok', calls }, pictures };
    },
  ),
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { path: 'files', indexing: 'full', home: null, filename: 'book.pdf', ...h.row },
          ],
        }),
      }),
    }),
  },
}));

vi.mock('./pipeline-state', async (orig) => ({
  ...(await orig<typeof import('./pipeline-state')>()),
  pipelineStateOf: vi.fn(async () => ({
    options: {},
    optionsHash: '',
    offIn: [],
    runs: 0,
    lastRunAt: null,
  })),
  countPipelineRun: vi.fn(async () => {}),
}));

const files = await import('@mantle/files');
const { pipelineStampOf } = files;
const fd = await import('./file-database');
const { writeFileDatabaseDoc } = await import('./table-broker');
const { pagesToRead, windowPagePictures } = await import('./book-page-pictures');

const builtin = (id: string) => ({
  ...files.BUILTIN_PIPELINES.find((p) => p.id === id)!,
  source: 'builtin' as const,
});
const AGENT = builtin('pdf-page-read');
const READER = builtin('pdf-pages');
const DRAWING = builtin('drawing-pdf');
const pipelines = {
  all: [READER, DRAWING, AGENT],
  byId: (id: string) => [READER, DRAWING, AGENT].find((p) => p.id === id) ?? null,
  readerFor: () => null,
  routerFor: () => builtin('pdf-router'),
  after: [],
  agents: [AGENT],
  acted: [AGENT],
} as unknown as BoxPipelines;

/** A book of 40 pages whose reader marked `marked` for vision. */
function book(marked: number[]): { fileId: string; bytes: Buffer; sha256: string } {
  const fileId = randomUUID();
  const bytes = Buffer.from(`made-up book ${fileId}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pages = Array.from({ length: TOTAL }, (_, i) => i + 1);
  writeFileDatabaseDoc(
    path.join(dir, `${fileId}.sqlite`),
    ensureWorkbookDoc({
      tabs: fd.tabsOfSheets([
        {
          name: 'File',
          columns: ['Kind', 'Rules kind'].map((name) => ({ name, type: 'text' as const })),
          rows: [['book', 'book']],
        },
        {
          name: 'Pages',
          columns: [
            { name: 'Page', type: 'number' },
            { name: 'Method', type: 'text' },
            { name: 'Text', type: 'text' },
          ],
          rows: pages.map((n) => [n, marked.includes(n) ? 'vision' : 'text', `page ${n}`]),
        },
      ]),
    }),
    { fileId, ownerId: randomUUID(), stamp: pipelineStampOf(READER as never, []) },
  );
  return { fileId, bytes, sha256 };
}

/** The place pictures are saved, in memory: `done` holds what is saved. */
function sink(done: Set<number> = new Set()) {
  const saved: BookPagePicture[] = [];
  let counted = 0;
  const pictures: BookPagePictures = {
    done: async () => new Set(done),
    save: async (pics) => {
      for (const p of pics) {
        saved.push(p);
        done.add(p.page);
      }
      return pics.length;
    },
    count: async () => {
      counted += 1;
    },
  };
  return { pictures, saved, done, counted: () => counted };
}

let fail: ((a: AgentAsk) => boolean) | undefined;
const paid = async (a: AgentAsk): Promise<PipelineCallAnswer> => {
  h.events.push(`ask:${a.key}`);
  if (fail?.(a)) return { ok: false, error: 'failed' };
  return { ok: true, output: { values: { Text: `the text of ${a.key}` }, model: 'made-up' } };
};

const run = (b: ReturnType<typeof book>, pagePictures: BookPagePictures) =>
  fd.runAgentOnFile({
    fileId: b.fileId,
    ownerId: randomUUID(),
    sha256: b.sha256,
    bytes: b.bytes,
    filename: 'book.pdf',
    pipeline: AGENT,
    pipelines,
    ask: paid,
    pagePictures,
  });

const of = (prefix: string) => h.events.filter((e) => e.startsWith(prefix));

beforeEach(() => {
  h.events.length = 0;
  h.states.length = 0;
  fail = undefined;
});

/** A PDF drawing of 40 pages (the drawing reader's database) whose pages
 *  in `office` are office scans by a used page answer (M4). */
function drawing(office: number[]): { fileId: string; bytes: Buffer; sha256: string } {
  const fileId = randomUUID();
  const bytes = Buffer.from(`made-up drawing ${fileId}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pages = Array.from({ length: TOTAL }, (_, i) => i + 1);
  writeFileDatabaseDoc(
    path.join(dir, `${fileId}.sqlite`),
    ensureWorkbookDoc({
      tabs: fd.tabsOfSheets([
        {
          name: 'File',
          columns: ['Kind', 'Rules kind'].map((name) => ({ name, type: 'text' as const })),
          rows: [['scan', 'scan']],
        },
        {
          name: 'Pages',
          columns: ['Page', 'Class', 'Kind', 'Kind from'].map((name) => ({
            name,
            type: name === 'Page' ? ('number' as const) : ('text' as const),
          })),
          rows: pages.map((n) =>
            office.includes(n) ? [n, 'scan', 'table', 'decider'] : [n, 'scan', 'scan', 'rules'],
          ),
        },
      ]),
    }),
    { fileId, ownerId: randomUUID(), stamp: pipelineStampOf(DRAWING as never, []) },
  );
  return { fileId, bytes, sha256 };
}

describe("where the Agent's page text goes (M4)", () => {
  it("a book: by page (no text of its own); a PDF drawing: to the file's text", async () => {
    const b = book([2]);
    h.row = { sha256: b.sha256 };
    const inBook = await run(b, sink().pictures);
    expect(inBook).toMatchObject({ status: 'asked', made: 1, text: '' });
    const d = drawing([4]);
    h.row = { sha256: d.sha256 };
    const inDrawing = await run(d, sink().pictures);
    expect(inDrawing).toMatchObject({ status: 'asked', made: 1 });
    expect(inDrawing.status === 'asked' && inDrawing.text).toContain('the text of page-4');
  });
});

describe("a book's page pictures: render, read and save in the Agent's run", () => {
  it('the first run draws the windows of the marked pages, pays one call a page and saves each picture with its text', async () => {
    const b = book([2, 5, 30]);
    h.row = { sha256: b.sha256 };
    const s = sink();
    const out = await run(b, s.pictures);
    expect(out).toMatchObject({ status: 'asked', made: 3, reused: 0, pictures: 3 });
    expect(of('cut:')).toEqual(['cut:2', 'cut:30']);
    expect(of('ask:')).toEqual(['ask:page-2', 'ask:page-5', 'ask:page-30']);
    expect(s.saved.map((p) => [p.page, p.text, p.mime])).toEqual([
      [2, 'the text of page-2', 'image/png'],
      [5, 'the text of page-5', 'image/png'],
      [30, 'the text of page-30', 'image/png'],
    ]);
    expect(s.saved[2]!.bytes.equals(PNG(30))).toBe(true);
    expect(s.counted()).toBe(1);
  });

  it('a run again with every page done cuts nothing, draws nothing and pays nothing; the rows stay', async () => {
    const b = book([2, 30]);
    h.row = { sha256: b.sha256 };
    const s = sink();
    await run(b, s.pictures);
    h.events.length = 0;
    h.states.length = 0;
    const again = await run(b, sink(s.done).pictures);
    expect(again).toMatchObject({ status: 'asked', made: 0, pictures: 0 });
    expect(h.events).toEqual([]);
    // The paid rows of both pages are still there: their text stands.
    const { filePagesOf } = await import('./page-passages');
    const got = await filePagesOf({ id: b.fileId, ownerId: 'o', sha256: b.sha256 }, pipelines);
    const text = new Map(got!.pages.map((p) => [p.page, p.text]));
    expect([text.get(2), text.get(30), text.get(3)]).toEqual([
      'the text of page-2',
      'the text of page-30',
      'page 3',
    ]);
  });

  it('a page whose picture was not saved is drawn again and saved with its row, taken by hash: no second paid call', async () => {
    const b = book([2, 30]);
    h.row = { sha256: b.sha256 };
    await run(b, sink().pictures);
    h.events.length = 0;
    h.states.length = 0;
    const s = sink(new Set([30]));
    const out = await run(b, s.pictures);
    expect(out).toMatchObject({ status: 'asked', made: 0, reused: 1, pictures: 1 });
    expect(of('cut:')).toEqual(['cut:2']);
    expect(of('ask:')).toEqual([]);
    // The step gets every marked page (its option counts them all) and the
    // done ones, which it neither draws nor asks.
    expect(h.states).toEqual([{ readerOptions: {}, visionPages: [2, 30], donePages: [30] }]);
    expect(s.saved.map((p) => [p.page, p.text])).toEqual([[2, 'the text of page-2']]);
  });

  it('a page whose read failed is not saved, and the count is asked all the same', async () => {
    const b = book([2, 5]);
    h.row = { sha256: b.sha256 };
    fail = (a) => a.key === 'page-5';
    const s = sink();
    const out = await run(b, s.pictures);
    expect(out).toMatchObject({ status: 'asked', made: 1, stopped: 'failed' });
    expect(s.saved.map((p) => p.page)).toEqual([2]);
    expect(s.counted()).toBe(1);
    // A run again pays only for the page not read.
    h.events.length = 0;
    h.states.length = 0;
    fail = undefined;
    const s2 = sink(s.done);
    await run(b, s2.pictures);
    expect(of('ask:')).toEqual(['ask:page-5']);
    expect(s2.saved.map((p) => p.page)).toEqual([5]);
  });
});

describe('the pure rules', () => {
  const ask = (n: number, hash: string): AgentAsk => ({
    key: `page-${n}`,
    worker: 'vision',
    fields: [{ name: 'Text' }],
    list: false,
    page: n,
    picture: PNG(n),
    mime: 'image/png',
    hash,
  });
  const sheet = (rows: (string | null)[][]) => ({
    name: 'Page text',
    columns: ['Key', 'Text', 'Model', 'Input hash'].map((name) => ({
      name,
      type: 'text' as const,
    })),
    rows,
  });

  it('a page done is read again only when its text row is gone', () => {
    const stored = [
      { Key: 'page-2', Text: 'two' },
      { Key: 'page-3', Text: '' },
    ];
    expect(pagesToRead([1, 2, 3, 4], new Set([2, 3, 4]), stored)).toEqual([1, 3, 4]);
  });

  it('a row that answers an older picture (kept by its key after a stop), or has no text, saves no picture', () => {
    const got = windowPagePictures(
      [ask(1, 'h1'), ask(2, 'h2'), ask(3, 'h3')],
      sheet([
        ['page-1', 'one', 'm', 'h1'],
        ['page-2', 'two', 'm', 'older'],
        ['page-3', '  ', 'm', 'h3'],
      ]),
    );
    expect(got.map((p) => [p.page, p.text])).toEqual([[1, 'one']]);
    expect(windowPagePictures([ask(1, 'h1')], null)).toEqual([]);
  });
});
