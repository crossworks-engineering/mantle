/**
 * The tool-group level is gone from the owner API (workspaces W7b, W8c), on a
 * real, migrated Postgres. Only the owner check is stood in. Seeds its own
 * brain and removes it.
 *
 *  - GET /api/tool-groups and GET /api/tool-groups/:id carry no `audience`
 *    (W8c: the column is frozen until W10 and nothing reads it), even for a
 *    group whose frozen column says 'team';
 *  - PATCH /api/access/tool-groups/:slug answers 410 since W7b and changes
 *    nothing.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run tool-group-level-routes.db.test
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    email: 'admin@example.invalid',
    actor: { id: h.owner, email: 'admin@example.invalid', displayName: null, isOwner: true },
  })),
  // The reader a converted handler calls (A4 step 3b): the same stand-in.
  ownerCaller: vi.fn(() => ({
    id: h.owner,
    email: 'admin@example.invalid',
    actor: { id: h.owner, email: 'admin@example.invalid', displayName: null, isOwner: true },
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Route = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;
type Group = { id: string; slug: string; name: string; grantedTo?: unknown[] };

describe.skipIf(!URL)('the tool group level is gone from the owner API on Postgres', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let sqlTag: typeof import('drizzle-orm').sql;
  const r: Record<string, Route> = {};
  const owner = randomUUID();
  h.owner = owner;
  const tag = `tglevel-${owner.slice(0, 8)}`;
  const plain = `${tag}-plain`;
  const held = `${tag}-held`;
  const agent = randomUUID();

  const call = (method: string, body?: unknown) =>
    new Request('http://brain.test/x', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const p = (o: Record<string, string>) => ({ params: Promise.resolve(o) });
  const list = async () =>
    ((await (await r.list!(call('GET'))).json()) as { groups: Group[] }).groups.filter((g) =>
      g.slug.startsWith(tag),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    m = await import('@mantle/db');
    sqlTag = (await import('drizzle-orm')).sql;
    r.list = (await import('../../tool-groups/route')).GET as unknown as Route;
    r.get = (await import('../../tool-groups/[id]/route')).GET as unknown as Route;
    r.level = (await import('./[slug]/route')).PATCH as unknown as Route;

    await m.db.execute(sqlTag`
      insert into auth.users (id, email, password_hash, role) values (${owner}, ${`${tag}@example.invalid`}, 'x', 'admin')`);
    await m.db.execute(
      sqlTag`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})`,
    );
    // The held group's frozen column says 'team' (a pre-W7b level): the API
    // must not answer it.
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${plain}, 'plain group', 'admin'),
        (${owner}, ${held}, 'held group', 'team')`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, tool_group_slugs)
      values (${agent}, ${owner}, ${`${tag}-agent`}, 'A', 'm', 'p', ${`{${held}}`}::text[])`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  it('the list and the get carry no level', async () => {
    const groups = await list();
    expect(groups.map((g) => g.slug).sort()).toEqual([held, plain].sort());
    for (const g of groups) expect(g, g.slug).not.toHaveProperty('audience');
    const id = groups.find((g) => g.slug === held)!.id;
    const res = await r.get!(call('GET'), p({ id }));
    expect(res.status).toBe(200);
    const { group } = (await res.json()) as { group: Group };
    expect(group.slug).toBe(held);
    expect(group).not.toHaveProperty('audience');
  });

  it('W7b: the level route answers 410 and changes nothing', async () => {
    const before = await list();
    for (const body of [{ audience: 'team' }, { audience: 'admin' }, { audience: 'owner' }]) {
      const res = await (r.level as unknown as () => Promise<Response>)();
      expect(res.status, JSON.stringify(body)).toBe(410);
      expect(await res.json()).toMatchObject({ code: 'gone' });
    }
    expect(await list()).toEqual(before);
  });
});
