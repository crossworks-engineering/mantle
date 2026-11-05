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
