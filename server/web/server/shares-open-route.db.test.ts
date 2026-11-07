/**
 * A public link is open to anyone with edit rights, by hand (docs/workspaces.md,
 * its line on opening, changing or closing a link): the routes ask one rule,
 * assertMayLink, in the handler. Through the full pipeline (runRoute) on a real,
 * migrated database:
 *
 *  - a member who holds Write opens, sees, changes and closes a link;
 *  - a member who holds read only is refused, and one who reads nothing gets the
 *    404 of an id no row has;
 *  - an app's link stays a Moderator's;
 *  - a contact share's Can write stays an Admin user's;
 *  - an API key and no credential get nothing here.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/shares-open-route.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRoute } from '@/server/run-route';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Json = Record<string, any>;

describe.skipIf(!URL)('a public link is open to whoever may edit the item', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | null = null;
  let m: typeof import('@mantle/db');

  const L = { owner: randomUUID(), writer: randomUUID(), outsider: randomUUID() };
  const W = { P: randomUUID(), Q: randomUUID() };
  const I = {
    written: randomUUID(),
    readOnly: randomUUID(),
    app: randomUUID(),
    appModerated: randomUUID(),
  };

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);

  const route = async (
    who: string | null | { key: string },
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const res = await runRoute(who, method, path, body);
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // Not JSON: the status says it.
    }
    return { status: res.status, json, text };
  };

  /** An item homed in `home`, granted to `other` as `write` says. */
  const node = async (
    id: string,
    type: string,
    path: string,
    home: string,
    other: string | null,
    write: boolean,
  ) => {
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${L.owner}, ${type}::node_type, ${`link ${id.slice(0, 8)}`}, ${path}::ltree)`);
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${home}, true)`);
      if (other) {
        await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                             values (${id}, ${other}, ${write})`);
      }
    });
  };

  const liveLinks = async (id: string) =>
    (
      await x<{ c: number }>(sql`select count(*)::int as c from shares
        where node_id = ${id} and revoked_at is null`)
    )[0]!.c;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'shares-open-route-secret-at-least-32-chars';
    m = await import('@mantle/db');

    for (const [who, id] of Object.entries(L)) {
      await ts.asSuperuser()(sql`
        insert into auth.users (id, email, password_hash, is_owner, role, display_name)
        values (${id}, ${`sor-${who}@example.invalid`}, 'x', ${who === 'owner'},
                ${who === 'owner' ? 'admin' : 'member'}, ${who})`);
    }
    await x(sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
                on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch(scratch.url);
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${W.P}, ${L.owner}, 'Proj'), (${W.Q}, ${L.owner}, 'Quay')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                 values (${W.Q}, ${L.writer}, false), (${W.P}, ${L.owner}, true)`);
    // The writer moderates R; the outsider is in no workspace of these.
    const R = randomUUID();
    await su(sql`insert into workspaces (id, owner_id, name) values (${R}, ${L.owner}, 'Reef')`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
                 values (${R}, ${L.writer}, true)`);

    await node(I.written, 'note', 'notes', W.P, W.Q, true);
    await node(I.readOnly, 'note', 'notes', W.P, W.Q, false);
    await node(I.app, 'app', 'apps', W.P, W.Q, true);
    await node(I.appModerated, 'app', 'apps', R, null, false);
    // The app is built on the first request: not inside a cell's time.
    await runRoute(null, 'GET', '/api/shares');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('a member who holds Write opens, sees, changes and closes a link', async () => {
    const opened = await route(L.writer, 'POST', '/api/shares', { nodeId: I.written });
    expect(opened.status, opened.text).toBe(200);
    expect(opened.json.share.path).toMatch(/^\/s\//);
    expect(await liveLinks(I.written)).toBe(1);
    const shareId = String(opened.json.share.id);

    const seen = await route(L.writer, 'GET', `/api/shares?nodeId=${I.written}`);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.json.share.id).toBe(shareId);

    const changed = await route(L.writer, 'PATCH', `/api/shares/${shareId}`, { serve: [] });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json).toEqual({ ok: true, served: [] });

    const closed = await route(L.writer, 'DELETE', `/api/shares/${shareId}`);
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json).toEqual({ ok: true });
    expect(await liveLinks(I.written)).toBe(0);
  });

  it('a member who holds read only is refused, and nothing changes', async () => {
    const refused = await route(L.writer, 'POST', '/api/shares', { nodeId: I.readOnly });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.code).toBe('forbidden');
    expect(await liveLinks(I.readOnly)).toBe(0);

    const made = await route(L.owner, 'POST', '/api/shares', { nodeId: I.readOnly });
    expect(made.status, made.text).toBe(200);
    const id = String(made.json.share.id);
    expect((await route(L.writer, 'PATCH', `/api/shares/${id}`, { serve: [] })).status).toBe(403);
    expect((await route(L.writer, 'DELETE', `/api/shares/${id}`)).status).toBe(403);
    expect(await liveLinks(I.readOnly)).toBe(1);
  });

  it('a member who reads nothing of the item gets the one 404', async () => {
    const refused = await route(L.outsider, 'POST', '/api/shares', { nodeId: I.written });
    expect(refused.status, refused.text).toBe(404);
    const made = await route(L.owner, 'POST', '/api/shares', { nodeId: I.written });
    expect(made.status, made.text).toBe(200);
    const id = String(made.json.share.id);
    const seen = await route(L.outsider, 'GET', `/api/shares?nodeId=${I.written}`);
    expect(seen.status, seen.text).toBe(200);
    expect(seen.json.share).toBeNull();
    expect((await route(L.outsider, 'DELETE', `/api/shares/${id}`)).status).toBe(404);
    expect((await route(L.outsider, 'PATCH', `/api/shares/${id}`, { serve: [] })).status).toBe(404);
    expect(await liveLinks(I.written)).toBe(1);
  });

  it("an app's link stays a Moderator's: Write is not enough", async () => {
    const refused = await route(L.writer, 'POST', '/api/shares', { nodeId: I.app });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error).toMatch(/Moderator/);
    expect(await liveLinks(I.app)).toBe(0);
    const moderator = await route(L.writer, 'POST', '/api/shares', { nodeId: I.appModerated });
    expect(moderator.status, moderator.text).toBe(200);
    expect(await liveLinks(I.appModerated)).toBe(1);
  });

  it("a contact share's Can write stays an Admin user's", async () => {
    const shareId = randomUUID();
    const contact = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path, data)
                values (${contact}, ${L.owner}, 'contact'::node_type, 'A contact', 'contacts'::ltree, '{}'::jsonb)`);
    await x(sql`insert into shares (id, token, owner_id, node_id, node_type, contact_id)
                values (${shareId}, ${`sor-${shareId}`}, ${L.owner}, ${I.app}, 'app', ${contact})`);
    const refused = await route(L.writer, 'PATCH', `/api/shares/${shareId}`, { canWrite: true });
    expect(refused.status, refused.text).toBe(403);
    const [row] = await x<{ can_write: boolean }>(
      sql`select can_write from shares where id = ${shareId}`,
    );
    expect(row?.can_write).toBe(false);
  });

  it('an API key and no credential get nothing here', async () => {
    const body = { nodeId: I.written };
    const { mintAccessKey } = await import('../lib/access-keys');
    const minted = await mintAccessKey({
      loginId: L.owner,
      name: 'shares-open-route',
      access: 'read_write',
      areas: null,
      riskyTools: [],
      expiresAt: null,
      createdBy: L.owner,
      maxLive: 10,
    });
    const before = await liveLinks(I.written);
    expect((await route({ key: minted!.key }, 'POST', '/api/shares', body)).status).toBe(401);
    expect(await liveLinks(I.written)).toBe(before);
    expect((await route(null, 'POST', '/api/shares', body)).status).toBe(401);
    expect((await route(null, 'DELETE', `/api/shares/${randomUUID()}`)).status).toBe(401);
  });
});
