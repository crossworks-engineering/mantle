/**
 * The PDF router, a package (docs/pipelines.md, "The router"): its job names
 * the kind, the job of the reader that claims the kind reads the rows, and
 * a real read counts the router's run once, a document too. A read with no
 * `count` (a test of a pipeline) counts none, a failed read names no kind,
 * and a read again with the stored kind runs no router. The router's job
 * reads the file one time and hands its page facts to the reader's job, so
 * a PDF is read one time, and the rows are those of a reader that reads
 * the file itself. The steps run in this process on made-up fixtures (the
 * parser's job faked at the fetch); the count is a fake; no database. The
 * answers are file-database.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOCK_COLUMNS, PAGE_KINDS_NOTE, resetParserFailures } from '@mantle/files';
import { OPTS_LENGTH_HEADER } from '@mantle/files/parser-wire';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';
import { pipelinesOf } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = pipelinesOf([]);

const counted = vi.hoisted(() => [] as { ownerId: string; pipelineId: string }[]);
vi.mock('./pipeline-state', () => ({
  // No own pipeline on this box (the registry's one read of them).
  ownManifests: async () => [],
  countPipelineRun: vi.fn(async (ownerId: string, pipelineId: string) => {
    counted.push({ ownerId, pipelineId });
  }),
  pipelineStateOf: vi.fn(async () => ({
    offIn: [],
    options: {},
    optionsHash: '',
    runs: 0,
    lastRunAt: null,
  })),
}));

/** The reads of a PDF's pages (pdfjs, the costly part of a read), and a
 *  cap of the router's facts a test may lower. */
const reads = vi.hoisted(() => ({ n: 0, factsCap: undefined as number | undefined }));
vi.mock('../../files/src/pdf-primitives', async (orig) => {
  const m = await orig<typeof import('../../files/src/pdf-primitives')>();
  return {
    ...m,
    readPdfPages: (...a: Parameters<typeof m.readPdfPages>) => {
      reads.n += 1;
      return m.readPdfPages(...a);
    },
  };
});
vi.mock('../../files/src/pipelines/contract', async (orig) => {
  const m = await orig<typeof import('../../files/src/pipelines/contract')>();
  return {
    ...m,
    get PIPELINE_FACTS_MAX_BYTES() {
      return reads.factsCap ?? m.PIPELINE_FACTS_MAX_BYTES;
    },
  };
});

const { parseFileSheets } = await import('./file-database');

/** Every parser job answers `res()`; the fake fetch, to count the reads. */
function stubParser(res: () => Response) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const calls = vi.fn(async () => res());
  vi.stubGlobal('fetch', calls);
  return calls;
}
const bytes = () => Buffer.from(randomUUID());
/** A made-up fixture of the PDF set, read by the real steps run in this
 *  process (the parser's pipelineRun job, inProcessPipelineFetch). */
const PDFS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'files',
  'src',
  'pipelines',
  'pkg',
  'drawing-pdf',
  'fixtures',
);
const pdf = (name: string) => readFileSync(path.join(PDFS, name));
const KIND_FIXTURE: Record<string, string> = {
  pid: 'pid.pdf',
  document: 'document.pdf',
  unsure: 'unsure-vector.pdf',
};
/** What each job of the last read got as its body: the file (`pdf`) or the
 *  router's facts (`facts`). */
const bodies: string[] = [];
/** The jobs of one read, by pipeline id. */
function inProcess() {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const inner = inProcessPipelineFetch();
  const ids: string[] = [];
  bodies.length = 0;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
    const n = Number(new Headers(init?.headers).get(OPTS_LENGTH_HEADER) ?? 0);
    ids.push((JSON.parse(all.subarray(0, n).toString('utf8')) as { id: string }).id);
    bodies.push(all.subarray(n, n + 5).toString('latin1') === '%PDF-' ? 'pdf' : 'facts');
    return inner(input, { ...init, body: all });
  });
  return ids;
}
/** A ParsedFile with its clock columns masked (CLOCK_COLUMNS). */
function masked(parsed: Awaited<ReturnType<typeof parseFileSheets>>) {
  if (parsed.kind !== 'sheets') return parsed;
  return {
    ...parsed,
    sheets: parsed.sheets.map((s) => {
      const clock = CLOCK_COLUMNS.get(s.name) ?? [];
      const at = s.columns.flatMap((c, i) => (clock.includes(c.name) ? [i] : []));
      return { ...s, rows: s.rows.map((r) => r.map((v, i) => (at.includes(i) ? null : v))) };
    }),
  };
}
const decision = (kind: string) => ({
  kind,
  confidence: 0.9,
  model: 'm',
  mode: 'live' as const,
  used: true,
});
const count = { ownerId: randomUUID(), fileId: randomUUID() };

