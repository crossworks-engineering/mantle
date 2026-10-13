/**
 * GET /api/apps on a real, migrated Postgres (workspaces W5b2): each app
 * carries the workspaces that hold it (its read_ws) as chips, named only
 * where the caller is a user of the workspace (all of them for an Admin
 * user), sorted by name, and `hasLink` for a live open link (not revoked,
 * not expired, not a contact share). `?ws=<id>` keeps the apps that
 * workspace holds and echoes it; a workspace the caller may not see is 404
 * `code: 'not_found'`. Only the owner check is stubbed.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/app/api/apps/apps-list-chips.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppListResponse } from '@mantle/client-types';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const h = vi.hoisted(() => ({ owner: '', login: '' }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: h.owner,
    email: 'o@example.invalid',
    actor: { id: h.login, email: 'o@example.invalid', displayName: 'Admin', isOwner: true },
  })),
}));

describe.skipIf(!URL)('GET /api/apps: workspace chips, hasLink and ?ws', () => {
  type Db = typeof import('@mantle/db');
  let m: Db;
  let content: typeof import('@mantle/content');
  let route: typeof import('./route');
  let sqlTag: typeof import('drizzle-orm').sql;
  const owner = randomUUID();
  /** An admin login that is no user of the Admin workspace. */
  const plain = randomUUID();
  const other = randomUUID();
  const tag = `apps-chips-${owner.slice(0, 8)}`;
  const ws = {
    admin: randomUUID(),
    team: randomUUID(),
    proj: randomUUID(),
    quay: randomUUID(),
    otherBrain: randomUUID(),
  };
  const ids: Record<string, string> = {};

  const exec = (q: ReturnType<typeof sqlTag>) => m.systemDb.execute(q);
  const grant = (node: string, wsId: string, home = false) =>
    m.withHeads([node], 'update', (tx) =>
      tx.execute(sqlTag`insert into item_grants (node_id, workspace_id, is_home)
        values (${node}, ${wsId}, ${home})`),
    );
  const link = (node: string, state: 'live' | 'revoked' | 'expired' | 'contact') =>
    exec(sqlTag`
      insert into shares (owner_id, node_id, node_type, token, contact_id, revoked_at, expires_at)
      values (${owner}, ${node}, 'app', ${`${tag}-${randomUUID()}`},
        ${state === 'contact' ? ids.contact! : null},
        ${state === 'revoked' ? sqlTag`now()` : null},
        ${state === 'expired' ? sqlTag`now() - interval '1 day'` : null})`);
  const list = async (as: string, query = '') => {
    h.login = as;
    const res = await route.GET(new Request(`http://brain.test/api/apps${query}`));
    return { status: res.status, body: (await res.json()) as AppListResponse & { code?: string } };
  };
  const row = (body: AppListResponse, key: string) => body.apps.find((a) => a.id === ids[key]);
  const chip = (id: string, name: string) => expect.objectContaining({ id, name });

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'apps-chips-test-secret-at-least-32-characters';
    m = await import('@mantle/db');
    content = await import('@mantle/content');
    sqlTag = (await import('drizzle-orm')).sql;
    route = await import('./route');
    h.owner = owner;
    await exec(sqlTag`
      insert into auth.users (id, email, password_hash, role) values
        (${owner}, ${`${tag}-o@example.invalid`}, 'x', 'admin'),
        (${plain}, ${`${tag}-p@example.invalid`}, 'x', 'admin'),
        (${other}, ${`${tag}-x@example.invalid`}, 'x', 'admin')`);
    await exec(sqlTag`
      insert into spaces (id, kind, login_id) values
        (${owner}, 'brain', ${owner}), (${other}, 'brain', ${other})`);
    await exec(sqlTag`
      insert into workspaces (id, owner_id, name, is_admin, bridge_key) values
        (${ws.admin}, ${owner}, 'Admin', true, 'admin'),
        (${ws.team}, ${owner}, 'Team', false, null),
        (${ws.proj}, ${owner}, 'proj', false, null),
        (${ws.quay}, ${owner}, 'Quay', false, null),
        (${ws.otherBrain}, ${other}, 'Other', false, null)`);
    await exec(sqlTag`
      insert into workspace_users (workspace_id, login_id, moderator) values
        (${ws.admin}, ${owner}, true), (${ws.quay}, ${owner}, false),
        (${ws.proj}, ${plain}, false)`);
    ids.contact = randomUUID();
    await exec(sqlTag`
      insert into nodes (id, owner_id, type, title, path)
      values (${ids.contact}, ${owner}, 'contact', ${`${tag} contact`}, 'contacts')`);
    for (const key of ['held', 'live', 'revoked', 'expired', 'contact link', 'none']) {
      ids[key] = (await content.createApp(owner, { title: `${tag} ${key}` })).id;
      await grant(ids[key]!, ws.admin, true);
    }
    await grant(ids.held!, ws.team);
    await grant(ids.held!, ws.proj);
    await grant(ids.held!, ws.quay);
    await link(ids.live!, 'live');
    await link(ids.revoked!, 'revoked');
    await link(ids.expired!, 'expired');
    await link(ids['contact link']!, 'contact');
  }, 60_000);

  afterAll(async () => {
    await exec(sqlTag`delete from shares where owner_id = ${owner}`);
    await exec(sqlTag`
      delete from item_grants where node_id in (select id from nodes where owner_id = ${owner})`);
    await exec(sqlTag`delete from nodes where owner_id = ${owner}`);
    await exec(sqlTag`delete from workspaces where owner_id in (${owner}, ${other})`);
    await exec(sqlTag`delete from spaces where login_id in (${owner}, ${plain}, ${other})`);
    await exec(sqlTag`delete from auth.users where id in (${owner}, ${plain}, ${other})`);
    await m.closeDb();
  }, 60_000);

  it('names every holder to an Admin user, sorted by name', async () => {
    const { status, body } = await list(owner);
    expect(status).toBe(200);
    expect(body.ws).toBeUndefined();
    // By id and name: each chip's look (task 5edc9149) is pinned on a
    // scratch brain (list-workspaces.db.test.ts); this shared database's
    // brain is not this test's owner.
    expect(row(body, 'held')?.workspaces).toEqual([
      chip(ws.admin, 'Admin'),
      chip(ws.proj, 'proj'),
      chip(ws.quay, 'Quay'),
      chip(ws.team, 'Team'),
    ]);
    expect(row(body, 'none')?.workspaces).toEqual([chip(ws.admin, 'Admin')]);
    // No level badge any more.
    expect(row(body, 'held')).not.toHaveProperty('audience');
  });

  it('names only the workspaces another caller is a user of', async () => {
    const { body } = await list(plain);
    expect(row(body, 'held')?.workspaces).toEqual([chip(ws.proj, 'proj')]);
    expect(row(body, 'none')?.workspaces).toEqual([]);
  });

  it('hasLink: a live open link only', async () => {
    const { body } = await list(owner);
    expect(row(body, 'live')?.hasLink).toBe(true);
    for (const key of ['held', 'revoked', 'expired', 'contact link', 'none']) {
      expect(row(body, key)?.hasLink, key).toBe(false);
    }
  });

  it('?ws keeps the apps that workspace holds and echoes it', async () => {
    const { status, body } = await list(owner, `?ws=${ws.quay}`);
    expect(status).toBe(200);
    expect(body.ws).toBe(ws.quay);
    expect(body.apps.map((a) => a.id)).toEqual([ids.held]);
    expect(body.total).toBe(1);
    // A user of the workspace may filter by it too.
    expect((await list(plain, `?ws=${ws.proj}`)).body.apps.map((a) => a.id)).toEqual([ids.held]);
  });

  it('?ws the caller may not see is 404 not_found', async () => {
    for (const [as, wsId] of [
      [plain, ws.quay],
      [plain, ws.admin],
      [owner, ws.otherBrain],
      // An Admin user picks only a workspace it is in.
      [owner, ws.team],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      const { status, body } = await list(as, `?ws=${wsId}`);
      expect([wsId, status]).toEqual([wsId, 404]);
      expect(body.code).toBe('not_found');
    }
  });
});
