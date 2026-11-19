/**
 * `file_reindex` and reindexFiles (docs/files.md 8d), with no Postgres: the
 * file rows, the rights, the queue and the bytes are stand-ins. The edit
 * check, the busy check and the drop on a real row are proven on Postgres
 * (server/web/app/api/files/file-reindex-route.db.test.ts).
 *
 *  - The tool has pipeline_run's marks (audit r1 M1): MCP only (no tool
 *    group), peer risky, forbidden in a recipe, and not idempotent.
 *  - A file with no bytes is skipped `bytes-missing`, and nothing is written
 *    for it; the others are queued (audit r1 M2).
 *  - An API key without the Search area does not reach an email attachment
 *    on MCP: it is `not-found`, and nothing is written (audit r1 LOW 4).
 *  - A PDF whose database holds its sketch read keeps that read's text
 *    (text, ocr, vision_model); every other file drops it (audit r2 M).
 *  - So does a PDF whose database is there but whose File tab cannot be
 *    read now (fail closed, audit r3 L1), and a PDF told by its mimeType
 *    with no `.pdf` in its name (audit r3 L2). The File tab is read through
 *    the real pdfTextKeptOf; only the reader pool is a stand-in.
 *  - A queue that cannot be read (a grant missing on a fresh box) is a
 *    clear 503 domain error, and nothing is written.
 */
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-000000000000';
const A = 'aa000000-0000-4000-8000-000000000001';
const B = 'bb000000-0000-4000-8000-000000000002';
const MAIL = 'cc000000-0000-4000-8000-000000000003';

const h = vi.hoisted(() => ({
  rows: [] as {
    id: string;
    title: string;
    path: string;
    home: null;
    filename: string;
    sha256: null;
    mimeType: string | null;
    data: Record<string, unknown>;
  }[],
  gone: new Set<string>(),
  mail: new Set<string>(),
  keyNoSearch: false,
  updated: 0,
  changed: [] as string[],
  /** The database of a file, by id: its File tab says a sketch read, says
   *  none, or cannot be read (the reader pool throws). */
  dbs: new Map<string, 'sketch' | 'plain' | 'unreadable'>(),
  sets: [] as unknown[],
}));

vi.mock('@mantle/db', async (orig) => ({
  ...(await orig<typeof import('@mantle/db')>()),
  db: {
    select: () => ({ from: () => ({ where: async () => h.rows }) }),
  },
  itemWriteVerdicts: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, 'ok']))),
  extractJobsFor: vi.fn(async () => new Map()),
  extractQueueBusy: vi.fn(async () => false),
  withDeadlockRetry: <T>(fn: () => Promise<T>) => fn(),
  withHeads: async (_ids: readonly string[], _m: string, fn: (tx: unknown) => Promise<void>) =>
    fn({
      update: () => ({
        set: (v: { data: unknown }) => ({
          where: async () => {
            h.sets.push(v.data);
            h.updated += 1;
          },
        }),
      }),
    }),
  markContentChanged: vi.fn(async (_tx: unknown, node: { id: string }) => {
    h.changed.push(node.id);
    return null;
  }),
  notifyPipelineRun: vi.fn(async () => {}),
}));

vi.mock('@mantle/files', async (orig) => ({
  ...(await orig<typeof import('@mantle/files')>()),
  keyWithoutSearch: () => h.keyNoSearch,
  emailAttachmentIds: vi.fn(
    async (_o: string, ids: readonly string[]) => new Set(ids.filter((id) => h.mail.has(id))),
  ),
  loadFileHead: vi.fn(async (node: { id: string }) =>
    h.gone.has(node.id) ? null : Buffer.from('x'),
  ),
  fileDbNameExists: vi.fn(async () => false),
  fileDbSqlitePath: vi.fn(async (id: string) => (h.dbs.has(id) ? `/made-up/${id}` : null)),
}));

vi.mock('@mantle/tabledb', async (orig) => ({
  ...(await orig<typeof import('@mantle/tabledb')>()),
  runTableSql: vi.fn(async (abs: string) => {
    const state = h.dbs.get(abs.split('/').pop()!);
    if (state === 'unreadable') throw new Error('the reader pool is busy');
    return {
      columns: ['Kind', 'Rules kind', 'Vision read'],
      rows: [['scan', 'scan', state === 'sketch' ? 1 : 0]],
    };
  }),
}));

vi.mock('@mantle/content/pipeline-registry', () => ({
  boxPipelines: async () => ({ readerFor: () => null }),
}));

const { file_reindex, reindexFiles, ReindexQueueUnreadError } = await import('./reindex');
const dbMock = await import('@mantle/db');
const { domainErrorAnswer } = await import('@mantle/std');
const { PgDialect } = await import('drizzle-orm/pg-core');

/** The bound values of the one update's drop: the sketched ids, then the
 *  keys a sketched file drops, then the keys every other file drops. */
const dropOf = () => {
  const q = new PgDialect().sqlToQuery(h.sets[0] as SQL);
  const [ids, ...keys] = q.params as string[];
  return { ids, keys };
};

const row = (id: string, filename: string, mimeType: string | null = null) => ({
  id,
  title: filename,
  path: 'files.made-up',
  home: null,
  filename,
  sha256: null,
  mimeType,
  data: { filename },
});

