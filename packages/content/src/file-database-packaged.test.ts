/**
 * A packaged built-in (`runtime: 'bun'`) reaches the one read of a file's
 * database (readSheets, through parseFileSheets) with no change in its
 * callers: pipeline_test and the extract call parseFileSheets as before. The
 * plan reader is made a package here only in this test (no reader has moved
 * in MV0), and the parser is faked at the fetch. The write of such a read
 * is file-database.db.test.ts in server/api; the real parser job is
 * ./pipeline-runner.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetParserFailures } from '@mantle/files';
import { parseFileSheets } from './file-database';

vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    builtinForExt: (ext: string) => {
      const p = actual.builtinForExt(ext);
      return p && ext === 'xml' ? { ...p, runtime: 'bun', entry: 'step.ts' } : p;
    },
  };
});

const TAB = { name: 'Tasks', columns: [{ name: 'Name', type: 'text' }], rows: [['Dig']] };

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

const bytes = () => Buffer.from(`<Project>${randomUUID()}</Project>`);

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
    expect(await parseFileSheets(bytes(), 'xml')).toEqual({
      kind: 'sheets',
      sheets: [TAB],
      description: 'A plan.',
    });
    expect(urls).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it("not_mine is the reader's answer with no name: not-plan", async () => {
    stubParser({ status: 'not_mine' });
    expect(await parseFileSheets(bytes(), 'xml')).toEqual({ kind: 'not-plan' });
  });

  it('ok with no write is no sheets: the write spot gives no-rows', async () => {
    stubParser({ status: 'ok' });
    expect(await parseFileSheets(bytes(), 'xml')).toEqual({ kind: 'sheets', sheets: [] });
  });

  it('a failed job is its word, unreadable; a result the check refuses too', async () => {
    stubParser({ ok: false, error: { code: 'failed', message: 'failed' } }, 422);
    expect(await parseFileSheets(bytes(), 'xml')).toEqual({ kind: 'none', word: 'unreadable' });
    stubParser({ status: 'ok', calls: [{ call: 'tool', tool: 'file_tabs_write', input: {} }] });
    expect(await parseFileSheets(bytes(), 'xml')).toEqual({ kind: 'none', word: 'unreadable' });
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
      write({ tabs: [{ ...TAB, rows: [[Number.NaN]] }] }),
    ];
    for (const result of hostile) {
      stubParser(result);
      expect(await parseFileSheets(bytes(), 'xml'), JSON.stringify(result)).toEqual({
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
    const out = await parserPipelineRun(bytes(), 'plan-mspdi', {
      api: PIPELINE_API,
      step: 1,
      options: {},
    });
    expect(out.pictures.get('__proto__')?.toString()).toBe('x');
    expect(Object.getPrototypeOf(out.pictures)).toBe(Map.prototype);
  });

  it('a reader that ends unsure or failed is no rows over a database: unreadable', async () => {
    for (const status of ['unsure', 'failed']) {
      stubParser({ status });
      expect(await parseFileSheets(bytes(), 'xml'), status).toEqual({
        kind: 'none',
        word: 'unreadable',
      });
    }
    const { parsedFileOfRun } = await import('./file-database');
    expect(() => parsedFileOfRun({ match: { ext: ['xml'] } }, { status: 'unsure' })).toThrow(
      /status unsure/,
    );
  });

  it('a retryable failure throws, as for every reader', async () => {
    stubParser({ ok: false, error: { code: 'timeout', message: 'timeout' } }, 504);
    await expect(parseFileSheets(bytes(), 'xml')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a reader still on core is untouched: a workbook reads by grid', async () => {
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return Response.json({ sheets: [TAB], plan: null });
      }),
    );
    expect(await parseFileSheets(bytes(), 'xlsx')).toEqual({ kind: 'sheets', sheets: [TAB] });
    expect(urls).toEqual(['http://parser.test:8095/grid']);
  });
});
