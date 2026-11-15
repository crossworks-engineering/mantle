/**
 * What a file's bytes earn, before anything is written: its sheets, the word
 * for a verdict on the document, or a throw for an error that says nothing
 * about the document, which the extract retries. The parser is faked at the
 * fetch; no database. The writes are file-database.db.test.ts, in server/api.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isParserError, resetParserFailures, withParserScope } from '@mantle/files';
import { inProcessPipelineFetch } from '@mantle/files/pipelines/test-job';
import { parseFileSheets } from './file-database';
import { boxPipelines } from './pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = await boxPipelines('made-up-owner');

/** Every parser job answers `res()`. */
function stubParser(res: () => Response) {
  vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
  const calls = vi.fn(async () => res());
  vi.stubGlobal('fetch', calls);
  return calls;
}
const failing =
  (code: string, status: number, final = false) =>
  () =>
    Response.json({ ok: false, error: { code, message: code, final } }, { status });
const bytes = () => Buffer.from(randomUUID());
const SHEET = { name: 'Sheet1', columns: [{ name: 'Tag', type: 'text' }], rows: [['P-101']] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetParserFailures();
});

/** A pipelineRun answer: the spreadsheet reader is the package `sheet`. */
const ranSheets = (sheets: unknown[]) => () =>
  Response.json({
    ok: true,
    result: {
      status: 'ok',
      calls: [{ call: 'tool', tool: 'file_tabs_write', input: { tabs: sheets } }],
    },
    pictures: [],
  });
const urlsOf = (calls: ReturnType<typeof stubParser>) =>
  calls.mock.calls.map((c) => String((c as unknown[])[0]));

