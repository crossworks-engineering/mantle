/**
 * POST /api/shares on CLIENT items, against a real, migrated Postgres
 * (client logins C1, audit A31: one test per entry point). Client is
 * signed-in clients, never an open link: a client item gets 400
 * `client-links-retired` and no link. Only the owner check is stubbed.
 * Seeds its own owner and rows and removes them. (The sub-page cascade route
 * this file also covered went with folder phase 7: pages do not nest.)
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run client-links-route.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', () => ({ getOwnerOr401: vi.fn(async () => ({ id: h.owner })) }));

describe.skipIf(!URL)('the share routes on client items, on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let create: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = { note: randomUUID() };
  const tag = `client-links-route-${owner.slice(0, 8)}`;

  const post = (body: unknown) =>
    new Request('http://brain.test/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const exec = async <T>(q: ReturnType<typeof sqlTag>) => (await m.db.execute(q)) as unknown as T[];
  const liveLinks = async (id: string) =>
    (
      await exec<{ n: number }>(
        sqlTag`select count(*)::int as n from shares where node_id = ${id} and revoked_at is null`,
      )
    )[0]!.n;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    create = await import('./route');
    sqlTag = (await import('drizzle-orm')).sql;
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id, audience) values
        (${ids.note}, ${owner}, 'note', 'client note', 'notes', null, 'client')`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from shares where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from nodes where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  });

  it('POST /api/shares: 400 client-links-retired for a client item, no link', async () => {
    const res = await create.POST(post({ nodeId: ids.note }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'client-links-retired' });
    expect(await liveLinks(ids.note)).toBe(0);
  });
});