beforeEach(() => {
  h.rows = [row(A, 'a.txt'), row(B, 'b.txt'), row(MAIL, 'mail.pdf')];
  h.gone = new Set();
  h.mail = new Set([MAIL]);
  h.keyNoSearch = false;
  h.updated = 0;
  h.changed = [];
  h.dbs = new Map();
  h.sets = [];
});

describe('file_reindex has the marks of pipeline_run', () => {
  it('is MCP only, peer risky, forbidden in a recipe, and not idempotent', () => {
    expect(file_reindex.mcpOnly).toBe(true);
    expect(file_reindex.policy).toMatchObject({
      matrix: { action: 'edit', param: 'file_ids', kinds: ['file'] },
      effect: 'write',
      spends: 'none',
      peerRisky: true,
      recipe: { step: 'forbidden' },
    });
    expect(file_reindex.policy).not.toHaveProperty('idempotent');
  });
});

describe('reindexFiles', () => {
  it('skips a file with no bytes as bytes-missing and writes nothing for it', async () => {
    h.gone = new Set([B]);
    const got = await reindexFiles(OWNER, [A, B]);
    expect(got).toEqual({ queued: 1, databases: 0, skipped: [{ id: B, reason: 'bytes-missing' }] });
    expect(h.changed).toEqual([A]);
    expect(h.updated).toBe(1);
  });

  it('writes nothing at all when no file has its bytes', async () => {
    h.gone = new Set([A, B]);
    const got = await reindexFiles(OWNER, [A, B]);
    expect(got.queued).toBe(0);
    expect(got.skipped.map((s) => s.reason)).toEqual(['bytes-missing', 'bytes-missing']);
    expect(h.updated).toBe(0);
    expect(h.changed).toEqual([]);
  });

  it('a key without Search gets an email attachment as not-found; other callers reach it', async () => {
    h.keyNoSearch = true;
    const got = await reindexFiles(OWNER, [A, MAIL]);
    expect(got).toEqual({ queued: 1, databases: 0, skipped: [{ id: MAIL, reason: 'not-found' }] });
    expect(h.changed).toEqual([A]);
    h.keyNoSearch = false;
    h.changed = [];
    const all = await reindexFiles(OWNER, [A, MAIL]);
    expect(all).toEqual({ queued: 2, databases: 0, skipped: [] });
    expect(h.changed).toEqual([A, MAIL]);
  });

  it('a PDF whose database holds its sketch read keeps its text; the others drop it', async () => {
    h.rows = [row(A, 'sketch.pdf'), row(B, 'b.pdf')];
    h.dbs = new Map([[A, 'sketch']]);
    const got = await reindexFiles(OWNER, [A, B]);
    expect(got).toEqual({ queued: 2, databases: 0, skipped: [] });
    expect(h.updated).toBe(1);
    const { ids, keys } = dropOf();
    expect(ids).toBe(`{${A}}`);
    // Each kept key is named once (in the list of the others), the rest twice.
    for (const k of ['text', 'ocr', 'vision_model']) {
      expect(
        keys.filter((x) => x === k),
        k,
      ).toHaveLength(1);
    }
    for (const k of ['summary', 'read_by', 'extract_completed_at', 'extract_parked']) {
      expect(
        keys.filter((x) => x === k),
        k,
      ).toHaveLength(2);
    }
    expect(keys).not.toContain('agent_text');
    expect(keys).not.toContain('pipeline_read');
  });

  it('a file that is no PDF never keeps its text, even with a database', async () => {
    h.rows = [row(A, 'a.txt')];
    h.dbs = new Map([[A, 'sketch']]);
    await reindexFiles(OWNER, [A]);
    expect(dropOf().ids).toBe('{}');
  });

  it('a PDF whose File tab cannot be read now keeps its text; one that says no sketch drops it', async () => {
    h.rows = [row(A, 'busy.pdf'), row(B, 'plain.pdf')];
    h.dbs = new Map([
      [A, 'unreadable'],
      [B, 'plain'],
    ]);
    const got = await reindexFiles(OWNER, [A, B]);
    expect(got).toEqual({ queued: 2, databases: 0, skipped: [] });
    expect(dropOf().ids).toBe(`{${A}}`);
  });

  it('a queue that cannot be read: a clear 503, nothing written, never the SQL', async () => {
    vi.mocked(dbMock.extractJobsFor).mockRejectedValueOnce(
      Object.assign(new Error('permission denied for table job'), { code: '42501' }),
    );
    const err = await reindexFiles(OWNER, [A, B]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReindexQueueUnreadError);
    expect(h.updated).toBe(0);
    expect(h.changed).toEqual([]);
    const answer = domainErrorAnswer(err);
    expect(answer?.status).toBe(503);
    expect(String(answer?.body.error)).toMatch(/nothing was dropped/);
    expect(String(answer?.body.error)).not.toMatch(/permission|table job/);
  });

  it('a PDF told by its mimeType, with no .pdf in its name, keeps its sketch read', async () => {
    h.rows = [row(A, 'scan-attachment', 'application/pdf'), row(B, 'scan-other', 'text/plain')];
    h.dbs = new Map([
      [A, 'sketch'],
      [B, 'sketch'],
    ]);
    await reindexFiles(OWNER, [A, B]);
    expect(dropOf().ids).toBe(`{${A}}`);
  });
});
