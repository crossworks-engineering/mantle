/**
 * A book's page pictures take the Agent's text of their page (G1,
 * describeBookPagePictures), only the pictures of the bytes the Agent read:
 * a page picture of an older revision (another sha256, marked
 * `olderVersion`) keeps its own text and is not indexed again. On a migrated scratch database, in the extract
 * queue's scope. The Agent's page text is made up here.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/api/src/agent/extract/images-book-pages.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/content/page-passages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content/page-passages')>()),
  agentPageTextOf: async () => new Map([[5, 'v2: the text of page 5']]),
}));

describe.skipIf(!URL)("a book's page pictures take the Agent's text of these bytes only", () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let describeBookPagePictures: typeof import('./images').describeBookPagePictures;
  const owner = randomUUID();
  const tag = `imbp${randomUUID().slice(0, 6)}`;
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const extract = <T>(fn: () => Promise<T>) => m.runAsSystem('queue:extract', fn) as Promise<T>;
  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];

  beforeAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'on';
    process.env.MANTLE_TEST_EDIT_CHECK = 'on';
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    ({ describeBookPagePictures } = await import('./images'));
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
  }, 240_000);

  afterAll(async () => {
    process.env.MANTLE_ACTOR_CHECK = 'warn';
    delete process.env.MANTLE_TEST_EDIT_CHECK;
    await m?.closeDb();
    await scratch?.drop();
  });

  it('the picture of v2 takes the text; the picture of v1, an older revision, keeps its own', async () => {
    const book = randomUUID();
    const filename = `${tag}-book.pdf`;
    await x(sql`insert into nodes (id, owner_id, type, title, path, data) values
      (${book}, ${owner}, 'file', ${filename}, 'files',
       ${JSON.stringify({ filename, sha256: B })}::jsonb)`);
    const picture = async (from: string, extra: Record<string, unknown>) => {
      const id = randomUUID();
      await x(sql`insert into nodes (id, owner_id, type, title, path, data, tags) values
        (${id}, ${owner}, 'file', ${`${filename} p5 ${from.slice(0, 1)}`}, 'files',
         ${JSON.stringify({ filename: `${id}.png`, sourceFileId: book, sourceSha256: from, bookPage: 5, ...extra })}::jsonb,
         array['file', 'extracted-image'])`);
      return id;
    };
    const older = await picture(A, { olderVersion: true, text: 'v1: its own text' });
    const current = await picture(B, {});
    expect(await extract(() => describeBookPagePictures(owner, book, B))).toBe(1);
    const data = async (id: string) =>
      (await x<{ data: Record<string, unknown> }>(sql`select data from nodes where id = ${id}`))[0]!
        .data;
    expect((await data(current)).text).toBe('v2: the text of page 5');
    expect((await data(older)).text).toBe('v1: its own text');
    expect((await data(older)).bookPageTextSha).toBeUndefined();
    // A run again that read the page the same way writes nothing.
    expect(await extract(() => describeBookPagePictures(owner, book, B))).toBe(0);
  });
});