beforeEach(() => {
  counted.length = 0;
  reads.n = 0;
  reads.factsCap = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

describe('the PDF router in a real read', () => {
  it("the router's job, then the reader's on the router's facts: one read of a PDF", async () => {
    const cases: [
      string,
      ((d: unknown) => Promise<ReturnType<typeof decision>>) | undefined,
      string[],
      string[],
    ][] = [
      ['pid', undefined, ['pdf-router', 'drawing-pdf'], ['pdf', 'facts']],
      // A document is a book (rules 4): the document case is pinned below.
      // The router's second step takes the decider's answer: a job of no read.
      [
        'unsure',
        async () => decision('datasheet'),
        ['pdf-router', 'pdf-router', 'drawing-pdf'],
        ['pdf', 'pdf', 'facts'],
      ],
    ];
    for (const [kind, decide, jobs, sent] of cases) {
      const ids = inProcess();
      reads.n = 0;
      await parseFileSheets(pdf(KIND_FIXTURE[kind]!), 'pdf', {
        pipelines,
        count,
        ...(decide ? { pdfKind: decide } : {}),
      });
      expect(ids, kind).toEqual(jobs);
      expect([...bodies], kind).toEqual(sent);
      expect(reads.n, `${kind}: the pages are read one time`).toBe(1);
    }
  });

  it("the rows from the router's facts are the rows of a reader that reads the file", async () => {
    for (const name of [
      'pid.pdf',
      'unsure-vector.pdf',
      'unsure.pdf',
      'scan.pdf',
      'odd-values.pdf',
    ]) {
      inProcess();
      const once = await parseFileSheets(pdf(name), 'pdf', { pipelines });
      expect(once.kind, name).toBe('sheets');
      if (once.kind !== 'sheets') continue;
      const file = once.sheets.find((s) => s.name === 'File')!;
      const kind = String(file.rows[0]![file.columns.findIndex((c) => c.name === 'Kind')]);
      // The stored kind: the router does not run, the reader reads the file.
      const ids = inProcess();
      const itself = await parseFileSheets(pdf(name), 'pdf', {
        pipelines,
        pdfStored: { kind, decision: null },
      });
      expect(ids, name).toEqual(['drawing-pdf']);
      expect([...bodies], name).toEqual(['pdf']);
      expect(masked(once), name).toEqual(masked(itself));
    }
  });

  it('facts past their cap are left out: the reader reads the file, the same rows', async () => {
    inProcess();
    const once = await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines });
    reads.factsCap = 1;
    reads.n = 0;
    const ids = inProcess();
    const twice = await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines });
    expect(ids).toEqual(['pdf-router', 'drawing-pdf']);
    expect([...bodies]).toEqual(['pdf', 'pdf']);
    expect(reads.n).toBe(2);
    expect(masked(twice)).toEqual(masked(once));
  });

  it('a P&ID: the reader keeps the rows, and the router counts one run', async () => {
    inProcess();
    const parsed = await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines, count });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toEqual([{ ownerId: count.ownerId, pipelineId: 'pdf-router' }]);
  });

  it('a document by the rules is a book (rules 4): the book reader reads it, the router counts', async () => {
    const ids = inProcess();
    // The book reader is Python in the parser image: its first job, the cut
    // of its first window, is no job this process runs.
    await expect(
      parseFileSheets(pdf('document.pdf'), 'pdf', { pipelines, count }),
    ).rejects.toThrow();
    expect(ids[0]).toBe('pdf-router');
    expect(ids).not.toContain('drawing-pdf');
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });

  it("the decider's document on office paper makes a book (M2): one ask, one count, no drawing reader", async () => {
    const ids = inProcess();
    const decide = vi.fn(async () => decision('document'));
    // The book reader is Python in the parser image: no job this process runs.
    await expect(
      parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', { pipelines, count, pdfKind: decide }),
    ).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(ids.slice(0, 2)).toEqual(['pdf-router', 'pdf-router']);
    expect(ids).not.toContain('drawing-pdf');
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });

  it('a kind only the decider names: the reader claims it, one count', async () => {
    inProcess();
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfKind: async () => decision('datasheet'),
    });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toHaveLength(1);
  });

  it('no count given (a test of a pipeline): the same answer, no count', async () => {
    inProcess();
    expect((await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines })).kind).toBe('sheets');
    // A document is a book now (rules 4): the Python book reader's job is
    // no job this process runs; no count all the same.
    await expect(parseFileSheets(pdf('document.pdf'), 'pdf', { pipelines })).rejects.toThrow();
    expect(counted).toEqual([]);
  });

  it('a read that fails names no kind: no count', async () => {
    stubParser(() =>
      Response.json(
        { ok: false, error: { code: 'too_large', message: 'too_large', final: true } },
        { status: 413 },
      ),
    );
    expect(await parseFileSheets(bytes(), 'pdf', { pipelines, count })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
    expect(counted).toEqual([]);
  });

  it('a file type with no router counts no router', async () => {
    // A CSV is the package `sheet`: its job runs in this process.
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal('fetch', inProcessPipelineFetch());
    const parsed = await parseFileSheets(Buffer.from('tag,size\nP-101,50\n'), 'csv', {
      pipelines,
      count,
    });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toEqual([]);
  });

  it('a failed count never fails the read', async () => {
    const ps = await import('./pipeline-state');
    vi.mocked(ps.countPipelineRun).mockRejectedValueOnce(new Error('made-up db blip'));
    inProcess();
    expect((await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines, count })).kind).toBe(
      'sheets',
    );
  });

  it('a read again (the stored kind) does not run the router: no count', async () => {
    const ids = inProcess();
    const parsed = await parseFileSheets(pdf('pid.pdf'), 'pdf', {
      pipelines,
      count,
      pdfStored: { kind: 'pid', decision: null },
    });
    expect(parsed.kind).toBe('sheets');
    expect(ids).toEqual(['drawing-pdf']);
    expect([...bodies]).toEqual(['pdf']);
    expect(reads.n).toBe(1);
    expect(counted).toEqual([]);
  });

  it('a read again of a kind from older rules runs the router with no ask, and keeps the stored answer', async () => {
    const ids = inProcess();
    const shadow = { ...decision('pid'), mode: 'shadow' as const, used: false };
    const decide = vi.fn(async () => decision('pfd'));
    // A file the rules leave unsure: on an upload the router would ask.
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfKind: decide,
      pdfStored: { kind: 'other_drawing', decision: shadow, reroute: true },
    });
    // No model is asked on a read again, a decider passed or not.
    expect(decide).not.toHaveBeenCalled();
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const file = parsed.sheets.find((s) => s.name === 'File')!;
    const row = Object.fromEntries(file.columns.map((c, i) => [c.name, file.rows[0]![i]]));
    // The rules of now name it; the shadow answer stays beside it.
    expect(row).toMatchObject({
      Kind: 'unsure',
      'Kind source': 'rules',
      'Rules kind': 'unsure',
      'Decider answer': 'pid',
      'Decider mode': 'shadow',
    });
    expect(ids).toEqual(['pdf-router', 'drawing-pdf']);
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });
  it('a read again puts the stored page types in again, with no ask (M3)', async () => {
    const ids = inProcess();
    const pdfPages = {
      live: false,
      floor: 0.6,
      room: vi.fn(async () => 100),
      kept: vi.fn(async () => null),
      ask: vi.fn(async () => null),
      settle: vi.fn(),
    };
    const answer = (page: number) => ({
      page,
      kind: 'isometric',
      from: 'rules: shadow',
      deciderKind: 'pid',
      deciderConfidence: 0.98,
    });
    const parsed = await parseFileSheets(pdf('pid.pdf'), 'pdf', {
      pipelines,
      count,
      pdfStored: { kind: 'pid', decision: null, pageKinds: [answer(1)] },
    });
    // No asker (every read again but a person's run of one file): no ask.
    expect(ids).toEqual(['drawing-pdf']);
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    // With an asker (a person's run, Q2) over a file whose every page has
    // its stored answer: no page ask and no window cut.
    const tab = parsed.sheets.find((s) => s.name === 'Pages')!;
    const pageAt = tab.columns.findIndex((c) => c.name === 'Page');
    const rows = tab.rows.map((r) => Number(r[pageAt]));
    expect(rows.length).toBeGreaterThan(0);
    ids.length = 0;
    const again = await parseFileSheets(pdf('pid.pdf'), 'pdf', {
      pipelines,
      count,
      pdfPages,
      pdfStored: { kind: 'pid', decision: null, pageKinds: rows.map(answer) },
    });
    expect(again.kind).toBe('sheets');
    expect(pdfPages.ask).not.toHaveBeenCalled();
    expect(pdfPages.room).not.toHaveBeenCalled();
    expect(pdfPages.kept).not.toHaveBeenCalled();
    expect(ids).toEqual(['drawing-pdf']);
    const pages = parsed.sheets.find((s) => s.name === 'Pages')!;
    const at = (name: string) => pages.columns.findIndex((c) => c.name === name);
    expect(pages.rows[0]![at('Kind from')]).toBe('rules: shadow');
    expect(pages.rows[0]![at('Decider kind')]).toBe('pid');
    expect(pages.rows[0]![at('Decider confidence')]).toBe(0.98);
    // The description says what the new words of Kind from are.
    expect(parsed.description).toContain(PAGE_KINDS_NOTE);
    // Its own Kind stays the drawing reader's, not the stored one.
    expect(pages.rows[0]![at('Kind')]).not.toBe('isometric');
    expect(typeof pages.rows[0]![at('Kind')]).toBe('string');
  });

  /** A decider that is never asked (every page has its stored answer). */
  const noAsks = (live: boolean) => ({
    live,
    floor: 0.6,
    room: vi.fn(async () => 100),
    kept: vi.fn(async () => null),
    ask: vi.fn(async () => null),
    settle: vi.fn(),
  });
  /** The pages of a file's tab Pages, by a first read. */
  async function pagesOf(name: string, kind: string) {
    inProcess();
    const first = await parseFileSheets(pdf(name), 'pdf', {
      pipelines,
      count,
      pdfStored: { kind, decision: null, pageKinds: [] },
    });
    if (first.kind !== 'sheets') throw new Error('no sheets');
    const tab = first.sheets.find((s) => s.name === 'Pages')!;
    const at = tab.columns.findIndex((c) => c.name === 'Page');
    return tab.rows.map((r) => Number(r[at]));
  }
  const typed = (pages: number[], deciderKind: string, deciderConfidence = 0.9) =>
    pages.map((page) => ({
      page,
      kind: 'unsure',
      from: 'rules: shadow',
      deciderKind,
      deciderConfidence,
    }));

  it('live (M4): the stored answers of a shadow week name the frame, with no ask', async () => {
    const rows = await pagesOf('unsure-vector.pdf', 'unsure');
    const ids = inProcess();
    const pdfPages = noAsks(true);
    // Stored as a book; its pages' answers say drawing: the drawing lane,
    // as unsure (the frame picks the lane, not a kind of its own).
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfPages,
      pdfStored: { kind: 'book', decision: null, pageKinds: typed(rows, 'pfd') },
    });
    expect(pdfPages.ask).not.toHaveBeenCalled();
    expect(ids).toEqual(['drawing-pdf']);
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const file = parsed.sheets.find((s) => s.name === 'File')!;
    expect(file.rows[0]![file.columns.findIndex((c) => c.name === 'Kind')]).toBe('unsure');
    const pages = parsed.sheets.find((s) => s.name === 'Pages')!;
    const at = (name: string) => pages.columns.findIndex((c) => c.name === name);
    expect(pages.rows[0]![at('Kind from')]).toBe('decider');
    expect(pages.rows[0]![at('Kind')]).toBe('pfd');
  });

  it('live: an answer under the floor is not used; the kind is as named', async () => {
    const rows = await pagesOf('unsure-vector.pdf', 'unsure');
    inProcess();
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfPages: noAsks(true),
      pdfStored: { kind: 'unsure', decision: null, pageKinds: typed(rows, 'pfd', 0.55) },
    });
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const file = parsed.sheets.find((s) => s.name === 'File')!;
    expect(file.rows[0]![file.columns.findIndex((c) => c.name === 'Kind')]).toBe('unsure');
    const pages = parsed.sheets.find((s) => s.name === 'Pages')!;
    const at = (name: string) => pages.columns.findIndex((c) => c.name === name);
    expect(pages.rows[0]![at('Kind from')]).toBe('rules: low confidence');
  });

  /** The box's pipelines, with each Reader the read picks seen. */
  function seenReaders() {
    const seen: (string | undefined)[] = [];
    const spy = {
      ...pipelines,
      readerFor: (ext: string, kind?: string) => {
        const r = pipelines.readerFor(ext, kind);
        if (kind !== undefined) seen.push(r?.id);
        return r;
      },
    } as typeof pipelines;
    return { spy, seen };
  }

  it('live: office pages name the book, read by the book reader', async () => {
    const rows = await pagesOf('unsure-vector.pdf', 'unsure');
    inProcess();
    const { spy, seen } = seenReaders();
    const got = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines: spy,
      count,
      pdfPages: noAsks(true),
      pdfStored: { kind: 'unsure', decision: null, pageKinds: typed(rows, 'table') },
    }).catch((e: unknown) => e);
    expect(seen).toEqual(['pdf-pages']);
    // The book reader's first job cuts its first page window, which the
    // in-process parser of this test does not do.
    expect(got).toMatchObject({ name: 'ParserError', code: 'unavailable' });
  });

  it("a read again with no asker keeps a live read's book frame, a reroute by newer rules too", async () => {
    const rows = await pagesOf('unsure-vector.pdf', 'unsure');
    const ids = inProcess();
    const { spy, seen } = seenReaders();
    const kept = typed(rows, 'table').map((k) => ({ ...k, kind: 'table', from: 'decider' }));
    await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines: spy,
      count,
      pdfStored: { kind: 'book', decision: null, reroute: true, pageKinds: kept },
    }).catch(() => null);
    // The rules of now run (no ask) and name it unsure; the stored used
    // answers name the book again.
    expect(ids[0]).toBe('pdf-router');
    expect(seen).toEqual(['pdf-pages']);
  });

  it('shadow: the same answers change nothing, and say rules: shadow', async () => {
    const rows = await pagesOf('unsure-vector.pdf', 'unsure');
    const ids = inProcess();
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfPages: noAsks(false),
      pdfStored: { kind: 'unsure', decision: null, pageKinds: typed(rows, 'table', 0.4) },
    });
    expect(ids).toEqual(['drawing-pdf']);
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const file = parsed.sheets.find((s) => s.name === 'File')!;
    expect(file.rows[0]![file.columns.findIndex((c) => c.name === 'Kind')]).toBe('unsure');
    const pages = parsed.sheets.find((s) => s.name === 'Pages')!;
    const at = (name: string) => pages.columns.findIndex((c) => c.name === name);
    // In shadow no answer is used, whatever its sum: the reason is shadow.
    expect(pages.rows[0]![at('Kind from')]).toBe('rules: shadow');
    expect(pages.rows[0]![at('Kind')]).not.toBe('table');
  });

  it('with no page types stored and no asker, the tab Pages is as before M3', async () => {
    inProcess();
    const parsed = await parseFileSheets(pdf('pid.pdf'), 'pdf', {
      pipelines,
      count,
      pdfStored: { kind: 'pid', decision: null, pageKinds: [] },
    });
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const pages = parsed.sheets.find((s) => s.name === 'Pages')!;
    expect(pages.columns.some((c) => c.name.startsWith('Decider'))).toBe(false);
    expect(parsed.description ?? '').not.toContain(PAGE_KINDS_NOTE);
  });
});
