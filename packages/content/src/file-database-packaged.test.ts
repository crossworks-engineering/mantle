/**
 * A packaged built-in (`runtime: 'bun'`) reaches the one read of a file's
 * database (readSheets, through parseFileSheets) with no change in its
 * callers: pipeline_test and the extract call parseFileSheets as before. The
 * plan reader is a package (MV1), as every built-in is since MV5 and MV6,
 * and the parser is faked at the fetch. The write of such a read
 * is file-database.db.test.ts in server/api; the real parser job is
 * ./pipeline-runner.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetParserFailures } from '@mantle/files';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';
import type { ParsedSheet } from '@mantle/files/sheet-to-grid';
import { parsedFileOfRun, parseFileSheets } from './file-database';
import { goldenOf } from './pipeline-golden';
import { pipelinesOf } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = pipelinesOf([]);

const TAB: ParsedSheet = {
  name: 'Tasks',
  columns: [{ name: 'Name', type: 'text' }],
  rows: [['Dig']],
};

function stubParser(result: unknown, status = 200) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      urls.push(String(url));
      return status === 200
        ? Response.json({ ok: true, result, pictures: [] })
        : Response.json(result, { status });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

const bytes = () => Buffer.from(`<Project><Tasks>${randomUUID()}</Tasks></Project>`);

describe('a packaged reader through parseFileSheets', () => {
  it('a write is the sheets, with the description, by one pipelineRun job', async () => {
    const urls = stubParser({
      status: 'ok',
      calls: [
        {
          call: 'tool',
          tool: 'file_tabs_write',
          input: { tabs: [TAB], description: 'A plan.' },
        },
      ],
    });
    expect(await parseFileSheets(bytes(), 'xml', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [TAB],
      description: 'A plan.',
    });
    expect(urls).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it("not_mine is the reader's answer with no name: not-plan", async () => {
    stubParser({ status: 'not_mine' });
    expect(await parseFileSheets(bytes(), 'xml', { pipelines })).toEqual({ kind: 'not-plan' });
  });

  it('ok with no write is no sheets: the write spot gives no-rows', async () => {
    stubParser({ status: 'ok' });
    expect(await parseFileSheets(bytes(), 'xml', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [],
    });
  });

  it('a failed job is its word, unreadable; a result the check refuses too', async () => {
    stubParser({ ok: false, error: { code: 'failed', message: 'failed' } }, 422);
    expect(await parseFileSheets(bytes(), 'xml', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
    stubParser({ status: 'ok', calls: [{ call: 'tool', tool: 'file_tabs_write', input: {} }] });
    expect(await parseFileSheets(bytes(), 'xml', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });

  it("a hostile answer that skips the job's own check ends as a typed failure with its word, never a throw that retries", async () => {
    const write = (input: Record<string, unknown>) => ({
      status: 'ok',
      calls: [{ call: 'tool', tool: 'file_tabs_write', input: { tabs: [TAB], ...input } }],
    });
    const hostile: unknown[] = [
      { status: 'ok', warnings: 5 },
      { status: 'ok', counts: { rows: 'many' } },
      { status: 'ok', confidence: 'high' },
      write({ description: {} }),
      write({ ftsSkipColumns: 'Svg' }),
      write({ sourceSha256: 7 }),
      write({ text: ['a'] }),
      write({ pictures: [{ file: 1, mime: 'image/png' }] }),
      write({ tabs: [{ ...TAB, rows: [[{ evil: true }]] }] }),
    ];
    for (const result of hostile) {
      stubParser(result);
      expect(await parseFileSheets(bytes(), 'xml', { pipelines }), JSON.stringify(result)).toEqual({
        kind: 'none',
        word: 'unreadable',
      });
    }
  });

  it('a picture named __proto__ is a picture, not a key of a prototype', async () => {
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          result: { status: 'ok' },
          pictures: [{ file: '__proto__', bytes_base64: Buffer.from('x').toString('base64') }],
        }),
      ),
    );
    const { parserPipelineRun, PIPELINE_API } = await import('@mantle/files');
    const out = await parserPipelineRun(
      bytes(),
      { id: 'plan-mspdi', version: '1.0.0' },
      {
        api: PIPELINE_API,
        step: 1,
        options: {},
      },
    );
    expect(out.pictures.get('__proto__')?.toString()).toBe('x');
    expect(Object.getPrototypeOf(out.pictures)).toBe(Map.prototype);
  });

  it('a reader that ends unsure or failed is no rows over a database: unreadable', async () => {
    for (const status of ['unsure', 'failed']) {
      stubParser({ status });
      expect(await parseFileSheets(bytes(), 'xml', { pipelines }), status).toEqual({
        kind: 'none',
        word: 'unreadable',
      });
    }
    const { parsedFileOfRun } = await import('./file-database');
    expect(() => parsedFileOfRun({ match: { ext: ['xml'] } }, { status: 'unsure' })).toThrow(
      /status unsure/,
    );
  });

  it('options: readSheets adds the options hash, the in-process mapping does not, and the golden form is the same', async () => {
    // One answer for both jobs of a PDF: the router reads its `kind`, the
    // reader its write.
    const result = {
      status: 'ok',
      kind: 'pid',
      calls: [{ call: 'tool', tool: 'file_tabs_write', input: { tabs: [TAB] } }],
    } as const;
    stubParser(result);
    const viaCore = await parseFileSheets(bytes(), 'pdf', {
      pipelines,
      options: { title_block_width_mm: 100 },
    });
    // The proof: the old path's read carries the hash of the options in
    // force (for the stamp); the step's own result does not.
    expect(viaCore).toMatchObject({ kind: 'sheets', optionsHash: expect.any(String) });
    const inProcess = parsedFileOfRun(
      { match: { ext: ['pdf'] } },
      {
        status: 'ok',
        write: { tabs: [TAB] },
      },
    );
    expect(inProcess).not.toHaveProperty('optionsHash');
    // The golden file is of the rows; the options are the stamp's, which the
    // compare test checks with pipelineStampOf.
    expect(goldenOf(viaCore)).toBe(goldenOf(inProcess));
  });

  it('a retryable failure throws, as for every reader', async () => {
    stubParser({ ok: false, error: { code: 'timeout', message: 'timeout' } }, 504);
    await expect(parseFileSheets(bytes(), 'xml', { pipelines })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('a CAD drawing reads by one pipelineRun job of drawing-cad, and bytes that are not one by none', async () => {
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    const urls: string[] = [];
    const answer = inProcessPipelineFetch(undefined, {
      cadRender: async () => ({ layers: [], texts: [], blocks: [] }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        urls.push(String(url));
        return answer(url, init);
      }),
    );
    const dwg = Buffer.from(`AC1032 ${randomUUID()}`);
    expect(await parseFileSheets(dwg, 'dwg', { pipelines })).toMatchObject({
      kind: 'sheets',
      sheets: [],
    });
    expect(urls).toEqual(['http://parser.test:8095/pipeline/run']);
    // The old adapter's sniff stays in the core: no job.
    expect(await parseFileSheets(Buffer.from('not a drawing'), 'dwg', { pipelines })).toMatchObject(
      {
        kind: 'sheets',
        sheets: [],
        ftsSkipColumns: ['SVG', 'Path', 'Text lines'],
      },
    );
    expect(urls).toHaveLength(1);
  });
});