describe('a CSV, read by the package sheet', () => {
  // The step's own rows are pinned on the real step
  // (pipeline-golden-sheet.test.ts) and through a real parser (the sheet
  // case of pipeline-runner.test.ts). Here: the core's part.
  it('gives its sheets, by one pipelineRun job', async () => {
    const calls = stubParser(ranSheets([SHEET]));
    expect(await parseFileSheets(Buffer.from('tag\nP-101\n'), 'csv', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [SHEET],
    });
    expect(urlsOf(calls)).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it('a failed job (a stray quote) is unreadable at once, and not a throw', async () => {
    stubParser(failing('failed', 422));
    expect(
      await parseFileSheets(Buffer.from('tag,size\n"P-101,50\n'), 'csv', { pipelines }),
    ).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });

  it('past the cap: too-large with no read and no parser job', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const calls = stubParser(ranSheets([SHEET]));
    const big = Buffer.concat([Buffer.from('tag\n'), Buffer.alloc(1024 * 1024 + 1, 0x61)]);
    expect(await parseFileSheets(big, 'csv', { pipelines })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
    expect(calls).not.toHaveBeenCalled();
  });
});

describe('a workbook, read by the package sheet', () => {
  it('gives its sheets, by one pipelineRun job', async () => {
    const calls = stubParser(ranSheets([SHEET]));
    expect(await parseFileSheets(bytes(), 'xlsx', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [SHEET],
    });
    expect(urlsOf(calls)).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  // The cap on delimited text is by what the reader does with the bytes,
  // not by the name (readsAsDelimited): text named .xlsx is held, a real
  // workbook is not.
  const MB = 1024 * 1024;
  it('text named .xlsx past the cap: too-large with no parser job', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const calls = stubParser(ranSheets([SHEET]));
    const big = Buffer.concat([Buffer.from('tag\n'), Buffer.alloc(MB + 1, 0x61)]);
    expect(await parseFileSheets(big, 'xlsx', { pipelines })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('a workbook (zip bytes) past the cap is not held by it: one job', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const calls = stubParser(ranSheets([SHEET]));
    const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(MB + 1)]);
    expect(await parseFileSheets(big, 'xlsx', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [SHEET],
    });
    expect(urlsOf(calls)).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it('text named .xls past the cap is not held by it: the reader converts it, as text never', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const calls = stubParser(failing('failed', 422));
    const big = Buffer.concat([Buffer.from('tag\n'), Buffer.alloc(MB + 1, 0x61)]);
    expect(await parseFileSheets(big, 'xls', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
    expect(urlsOf(calls)).toEqual(['http://parser.test:8095/pipeline/run']);
  });

  it('a final too_large is too-large', async () => {
    stubParser(failing('too_large', 413, true));
    expect(await parseFileSheets(bytes(), 'xlsx', { pipelines })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
  });

  it('a second too_large is terminal: too-large', async () => {
    stubParser(failing('too_large', 413));
    const b = bytes();
    await expect(parseFileSheets(b, 'xlsx', { pipelines })).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'xlsx', { pipelines })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
  });

  it('any other non-retryable failure is unreadable', async () => {
    for (const [code, status] of [
      ['failed', 422],
      ['unsupported', 415],
    ] as const) {
      stubParser(failing(code, status));
      expect(await parseFileSheets(bytes(), 'xlsx', { pipelines }), code).toEqual({
        kind: 'none',
        word: 'unreadable',
      });
    }
  });

  it('a second timeout is terminal: unreadable', async () => {
    stubParser(failing('timeout', 504));
    const b = bytes();
    await expect(parseFileSheets(b, 'xlsx', { pipelines })).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'xlsx', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });

  it('throws what says nothing about the document: retryable, unavailable, bad_request', async () => {
    for (const [code, status] of [
      ['timeout', 504],
      ['crashed', 500],
      ['too_large', 413],
      ['unavailable', 503],
      ['bad_request', 400],
    ] as const) {
      stubParser(failing(code, status));
      await expect(parseFileSheets(bytes(), 'xlsx', { pipelines }), code).rejects.toMatchObject({
        code,
      });
    }
  });

  it('throws when the failure ledger throws on a database blip', async () => {
    stubParser(ranSheets([SHEET]));
    const failures = {
      get: async () => {
        throw new Error('database blip');
      },
      add: async () => 1,
    };
    await expect(
      withParserScope({ failures }, () => parseFileSheets(bytes(), 'xlsx', { pipelines })),
    ).rejects.toThrow(/database blip/);
  });
});

describe('a drawing, whose failures come back through asResult', () => {
  const dwg = () => Buffer.from(`AC1032 ${randomUUID()}`);
  const blip = async () => {
    throw new Error('database blip');
  };

  it('throws, retryable, when the failure ledger throws on a read', async () => {
    const calls = stubParser(() => Response.json({}));
    const failures = { get: blip, add: async () => 1 };
    await expect(
      withParserScope({ failures }, () => parseFileSheets(dwg(), 'dwg', { pipelines })),
    ).rejects.toMatchObject({ retryable: true, terminal: false });
    expect(calls).not.toHaveBeenCalled();
  });

  it('throws, retryable, when the failure ledger throws on a count', async () => {
    stubParser(failing('timeout', 504));
    const failures = { get: async () => null, add: blip };
    await expect(
      withParserScope({ failures }, () => parseFileSheets(dwg(), 'dwg', { pipelines })),
    ).rejects.toMatchObject({ retryable: true, terminal: false });
  });

  it('the retry reads it: the blip was kept for that extract only', async () => {
    // A drawing is the package drawing-cad: its real step in this process.
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    vi.stubGlobal(
      'fetch',
      inProcessPipelineFetch(undefined, {
        cadRender: async () => ({ layers: [], texts: [], blocks: [] }),
      }),
    );
    const b = dwg();
    await expect(
      withParserScope({ failures: { get: blip, add: async () => 1 } }, () =>
        parseFileSheets(b, 'dwg', { pipelines }),
      ),
    ).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'dwg', { pipelines })).toMatchObject({ kind: 'sheets' });
  });

  it('a verdict from the parser is still a word', async () => {
    stubParser(failing('failed', 422));
    expect(await parseFileSheets(dwg(), 'dwg', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });
});

describe('an XML, read by the package plan-mspdi', () => {
  // The step's own answers are pinned on the real step
  // (pipeline-golden-plan-mspdi.test.ts) and through a real parser (the
  // plan-mspdi case of pipeline-runner.test.ts). Here: the plan check on the
  // bytes in hand runs in the core, before any job, for every caller (the
  // old adapter's first lines); a plan costs one pipelineRun job, never the
  // grid job, and its answer is mapped.
  const PLAN = `<Project xmlns="http://schemas.microsoft.com/project"><Tasks>${randomUUID()}</Tasks></Project>`;
  const ran = (result: unknown) => () => Response.json({ ok: true, result, pictures: [] });

  it('with no Project root is not a plan, and asks no parser', async () => {
    const calls = stubParser(() => Response.json({}));
    expect(await parseFileSheets(Buffer.from('<Invoice></Invoice>'), 'xml', { pipelines })).toEqual(
      {
        kind: 'not-plan',
      },
    );
    expect(calls).not.toHaveBeenCalled();
  });

  it('with a Project root that fails the full sniff is no-rows, and asks no parser', async () => {
    const calls = stubParser(() => Response.json({}));
    expect(
      await parseFileSheets(Buffer.from('<Project><Name>x</Name></Project>'), 'xml', { pipelines }),
    ).toEqual({
      kind: 'none',
      word: 'no-rows',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('a plan is one pipelineRun job: its sheets and its description', async () => {
    const calls = stubParser(
      ran({
        status: 'ok',
        calls: [
          {
            call: 'tool',
            tool: 'file_tabs_write',
            input: { tabs: [SHEET], description: 'Microsoft Project plan.' },
          },
        ],
      }),
    );
    expect(await parseFileSheets(Buffer.from(PLAN), 'xml', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [SHEET],
      description: 'Microsoft Project plan.',
    });
    expect(calls.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      'http://parser.test:8095/pipeline/run',
    ]);
  });

  it("the step's not_mine is not-plan; ok with no tabs is no sheets, the write spot's no-rows", async () => {
    stubParser(ran({ status: 'not_mine' }));
    expect(await parseFileSheets(Buffer.from(PLAN), 'xml', { pipelines })).toEqual({
      kind: 'not-plan',
    });
    stubParser(ran({ status: 'ok' }));
    expect(await parseFileSheets(Buffer.from(PLAN), 'xml', { pipelines })).toEqual({
      kind: 'sheets',
      sheets: [],
    });
  });
});

describe('a PDF, read by the packages pdf-router and drawing-pdf', () => {
  /** A made-up fixture of the PDF set, and the parser's pipelineRun job run
   *  in this process on it (no OpenCV, no picture: as the host lane). */
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
  const inProcess = () => {
    vi.stubEnv('PARSER_URL', 'http://parser.test:8095');
    const calls = vi.fn(inProcessPipelineFetch());
    vi.stubGlobal('fetch', calls);
    return calls;
  };
  const decision = (kind: string, used = true) => ({
    kind,
    confidence: 0.9,
    model: 'm',
    mode: used ? ('live' as const) : ('shadow' as const),
    used,
  });
  const fileRow = (parsed: Awaited<ReturnType<typeof parseFileSheets>>) => {
    if (parsed.kind !== 'sheets') throw new Error(`parsed ${parsed.kind}`);
    const file = parsed.sheets[0]!;
    return Object.fromEntries(file.columns.map((c, i) => [c.name, file.rows[0]![i]]));
  };

  it('a P&ID by the rules gets its File and Pages tabs, with no decider call', async () => {
    inProcess();
    const decide = vi.fn(async (_state: unknown) => decision('document'));
    const parsed = await parseFileSheets(pdf('pid.pdf'), 'pdf', { pipelines, pdfKind: decide });
    expect(parsed.kind).toBe('sheets');
    if (parsed.kind !== 'sheets') return;
    expect(parsed.sheets.map((s) => s.name).slice(0, 2)).toEqual(['File', 'Pages']);
    expect(fileRow(parsed)).toMatchObject({ Kind: 'pid', 'Kind source': 'rules' });
    expect(parsed.description).toContain('piping and instrument diagram');
    expect(decide).not.toHaveBeenCalled();
  });

  it('a document by the rules gets no name, and no decider call: one job', async () => {
    const calls = inProcess();
    const decide = vi.fn(async (_state: unknown) => decision('pid'));
    expect(
      await parseFileSheets(pdf('document.pdf'), 'pdf', { pipelines, pdfKind: decide }),
    ).toEqual({
      kind: 'not-drawing',
    });
    expect(decide).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('an unsure file is put to the decider once, with counts and the sample only, and takes a usable answer', async () => {
    inProcess();
    const decide = vi.fn(async (_state: unknown) => decision('equipment_drawing'));
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      pdfKind: decide,
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(Object.keys(decide.mock.calls[0]![0] as object).sort()).toEqual([
      'instrument_tags',
      'line_numbers',
      'page_classes',
      'page_sizes',
      'pages',
      'tag_like_tokens',
      'text_sample',
    ]);
    expect(fileRow(parsed)).toMatchObject({
      Kind: 'equipment_drawing',
      'Kind source': 'decider',
      'Rules kind': 'unsure',
    });
  });

  it('a shadow answer is kept beside the kind and not used', async () => {
    inProcess();
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      pdfKind: async () => decision('pid', false),
    });
    expect(fileRow(parsed)).toMatchObject({
      Kind: 'unsure',
      'Kind source': 'rules',
      'Decider answer': 'pid',
      'Decider mode': 'shadow',
    });
  });

  it('with no decider (a rebuild) an unsure file stays unsure: no model call can start', async () => {
    inProcess();
    expect(
      fileRow(await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', { pipelines })),
    ).toMatchObject({
      Kind: 'unsure',
      'Decider answer': null,
    });
  });

  it('a file the decider calls a document gets the word no-rows: asked once, no database', async () => {
    inProcess();
    expect(
      await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
        pipelines,
        pdfKind: async () => decision('document'),
      }),
    ).toEqual({ kind: 'none', word: 'no-rows' });
    // Not used (shadow): the file keeps its database, with the answer in it.
    const shadow = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      pdfKind: async () => decision('document', false),
    });
    expect(shadow.kind).toBe('sheets');
  });

  it('a read again keeps the stored kind and decision: the router does not run, one job, no ask', async () => {
    const calls = inProcess();
    const decide = vi.fn(async () => decision('pid'));
    const parsed = await parseFileSheets(pdf('unsure-vector.pdf'), 'pdf', {
      pipelines,
      pdfKind: decide,
      pdfStored: { kind: 'pfd', decision: decision('pfd') },
    });
    expect(fileRow(parsed)).toMatchObject({
      Kind: 'pfd',
      'Kind source': 'decider',
      'Rules kind': 'unsure',
      'Decider answer': 'pfd',
      'Decider mode': 'live',
    });
    expect(decide).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("the parser's verdict on the bytes is a word; a router answer with no kind is unreadable", async () => {
    stubParser(failing('too_large', 413, true));
    expect(await parseFileSheets(bytes(), 'pdf', { pipelines })).toEqual({
      kind: 'none',
      word: 'too-large',
    });
    resetParserFailures();
    stubParser(() => Response.json({ ok: true, result: { status: 'ok' }, pictures: [] }));
    expect(await parseFileSheets(bytes(), 'pdf', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
    resetParserFailures();
    stubParser(() => Response.json({ ok: true, result: { status: 'novel' }, pictures: [] }));
    expect(await parseFileSheets(bytes(), 'pdf', { pipelines })).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });

  it('a busy parser throws: no word, and the extract decides', async () => {
    stubParser(failing('unavailable', 503));
    await expect(parseFileSheets(bytes(), 'pdf', { pipelines })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
