/**
 * The Data view's route, POST /api/files/files/:id/database: a thin door over
 * file_sql's one answer (fileSqlAnswer). This pins how each answer goes out:
 * the tabs and the rows at 200 with their `kind`, no database at 200 with the
 * words, a file the caller cannot read at 404 with no words about it, a refusal
 * at 403, a statement that fails at 400. The rights and the rows themselves are
 * pinned on a real database by server/web/server/file-sql.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({ answer: vi.fn(), readBy: vi.fn() }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ownerCaller: vi.fn(() => ({ id: OWNER })),
}));

vi.mock('@mantle/tools', () => ({ fileSqlAnswer: h.answer, fileReadBy: h.readBy }));

const post = (body: unknown) =>
  new Request(`http://brain.example/api/files/files/${FILE}/database`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const ctx = { params: Promise.resolve({ id: FILE }) };

/** A handler's answer as the app gives it: a thrown error by app.onError. */
async function answered(res: Promise<Response>): Promise<Response> {
  try {
    return await res;
  } catch (err) {
    const { answerAppError } = await import('@/server/app-error');
    return answerAppError(
      err as Error,
      { req: { url: 'http://brain.example/api/files', method: 'POST' } } as never,
    );
  }
}

beforeEach(() => {
  h.answer.mockReset();
  h.readBy.mockReset();
  h.readBy.mockResolvedValue(null);
});

describe('POST /api/files/files/:id/database', () => {
  it('with no sql asks for the tabs, and answers them with kind describe', async () => {
    h.answer.mockResolvedValue({
      kind: 'describe',
      output: { file_id: FILE, title: 'v.csv', tabs: [], hint: 'h' },
    });
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({}), ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      kind: 'describe',
      file_id: FILE,
      title: 'v.csv',
      tabs: [],
      hint: 'h',
      readBy: null,
    });
    expect(h.answer).toHaveBeenCalledWith(
      OWNER,
      { fileId: FILE, sql: '', cap: undefined },
      { tableHint: true },
    );
    expect(h.readBy).toHaveBeenCalledWith(OWNER, FILE);
  });

  it('the tabs carry readBy, the pipeline and version of the stamp', async () => {
    h.answer.mockResolvedValue({
      kind: 'describe',
      output: { file_id: FILE, title: 'v.csv', tabs: [], hint: 'h' },
    });
    h.readBy.mockResolvedValue({ pipeline: 'sheet', version: '1.0.0' });
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({}), ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'describe',
      readBy: { pipeline: 'sheet', version: '1.0.0' },
    });
  });

  it('with sql passes it and the row cap on, and answers the rows', async () => {
    h.answer.mockResolvedValue({
      kind: 'rows',
      output: { file_id: FILE, columns: ['a'], rows: [[1]], row_count: 1, duration_ms: 2 },
    });
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({ sql: 'SELECT 1 AS a', max_rows: 5 }), ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'rows', rows: [[1]] });
    expect(h.answer).toHaveBeenCalledWith(
      OWNER,
      { fileId: FILE, sql: 'SELECT 1 AS a', cap: 5 },
      { tableHint: true },
    );
  });

  it('a file with no database is a state, not a failure: 200 with the words', async () => {
    h.answer.mockResolvedValue({ kind: 'none', message: 'No database yet.' });
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({}), ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'none', file_id: FILE, reason: 'No database yet.' });
  });

  it('a file the caller cannot read is a 404 that says nothing about it', async () => {
    h.answer.mockResolvedValue({ kind: 'not-found', message: 'file not found: use file_list' });
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({}), ctx));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('a refusal is a 403 with its words, a failed statement a 400', async () => {
    const { POST } = await import('./files/[id]/database/route');
    h.answer.mockResolvedValue({ kind: 'refused', message: 'only an Admin user' });
    const refused = await answered(POST(post({}), ctx));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'only an Admin user' });
    h.answer.mockResolvedValue({ kind: 'bad-sql', message: 'no such column: nope' });
    const bad = await answered(POST(post({ sql: 'SELECT nope' }), ctx));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'no such column: nope' });
  });

  it('a body past the row cap is the one 400, and asks nothing', async () => {
    const { POST } = await import('./files/[id]/database/route');
    const res = await answered(POST(post({ max_rows: 100_000 }), ctx));
    expect(res.status).toBe(400);
    expect(h.answer).not.toHaveBeenCalled();
  });

  it('asks as a person, who may be pointed at an old Table', async () => {
    h.answer.mockResolvedValue({ kind: 'none', message: 'Its rows are in Table x.' });
    const { POST } = await import('./files/[id]/database/route');
    await answered(POST(post({}), ctx));
    expect(h.answer).toHaveBeenCalledWith(OWNER, expect.anything(), { tableHint: true });
  });
});
