/**
 * The PDF router in the one parser read (docs/pipelines.md, "The router"):
 * it names the kind, the reader that claims the kind keeps the rows, and a
 * real read counts the router's run once, a document too. A read with no
 * `count` (a test of a pipeline) counts none, and a failed read names no
 * kind. The parser is faked at the fetch and the count is a fake; no
 * database. The answers themselves are file-database.test.ts, unchanged.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetParserFailures } from '@mantle/files';

const counted = vi.hoisted(() => [] as { ownerId: string; pipelineId: string }[]);
vi.mock('./pipeline-state', () => ({
  countPipelineRun: vi.fn(async (ownerId: string, pipelineId: string) => {
    counted.push({ ownerId, pipelineId });
  }),
  pipelineStateOf: vi.fn(async () => ({
    workspaces: 'all',
    options: {},
    optionsHash: '',
    runs: 0,
    lastRunAt: null,
  })),
}));

const { parseFileSheets } = await import('./file-database');

function stubParser(res: () => Response) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res()),
  );
}
const bytes = () => Buffer.from(randomUUID());
const page = (kind: string, cls: string) => ({
  page: 1,
  status: 'ok',
  class: cls,
  size: 'a1',
  widthMm: 841,
  heightMm: 594,
  rotate: 0,
  chars: 4000,
  runs: 700,
  hiddenShare: 0,
  imageCover: 0,
  segments: 20000,
  axes: { h: 0.6, v: 0.3, iso: 0.01, other: 0.09, longMm: 60000 },
  tagLike: 40,
  instruments: 30,
  lineNumbers: 12,
  markups: 0,
  markupsWithText: 0,
  kind,
  eye: null,
});
const answer = (kind: string) => () =>
  Response.json({
    ok: true,
    numPages: 1,
    pageCountMayBeShort: false,
    allRead: true,
    kind,
    pages: [page(kind, kind === 'document' ? 'text' : 'vector_text')],
    sample: 'MADE UP TITLE BLOCK WORDS FOR A SAMPLE',
  });
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
  it('a P&ID: the reader keeps the rows, and the router counts one run', async () => {
    stubParser(answer('pid'));
    const parsed = await parseFileSheets(bytes(), 'pdf', { count });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toEqual([{ ownerId: count.ownerId, pipelineId: 'pdf-router' }]);
  });

  it('a document by the rules: no name, and the answer counts', async () => {
    stubParser(answer('document'));
    expect(await parseFileSheets(bytes(), 'pdf', { count })).toEqual({ kind: 'not-drawing' });
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });

  it("a document by the decider's answer: the word no-rows, one ask, one count", async () => {
    stubParser(answer('unsure'));
    const decide = vi.fn(async () => decision('document'));
    expect(await parseFileSheets(bytes(), 'pdf', { count, pdfKind: decide })).toEqual({
      kind: 'none',
      word: 'no-rows',
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(counted.map((c) => c.pipelineId)).toEqual(['pdf-router']);
  });

  it("a kind only the decider names: the reader claims it, one count", async () => {
    stubParser(answer('unsure'));
    const parsed = await parseFileSheets(bytes(), 'pdf', {
      count,
      pdfKind: async () => decision('datasheet'),
    });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toHaveLength(1);
  });

  it('no count given (a test of a pipeline): the same answer, no count', async () => {
    stubParser(answer('pid'));
    expect((await parseFileSheets(bytes(), 'pdf')).kind).toBe('sheets');
    stubParser(answer('document'));
    expect(await parseFileSheets(bytes(), 'pdf')).toEqual({ kind: 'not-drawing' });
    expect(counted).toEqual([]);
  });

  it('a read that fails names no kind: no count', async () => {
    stubParser(() =>
      Response.json(
        { ok: false, error: { code: 'too_large', message: 'too_large', final: true } },
        { status: 413 },
      ),
    );
    expect(await parseFileSheets(bytes(), 'pdf', { count })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
    expect(counted).toEqual([]);
  });

  it('a file type with no router counts no router', async () => {
    const parsed = await parseFileSheets(Buffer.from('tag,size\nP-101,50\n'), 'csv', { count });
    expect(parsed.kind).toBe('sheets');
    expect(counted).toEqual([]);
  });

  it('a failed count never fails the read', async () => {
    const ps = await import('./pipeline-state');
    vi.mocked(ps.countPipelineRun).mockRejectedValueOnce(new Error('made-up db blip'));
    stubParser(answer('pid'));
    expect((await parseFileSheets(bytes(), 'pdf', { count })).kind).toBe('sheets');
  });
});
