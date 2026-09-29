/**
 * POST /api/shares and POST /api/shares/cascade on CLIENT items, against a
 * real, migrated Postgres (client logins C1, audit A31: one test per entry
 * point). Client is signed-in clients, never an open link: a client item
 * gets 400 `client-links-retired` and no link; a client parent's old link
 * shares no sub-pages (400); a client sub-page under a public parent keeps
 * client and is reported in `skipped` (audit A9). Only the owner check is
 * stubbed. Seeds its own owner and rows and removes them.
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
  let cascade: typeof import('./cascade/route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  h.owner = owner;
  const ids = {
    note: randomUUID(),
    cParent: randomUUID(),
    cSub: randomUUID(),
    parent: randomUUID(),
    subClient: randomUUID(),
    subAdmin: randomUUID(),
  };
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
  const audienceOf = async (id: string) =>
    (await exec<{ audience: string }>(sqlTag`select audience from nodes where id = ${id}`))[0]!
      .audience;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    create = await import('./route');
    cascade = await import('./cascade/route');
    sqlTag = (await import('drizzle-orm')).sql;
    const empty = '{"type":"doc","content":[]}';
    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash) values (${owner}, ${`${tag}@example.invalid`}, 'x')`);
    await m.db.execute(sqlTag`
      insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`);
    await m.db.execute(sqlTag`
      insert into nodes (id, owner_id, type, title, path, parent_id, audience) values
        (${ids.note}, ${owner}, 'note', 'client note', 'notes', null, 'client'),
        (${ids.cParent}, ${owner}, 'page', 'client parent', 'pages', null, 'client'),
        (${ids.cSub}, ${owner}, 'page', 'client sub', 'pages', ${ids.cParent}, 'client'),
        (${ids.parent}, ${owner}, 'page', 'public parent', 'pages', null, 'admin'),
        (${ids.subClient}, ${owner}, 'page', 'client sub', 'pages', ${ids.parent}, 'client'),
        (${ids.subAdmin}, ${owner}, 'page', 'admin sub', 'pages', ${ids.parent}, 'admin')`);
    await m.db.execute(sqlTag`
      insert into pages (node_id, doc, doc_text) values
        (${ids.cParent}, ${empty}::jsonb, ''), (${ids.cSub}, ${empty}::jsonb, ''),
        (${ids.parent}, ${empty}::jsonb, ''), (${ids.subClient}, ${empty}::jsonb, ''),
        (${ids.subAdmin}, ${empty}::jsonb, '')`);
    // An old link on the client parent (made when client meant an open
    // link), cascade OFF.
    await m.db.execute(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, settings)
      values (${owner}, ${ids.cParent}, 'page', ${`old-${randomUUID()}`}, '{"cascade":false}'::jsonb)`);
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

  it('POST /api/shares/cascade: 400 for a client parent, its flag untouched', async () => {
    const res = await cascade.POST(post({ nodeId: ids.cParent, on: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'client-links-retired' });
    const [row] = await exec<{ settings: Record<string, unknown> }>(
      sqlTag`select settings from shares where node_id = ${ids.cParent} and revoked_at is null`,
    );
    expect(row!.settings).toEqual({ cascade: false });
    expect(await liveLinks(ids.cSub)).toBe(0);
  });

  it('POST /api/shares/cascade over a public parent: a client sub-page is skipped (A9)', async () => {
    expect((await create.POST(post({ nodeId: ids.parent }))).status).toBe(200);
    const res = await cascade.POST(post({ nodeId: ids.parent, on: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 1, skipped: [ids.subClient] });
    expect(await liveLinks(ids.subAdmin)).toBe(1);
    expect(await liveLinks(ids.subClient)).toBe(0);
    expect(await audienceOf(ids.subClient)).toBe('client');
  });
});
