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
 */
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
    data: Record<string, unknown>;
  }[],
  gone: new Set<string>(),
  mail: new Set<string>(),
  keyNoSearch: false,
  updated: 0,
  changed: [] as string[],
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
        set: () => ({
          where: async () => {
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
}));

vi.mock('@mantle/content/pipeline-registry', () => ({
  boxPipelines: async () => ({ readerFor: () => null }),
}));

const { file_reindex, reindexFiles } = await import('./reindex');

const row = (id: string, filename: string) => ({
  id,
  title: filename,
  path: 'files.made-up',
  home: null,
  filename,
  sha256: null,
  data: { filename },
});

beforeEach(() => {
  h.rows = [row(A, 'a.txt'), row(B, 'b.txt'), row(MAIL, 'mail.pdf')];
  h.gone = new Set();
  h.mail = new Set([MAIL]);
  h.keyNoSearch = false;
  h.updated = 0;
  h.changed = [];
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
});
