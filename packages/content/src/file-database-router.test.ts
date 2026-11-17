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
import { CLOCK_COLUMNS, resetParserFailures } from '@mantle/files';
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
      ['document', undefined, ['pdf-router'], ['pdf']],
      // The router's second step takes the decider's answer: a job of no read.
      [
        'unsure',
        async () => decision('datasheet'),
        ['pdf-router', 'pdf-router', 'drawing-pdf'],
        ['pdf', 'pdf', 'facts'],
      ],
      // The decider's document is never used: the reader reads, as for unsure.
      [
        'unsure',
        async () => decision('document'),
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

  it('a document by the rules: no name, and the answer counts', async () => {
    inProcess();
    expect(await parseFileSheets(pdf('document.pdf'), 'pdf', { pipelines, count })).toEqual({
      kind: 'not-drawing',
    });
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });

  it("the decider's document keeps the database: one ask, one count", async () => {
    inProcess();
    const decide = vi.fn(async () => decision('document'));
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      count,
      pdfKind: decide,
    });
    expect(parsed.kind).toBe('sheets');
    expect(decide).toHaveBeenCalledTimes(1);
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
    expect(await parseFileSheets(pdf('document.pdf'), 'pdf', { pipelines })).toEqual({
      kind: 'not-drawing',
    });
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
    const parsed = await parseFileSheets(pdf('stroke-isometric.pdf'), 'pdf', {
      pipelines,
      count,
      pdfStored: { kind: 'other_drawing', decision: shadow, reroute: true },
    });
    if (parsed.kind !== 'sheets') throw new Error('no sheets');
    const file = parsed.sheets.find((s) => s.name === 'File')!;
    const row = Object.fromEntries(file.columns.map((c, i) => [c.name, file.rows[0]![i]]));
    // The rules of now name it; the shadow answer stays beside it.
    expect(row).toMatchObject({
      Kind: 'isometric',
      'Kind source': 'rules',
      'Rules kind': 'isometric',
      'Decider answer': 'pid',
      'Decider mode': 'shadow',
    });
    expect(ids).toEqual(['pdf-router', 'drawing-pdf']);
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });
});
