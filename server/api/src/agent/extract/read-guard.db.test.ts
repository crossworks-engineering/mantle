/**
 * The crash stamp (./read-guard.ts) against a real, migrated Postgres: a
 * heavy read is stamped while it runs and the stamp is put back after; a
 * stamp left behind by a process that died mid-read keeps the node out of
 * the boot drain, and the next job for it (a retry, a dead letter re-sent
 * at boot) records the terminal skip and reads nothing; an explicit
 * re-extract after that reads it again. The extractor config, the model key
 * check and the side passes are stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/api/src/agent/extract/read-guard.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asSuperuser } from '@mantle/db/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({
  resolveChatKey: vi.fn(),
  autoTable: vi.fn(),
  embeddedImages: vi.fn(),
}));

vi.mock('./model', () => ({
  resolveExtractor: async () => ({
    id: 'w1',
    slug: 'extractor',
    params: { target_types: ['*'] },
    apiKeyId: null,
  }),
}));
vi.mock('@mantle/runtime/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/runtime/agent')>();
  return { ...actual, resolveChatKey: h.resolveChatKey };
});
vi.mock('./auto-table', () => ({ maybeAutoTableSpreadsheet: h.autoTable }));
vi.mock('./images', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./images')>();
  return { ...actual, maybeExtractEmbeddedImages: h.embeddedImages };
});

describe.skipIf(!URL)('the crash stamp around a heavy read', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let guard: typeof import('./read-guard');
  let admitForExtraction: typeof import('./gates').admitForExtraction;
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  const file = randomUUID();

  type Row = { skipped: Record<string, unknown> | null; queued: boolean };
  async function row(): Promise<Row> {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [r] = (await m.db.execute(sqlTag`
      select data->'extract_skipped' as skipped,
             exists (select 1 from nodes q where q.id = ${file}
                       and ${m.unextractedNodeConds(owner, since)}) as queued
        from nodes where id = ${file}`)) as unknown as Row[];
    return r!;
  }
  async function loadNode() {
    const [n] = await m.db
      .select()
      .from(m.nodes)
      .where(sqlTag`id = ${file}`);
    return n!;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    guard = await import('./read-guard');
    ({ admitForExtraction } = await import('./gates'));
    sqlTag = (await import('drizzle-orm')).sql;
    h.resolveChatKey.mockResolvedValue({ ok: true });
    h.autoTable.mockResolvedValue(undefined);
    h.embeddedImages.mockResolvedValue(undefined);
    await asSuperuser()(sqlTag`insert into auth.users (id, email, password_hash, role)
      values (${owner}, ${`rg-${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`insert into spaces (id, kind, login_id)
      values (${owner}, 'brain', ${owner}) on conflict do nothing`);
    await m.db.execute(sqlTag`insert into nodes (id, owner_id, type, title, path, data)
      values (${file}, ${owner}, 'file', 'manual.pdf', 'files',
              '{"filename":"manual.pdf"}'::jsonb)`);
  }, 60_000);

  beforeEach(() => {
    h.autoTable.mockClear();
    h.embeddedImages.mockClear();
  });

  afterAll(async () => {
    if (!m) return;
    await m.db.execute(sqlTag`delete from traces where subject_id = ${file}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('stamps the node while the read runs and puts the prior stamp back after', async () => {
    await m.db.execute(sqlTag`update nodes set data = data || jsonb_build_object(
      'extract_skipped', jsonb_build_object('reason', 'no_parser', 'at', now())) where id = ${file}`);
    let during: Row | null = null;
    let crashedDuring: string | null = null;
    await guard.guardHeavyRead({ id: file }, 'text', async () => {
      during = await row();
      crashedDuring = guard.crashedRead(await loadNode());
    });
    expect(during!.skipped).toMatchObject({ reason: 'document_too_large', reading: 'text' });
    expect(during!.queued).toBe(false);
    expect(crashedDuring).toBe('text');
    const after = await row();
    expect(after.skipped).toMatchObject({ reason: 'no_parser' });
    expect(after.skipped).not.toHaveProperty('reading');

    // A read that throws puts it back the same; with no prior stamp, none.
    await m.db.execute(sqlTag`update nodes set data = data - 'extract_skipped' where id = ${file}`);
    await expect(
      guard.guardHeavyRead({ id: file }, 'pictures', async () => {
        throw new Error('reader failed');
      }),
    ).rejects.toThrow('reader failed');
    expect((await row()).skipped).toBeNull();
  });

  it('a stamp left by a process that died mid-read: no drain, a terminal skip, no read', async () => {
    await guard.markReading(file, 'pictures');
    // The boot drain and the sweep leave it alone.
    expect((await row()).queued).toBe(false);
    // The job handed out again (a retry, a dead letter re-sent at boot).
    const r = await admitForExtraction(file, owner);
    expect(r.proceed).toBe(false);
    expect(h.autoTable).not.toHaveBeenCalled();
    expect(h.embeddedImages).not.toHaveBeenCalled();
    const after = await row();
    expect(after.skipped).toMatchObject({ reason: 'document_too_large' });
    expect(after.skipped).not.toHaveProperty('reading');
    expect(after.queued).toBe(false);
    const [trace] = (await m.db.execute(sqlTag`
      select data->>'disposition' as d, data->>'pass' as pass
        from traces where subject_id = ${file} and kind = 'extractor_run'
       order by started_at desc limit 1`)) as unknown as Array<{ d: string; pass: string }>;
    expect(trace).toEqual({ d: 'document_too_large', pass: 'pictures' });

    // The owner's re-extract reads it again: past the crash check (what the
    // later gates make of a file with no bytes is not this test's).
    await admitForExtraction(file, owner).catch(() => null);
    expect(h.autoTable).toHaveBeenCalledTimes(1);
  });

  it('new bytes make a left stamp stale: read again', async () => {
    await guard.markReading(file, 'text');
    await m.db.execute(sqlTag`update nodes set updated_at = now() + interval '1 second'
      where id = ${file}`);
    expect(guard.crashedRead(await loadNode())).toBeNull();
  });
});
