/**
 * What a file's bytes earn, before anything is written: its sheets, the word
 * for a verdict on the document, or a throw for an error that says nothing
 * about the document, which the extract retries. The parser is faked at the
 * fetch; no database. The writes are file-database.db.test.ts, in server/api.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isParserError, resetParserFailures, withParserScope } from '@mantle/files';
import { parseFileSheets } from './file-database';

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

describe('a CSV, read in this process', () => {
  it('gives its sheets', async () => {
    const parsed = await parseFileSheets(Buffer.from('tag,size\nP-101,50\n'), 'csv');
    expect(parsed.kind).toBe('sheets');
  });

  it('a stray quote is unreadable, and not a throw', async () => {
    expect(await parseFileSheets(Buffer.from('tag,size\n"P-101,50\n'), 'csv')).toEqual({
      kind: 'none',
      word: 'unreadable',
    });
  });

  it('past the cap with no Table wanted: too-large with no read', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    // A stray quote would be unreadable if it were read.
    const big = Buffer.concat([Buffer.from('tag\n"x\n'), Buffer.alloc(1024 * 1024 + 1, 0x61)]);
    expect(await parseFileSheets(big, 'csv')).toEqual({ kind: 'none', word: 'too-large' });
  });

  it('past the cap with a Table wanted: read as before', async () => {
    vi.stubEnv('MANTLE_FILE_DB_CSV_MAX_MB', '1');
    const big = Buffer.concat([Buffer.from('tag\n'), Buffer.alloc(1024 * 1024 + 1, 0x61)]);
    const parsed = await parseFileSheets(big, 'csv', { tableWanted: true });
    expect(parsed.kind).toBe('sheets');
  });
});

describe('a workbook, read by the parser', () => {
  it('gives its sheets', async () => {
    stubParser(() => Response.json({ sheets: [SHEET], plan: null }));
    expect(await parseFileSheets(bytes(), 'xlsx')).toEqual({ kind: 'sheets', sheets: [SHEET] });
  });

  it('a final too_large is too-large', async () => {
    stubParser(failing('too_large', 413, true));
    expect(await parseFileSheets(bytes(), 'xlsx')).toEqual({ kind: 'none', word: 'too-large' });
  });

  it('a second too_large is terminal: too-large', async () => {
    stubParser(failing('too_large', 413));
    const b = bytes();
    await expect(parseFileSheets(b, 'xlsx')).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'xlsx')).toEqual({ kind: 'none', word: 'too-large' });
  });

  it('any other non-retryable failure is unreadable', async () => {
    for (const [code, status] of [
      ['failed', 422],
      ['unsupported', 415],
    ] as const) {
      stubParser(failing(code, status));
      expect(await parseFileSheets(bytes(), 'xlsx'), code).toEqual({
        kind: 'none',
        word: 'unreadable',
      });
    }
  });

  it('a second timeout is terminal: unreadable', async () => {
    stubParser(failing('timeout', 504));
    const b = bytes();
    await expect(parseFileSheets(b, 'xlsx')).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'xlsx')).toEqual({ kind: 'none', word: 'unreadable' });
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
      await expect(parseFileSheets(bytes(), 'xlsx'), code).rejects.toMatchObject({ code });
    }
  });

  it('throws when the failure ledger throws on a database blip', async () => {
    stubParser(() => Response.json({ sheets: [SHEET], plan: null }));
    const failures = {
      get: async () => {
        throw new Error('database blip');
      },
      add: async () => 1,
    };
    await expect(
      withParserScope({ failures }, () => parseFileSheets(bytes(), 'xlsx')),
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
      withParserScope({ failures }, () => parseFileSheets(dwg(), 'dwg')),
    ).rejects.toMatchObject({ retryable: true, terminal: false });
    expect(calls).not.toHaveBeenCalled();
  });

  it('throws, retryable, when the failure ledger throws on a count', async () => {
    stubParser(failing('timeout', 504));
    const failures = { get: async () => null, add: blip };
    await expect(
      withParserScope({ failures }, () => parseFileSheets(dwg(), 'dwg')),
    ).rejects.toMatchObject({ retryable: true, terminal: false });
  });

  it('the retry reads it: the blip was kept for that extract only', async () => {
    stubParser(() => Response.json({ layers: [], texts: [], blocks: [] }));
    const b = dwg();
    await expect(
      withParserScope({ failures: { get: blip, add: async () => 1 } }, () =>
        parseFileSheets(b, 'dwg'),
      ),
    ).rejects.toSatisfy(isParserError);
    expect(await parseFileSheets(b, 'dwg')).toMatchObject({ kind: 'sheets' });
  });

  it('a verdict from the parser is still a word', async () => {
    stubParser(failing('failed', 422));
    expect(await parseFileSheets(dwg(), 'dwg')).toEqual({ kind: 'none', word: 'unreadable' });
  });
});

describe('an XML', () => {
  const PLAN = '<Project xmlns="http://schemas.microsoft.com/project"><Tasks></Tasks></Project>';

  it('with no Project root is not a plan, and asks no parser', async () => {
    const calls = stubParser(() => Response.json({}));
    expect(await parseFileSheets(Buffer.from('<Invoice></Invoice>'), 'xml')).toEqual({
      kind: 'not-plan',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('with a Project root that fails the full sniff is no-rows, and asks no parser', async () => {
    const calls = stubParser(() => Response.json({}));
    expect(await parseFileSheets(Buffer.from('<Project><Name>x</Name></Project>'), 'xml')).toEqual({
      kind: 'none',
      word: 'no-rows',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('a plan gives its sheets and the words a reader needs', async () => {
    stubParser(() => Response.json({ sheets: [SHEET], plan: { taskCount: 3, summaryCount: 1 } }));
    const parsed = await parseFileSheets(Buffer.from(PLAN), 'xml');
    expect(parsed).toMatchObject({ kind: 'sheets', sheets: [SHEET] });
    expect(parsed.kind === 'sheets' && parsed.description).toMatch(/1 of 3 rows in Tasks/);
  });
});

describe('a PDF, read as a drawing by the parser', () => {
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
  const answer =
    (kind: string, pageKind = kind, sample = '') =>
    () =>
      Response.json({
        ok: true,
        numPages: 1,
        pageCountMayBeShort: false,
        allRead: true,
        kind,
        pages: [page(pageKind, kind === 'document' ? 'text' : 'vector_text')],
        sample,
      });
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
    stubParser(answer('pid'));
    const decide = vi.fn(async (_drawing: unknown) => decision('document'));
    const parsed = await parseFileSheets(bytes(), 'pdf', { pdfKind: decide });
    expect(parsed.kind).toBe('sheets');
    if (parsed.kind !== 'sheets') return;
    expect(parsed.sheets.map((s) => s.name)).toEqual(['File', 'Pages']);
    expect(fileRow(parsed)).toMatchObject({ Kind: 'pid', 'Kind source': 'rules' });
    expect(parsed.description).toContain('piping and instrument diagram');
    expect(decide).not.toHaveBeenCalled();
  });

  it('a document by the rules gets no name, and no decider call', async () => {
    stubParser(answer('document'));
    const decide = vi.fn(async (_drawing: unknown) => decision('pid'));
    expect(await parseFileSheets(bytes(), 'pdf', { pdfKind: decide })).toEqual({
      kind: 'not-drawing',
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it('an unsure file is put to the decider once, and takes a usable answer', async () => {
    stubParser(answer('unsure', 'unsure', 'MADE UP TITLE'));
    const decide = vi.fn(async (_drawing: unknown) => decision('equipment_drawing'));
    const parsed = await parseFileSheets(bytes(), 'pdf', { pdfKind: decide });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toMatchObject({ kind: 'unsure', sample: 'MADE UP TITLE' });
    expect(fileRow(parsed)).toMatchObject({
      Kind: 'equipment_drawing',
      'Kind source': 'decider',
      'Rules kind': 'unsure',
    });
  });

  it('a shadow answer is kept beside the kind and not used', async () => {
    stubParser(answer('unsure'));
    const parsed = await parseFileSheets(bytes(), 'pdf', {
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
    stubParser(answer('unsure'));
    expect(fileRow(await parseFileSheets(bytes(), 'pdf'))).toMatchObject({
      Kind: 'unsure',
      'Decider answer': null,
    });
  });

  it('a file the decider calls a document gets the word no-rows: asked once, no database', async () => {
    stubParser(answer('unsure'));
    expect(
      await parseFileSheets(bytes(), 'pdf', { pdfKind: async () => decision('document') }),
    ).toEqual({ kind: 'none', word: 'no-rows' });
    // Not used (shadow): the file keeps its database, with the answer in it.
    stubParser(answer('unsure'));
    const shadow = await parseFileSheets(bytes(), 'pdf', {
      pdfKind: async () => decision('document', false),
    });
    expect(shadow.kind).toBe('sheets');
  });

  it("the parser's verdict on the bytes is a word; an answer in another shape is unreadable", async () => {
    stubParser(failing('too_large', 413, true));
    expect(await parseFileSheets(bytes(), 'pdf')).toEqual({ kind: 'none', word: 'too-large' });
    stubParser(() => Response.json({ ok: true, numPages: 1, kind: 'novel', pages: [] }));
    expect(await parseFileSheets(bytes(), 'pdf')).toEqual({ kind: 'none', word: 'unreadable' });
    stubParser(() =>
      Response.json({ ok: true, numPages: 1, kind: 'pid', pages: [{ page: 1, kind: 'x' }] }),
    );
    expect(await parseFileSheets(bytes(), 'pdf')).toEqual({ kind: 'none', word: 'unreadable' });
  });

  it('a busy parser throws: no word, and the extract decides', async () => {
    stubParser(failing('unavailable', 503));
    await expect(parseFileSheets(bytes(), 'pdf')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
