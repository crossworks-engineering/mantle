/**
 * The PDF router, a package (docs/pipelines.md, "The router"): its job names
 * the kind, the job of the reader that claims the kind reads the rows, and
 * a real read counts the router's run once, a document too. A read with no
 * `count` (a test of a pipeline) counts none, a failed read names no kind,
 * and a read again with the stored kind runs no router. The steps run in
 * this process on made-up fixtures (the parser's job faked at the fetch);
 * the count is a fake; no database. The answers are file-database.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetParserFailures } from '@mantle/files';
import { OPTS_LENGTH_HEADER } from '@mantle/files/parser-wire';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';
import { boxPipelines } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = await boxPipelines('made-up-owner');

const counted = vi.hoisted(() => [] as { ownerId: string; pipelineId: string }[]);
vi.mock('./pipeline-state', () => ({
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
/** The jobs of one read, by pipeline id. */
function inProcess() {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const inner = inProcessPipelineFetch();
  const ids: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const all = Buffer.from(await new Response(init?.body ?? null).arrayBuffer());
    const n = Number(new Headers(init?.headers).get(OPTS_LENGTH_HEADER) ?? 0);
    ids.push((JSON.parse(all.subarray(0, n).toString('utf8')) as { id: string }).id);
    return inner(input, { ...init, body: all });
  });
  return ids;
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

describe('the PDF router in a real read', () => {
  it("the router's job, then the reader's: two reads of a drawing, one of a document", async () => {
    const cases: [
      string,
      ((d: unknown) => Promise<ReturnType<typeof decision>>) | undefined,
      string[],
    ][] = [
      ['pid', undefined, ['pdf-router', 'drawing-pdf']],
      ['document', undefined, ['pdf-router']],
      // The router's second step takes the decider's answer: a job of no read.
      ['unsure', async () => decision('datasheet'), ['pdf-router', 'pdf-router', 'drawing-pdf']],
      ['unsure', async () => decision('document'), ['pdf-router', 'pdf-router']],
    ];
    for (const [kind, decide, jobs] of cases) {
      const ids = inProcess();
      await parseFileSheets(pdf(KIND_FIXTURE[kind]!), 'pdf', {
        pipelines,
        count,
        ...(decide ? { pdfKind: decide } : {}),
      });
      expect(ids, kind).toEqual(jobs);
    }
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

  it("a document by the decider's answer: the word no-rows, one ask, one count", async () => {
    inProcess();
    const decide = vi.fn(async () => decision('document'));
    expect(
      await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', { pipelines, count, pdfKind: decide }),
    ).toEqual({
      kind: 'none',
      word: 'no-rows',
    });
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
    expect(counted).toEqual([]);
  });
});
