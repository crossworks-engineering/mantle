/**
 * A tool group's level on the owner API, on a real, migrated Postgres. Only
 * the owner check is stood in. Seeds its own brain and removes it.
 *
 *  - GET /api/tool-groups and GET /api/tool-groups/:id carry `audience`;
 *  - PATCH /api/access/tool-groups/:slug { audience } changes it, and the
 *    list shows the new level;
 *  - raising a group above an agent that holds it is refused with
 *    group_above_agent, naming the agent, and the level stays.
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
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Route = (req: Request, ctx?: { params: Promise<any> }) => Promise<Response>;
type Group = { id: string; slug: string; audience?: string };

describe.skipIf(!URL)('a tool group level on the owner API on Postgres', () => {
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
    ((await (await r.list!(call('GET'))).json()) as { groups: Group[] }).groups;
  const levelIn = async (slug: string) => (await list()).find((g) => g.slug === slug)?.audience;

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
    await m.db.execute(sqlTag`
      insert into tool_groups (owner_id, slug, name, audience) values
        (${owner}, ${plain}, 'plain group', 'admin'),
        (${owner}, ${held}, 'held group', 'team')`);
    await m.db.execute(sqlTag`
      insert into agents (id, owner_id, slug, name, model, system_prompt, audience, tool_group_slugs)
      values (${agent}, ${owner}, ${`${tag}-agent`}, 'A', 'm', 'p', 'team', ${`{${held}}`}::text[])`);
  }, 60_000);

  afterAll(async () => {
    await m.db.execute(sqlTag`delete from agents where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from tool_groups where owner_id = ${owner}`);
    await m.db.execute(sqlTag`delete from spaces where id = ${owner} or login_id = ${owner}`);
    await m.db.execute(sqlTag`delete from auth.users where id = ${owner}`);
    await m.closeDb();
  }, 60_000);

  it('the list and the get carry each group level', async () => {
    expect(await levelIn(plain)).toBe('admin');
    expect(await levelIn(held)).toBe('team');
    const id = (await list()).find((g) => g.slug === held)!.id;
    const res = await r.get!(call('GET'), p({ id }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { group: Group }).group.audience).toBe('team');
  });

  it('PATCH sets the level, and the list shows it', async () => {
    const res = await r.level!(call('PATCH', { audience: 'team' }), p({ slug: plain }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tool_group: { slug: plain, audience: 'team' } });
    expect(await levelIn(plain)).toBe('team');
  });

  it('raising a group above an agent that holds it is refused, naming the agent', async () => {
    const res = await r.level!(call('PATCH', { audience: 'admin' }), p({ slug: held }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('group_above_agent');
    expect(body.error).toContain(`${tag}-agent`);
    expect(await levelIn(held)).toBe('team');
  });

  it('refuses a level that is not one, and a group that is not there', async () => {
    const bad = await r.level!(call('PATCH', { audience: 'owner' }), p({ slug: plain }));
    expect(bad.status).toBe(400);
    const gone = await r.level!(call('PATCH', { audience: 'team' }), p({ slug: `${tag}-none` }));
    expect(gone.status).toBe(404);
  });
});
