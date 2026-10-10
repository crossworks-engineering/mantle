/**
 * Workspace management (W5a), through the real routes on a scratch brain the
 * workspaces migration made live (the session is stood in):
 *
 *  - who sees what: an Admin user every workspace, a login its own; a
 *    workspace the caller may not see is 404, never 403 (GET, PATCH, users,
 *    resources, archive, a bad id);
 *  - who may add whom: a Moderator adds anyone, a plain user nobody, an
 *    Admin user OTHER users anywhere but itself only to an empty workspace
 *    (17 R7); a client login never;
 *  - the last Moderator can be neither removed nor demoted;
 *  - in the Admin-moderated workspace only an Admin user removes or demotes
 *    an Admin user (19.5);
 *  - the Admin workspace's users are the admin logins (the role change, its
 *    owner and self rules);
 *  - the assistant is frozen once it has history; resources need the area;
 *    the bridge workspaces' connectors are locked;
 *  - archive counts, the refusals, and the grants it drops;
 *  - user search (Q3): 3 characters, Moderators and Admin users only;
 *  - /api/shell's workspaces and areas.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/workspaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ res: null as unknown }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.res),
}));
vi.mock('@/lib/audit', () => ({ auditFireAndForget: () => {}, requestMetaFrom: () => ({}) }));
vi.mock('@/lib/push/relay-client', () => ({ relayDeleteDevice: vi.fn(async () => true) }));
vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: (plain: string) => ({ ciphertext: Buffer.from(plain, 'utf8') }),
  open: (sealed: Buffer) => sealed.toString('utf8'),
}));

type Json = Record<string, unknown>;

describe.skipIf(!URL)('workspace management (W5a)', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  const owner = randomUUID(); // the anchor, an admin
  const adm2 = randomUUID(); // a second admin
  const mem = randomUUID(); // a member
  const mem2 = randomUUID(); // a member
  const mem3 = randomUUID(); // a member
  const off = randomUUID(); // a disabled member
  const cli = randomUUID(); // a client login
  let admin = '';
  let team = '';
  const agentA = randomUUID();
  const agentB = randomUUID();
  const note = randomUUID();
  const CONN = 'conn-w5a';

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  const email = (id: string, who: string) => `w5a-${who}-${id.slice(0, 8)}@example.invalid`;

  /** Sign in as `id` (its role read from the row). */
  const as = async (id: string) => {
    const [r] = await x<{ role: string; email: string }>(
      sql`select role, email from auth.users where id = ${id}`,
    );
    const user = {
      id: owner,
      email: r!.email,
      actor: { id, email: r!.email, displayName: null, isOwner: id === owner },
    };
    if (r!.role === 'admin') {
      h.res = { kind: 'admin', loginId: id, email: r!.email, user };
    } else if (r!.role === 'member') {
      h.res = { kind: 'member', loginId: id, email: r!.email, member: { anchorId: owner } };
    } else {
      h.res = { kind: 'client', loginId: id, email: r!.email, client: { anchorId: owner } };
    }
  };
  const req = (method: string, body?: unknown, q = '') =>
    new Request(`http://x/api/workspaces${q}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const call = async (res: Response | Promise<Response>) => {
    const r = await res;
    return { status: r.status, body: (await r.json()) as Json };
  };
  const p = <T extends Json>(v: T) => ({ params: Promise.resolve(v) });

  const routes = async () => ({
    root: await import('@/app/api/workspaces/route'),
    one: await import('@/app/api/workspaces/[id]/route'),
    users: await import('@/app/api/workspaces/[id]/users/route'),
    user: await import('@/app/api/workspaces/[id]/users/[loginId]/route'),
    res: await import('@/app/api/workspaces/[id]/resources/route'),
    resOne: await import('@/app/api/workspaces/[id]/resources/[kind]/[refId]/route'),
    preview: await import('@/app/api/workspaces/[id]/archive-preview/route'),
    archive: await import('@/app/api/workspaces/[id]/archive/route'),
    search: await import('@/app/api/workspaces/user-search/route'),
  });
  let r: Awaited<ReturnType<typeof routes>>;

  const create = async (by: string, name: string) => {
    await as(by);
    const out = await call(r.root.POST(req('POST', { name })));
    expect(out.status).toBe(201);
    return out.body.id as string;
  };
  const addUser = async (wsId: string, loginId: string, moderator?: boolean) =>
    call(r.users.POST(req('POST', { loginId, moderator }), p({ id: wsId })));
  const roleOf = async (id: string) =>
    (await x<{ role: string }>(sql`select role from auth.users where id = ${id}`))[0]!.role;
  const userRow = async (wsId: string, id: string) =>
    (
      await x<{ moderator: boolean }>(
        sql`select moderator from workspace_users where workspace_id = ${wsId} and login_id = ${id}`,
      )
    )[0] ?? null;

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'workspaces-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email(owner, 'owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${adm2}, ${email(adm2, 'adm')}, 'x', false, 'admin', 'Ada Admin'),
      (${mem}, ${email(mem, 'mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email(mem2, 'mem')}, 'x', false, 'member', 'Max Member'),
      (${mem3}, ${email(mem3, 'mem')}, 'x', false, 'member', 'Moe Member'),
      (${off}, ${email(off, 'mem')}, 'x', false, 'member', 'Odd Member')`);
    await x(sql`update auth.users set disabled_at = now() where id = ${off}`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    const binding = JSON.stringify({
      service: CONN,
      mcp: { url: 'https://mcp.example.invalid/mcp' },
    });
    await x(sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${owner}, ${CONN}, 'Connector W', ARRAY['conn_w_do']::text[], 'admin', true, ${binding}::jsonb)`);
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${note}, ${owner}, 'note', 'a note', 'notes')`);
    await x(sql`select * from mantle_ws_migrate()`);
    // After the migration, so it attaches neither (it picks the persona).
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role) values
      (${agentA}, ${owner}, 'w5a-a', 'Assistant A', 'm', 'p', 'responder'),
      (${agentB}, ${owner}, 'w5a-b', 'Assistant B', 'm', 'p', 'responder')`);
    // A client login made after the migration (the migration skips a brain
    // that has one).
    await x(sql`insert into auth.users (id, email, password_hash, role)
      values (${cli}, ${email(cli, 'cli')}, 'x', 'client')`);
    const ws = await x<{ id: string; key: string }>(sql`
      select id::text as id, bridge_key as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;
    r = await routes();
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('lists: an Admin user every workspace, a member its own, a client none', async () => {
    const mine = await create(mem3, 'Moe private');
    await as(owner);
    const all = await call(r.root.GET());
    const names = (all.body.workspaces as Json[]).map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Admin', 'Team', 'Moe private']));
    await as(mem);
    const memList = (await call(r.root.GET())).body.workspaces as Json[];
    expect(memList.map((w) => w.name)).toEqual(['Team']);
    expect(memList[0]!.me).toEqual({ member: true, moderator: true });
    expect(memList[0]!.adminModerated).toBe(true);
    await as(cli);
    expect((await call(r.root.GET())).body).toEqual({ workspaces: [] });
    expect((await call(r.root.POST(req('POST', { name: 'Nope' })))).body.code).toBe('client_login');
    await as(mem3);
    const own = (await call(r.one.GET(req('GET'), p({ id: mine })))).body;
    expect((own.workspace as Json).adminModerated).toBe(false);
    expect(own.users).toEqual([
      expect.objectContaining({ loginId: mem3, moderator: true, adminViaArea: false }),
    ]);
  });

  it('a workspace the caller may not see is 404 everywhere, never 403', async () => {
    const hidden = await create(mem2, 'Max hidden');
    await as(mem);
    const id = p({ id: hidden });
    const codes = [
      (await call(r.one.GET(req('GET'), id))).status,
      (await call(r.one.PATCH(req('PATCH', { name: 'x' }), id))).status,
      (await addUser(hidden, mem)).status,
      (await call(r.user.DELETE(req('DELETE'), p({ id: hidden, loginId: mem2 })))).status,
      (
        await call(
          r.user.PATCH(req('PATCH', { moderator: false }), p({ id: hidden, loginId: mem2 })),
        )
      ).status,
      (await call(r.res.POST(req('POST', { kind: 'connector', id: CONN }), id))).status,
      (await call(r.preview.GET(req('GET'), id))).status,
      (await call(r.archive.POST(req('POST'), id))).status,
      (await call(r.one.GET(req('GET'), p({ id: admin })))).status,
      (await call(r.one.GET(req('GET'), p({ id: 'not-a-uuid' })))).status,
      (await call(r.one.GET(req('GET'), p({ id: randomUUID() })))).status,
    ];
    expect(codes).toEqual(Array(codes.length).fill(404));
  });

  it('who may add whom: Moderators anyone; plain users nobody; Admin users others only', async () => {
    const ws = await create(mem, 'Mia team');
    await as(mem);
    // A Moderator adds a user (not a Moderator by default).
    expect((await addUser(ws, mem2)).status).toBe(200);
    expect(await userRow(ws, mem2)).toEqual({ moderator: false });
    // Twice is refused; a client login and a missing one too.
    expect((await addUser(ws, mem2)).body.code).toBe('already_user');
    expect((await addUser(ws, cli)).body.code).toBe('client_login');
    expect((await addUser(ws, randomUUID())).status).toBe(404);
    // A plain user of the workspace adds nobody (it sees the workspace: 403).
    await as(mem2);
    const plain = await addUser(ws, mem3);
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('forbidden');
    // An Admin user who is not a user of it adds ANOTHER user...
    await as(adm2);
    expect((await addUser(ws, mem3)).status).toBe(200);
    // ...but never itself to a workspace that has users (17 R7).
    const self = await addUser(ws, adm2);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_add_refused');
    expect(await userRow(ws, adm2)).toBeNull();
    // A workspace with no users left (its only user's login was deleted) may
    // be joined by an Admin user, and it is logged.
    const gone = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, role)
      values (${gone}, ${email(gone, 'gone')}, 'x', 'member')`);
    const empty = await create(gone, 'Former user');
    await x(sql`delete from auth.users where id = ${gone}`);
    await as(adm2);
    expect((await addUser(empty, adm2, true)).status).toBe(200);
    const [ev] = await x<{ action: string }>(sql`select action from workspace_events
      where workspace_id = ${empty} and actor_id = ${adm2} and action = 'user.add'`);
    expect(ev).toEqual({ action: 'user.add' });
  });

  it('the last Moderator can be neither removed nor demoted', async () => {
    const ws = await create(mem2, 'Max solo');
    await as(mem2);
    const demote = await call(
      r.user.PATCH(req('PATCH', { moderator: false }), p({ id: ws, loginId: mem2 })),
    );
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_moderator');
    const leave = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(leave.body.code).toBe('last_moderator');
    // An Admin user cannot remove them either.
    await as(owner);
    const byAdmin = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(byAdmin.body.code).toBe('last_moderator');
    // With a second Moderator, the first may leave.
    await as(mem2);
    expect((await addUser(ws, mem3, true)).status).toBe(200);
    const ok = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(ok.status).toBe(200);
    expect(await userRow(ws, mem2)).toBeNull();
    expect(await userRow(ws, mem3)).toEqual({ moderator: true });
  });

  it('Team: only an Admin user removes or demotes an Admin user (19.5)', async () => {
    await as(mem);
    const id = p({ id: team, loginId: adm2 });
    const demote = await call(r.user.PATCH(req('PATCH', { moderator: false }), id));
    expect(demote.status).toBe(403);
    expect(demote.body.code).toBe('admin_user_kept');
    const remove = await call(r.user.DELETE(req('DELETE'), id));
    expect(remove.body.code).toBe('admin_user_kept');
    const screen = (await call(r.one.GET(req('GET'), p({ id: team })))).body;
    const ada = (screen.users as Json[]).find((u) => u.loginId === adm2)!;
    expect(ada.adminViaArea).toBe(true);
    // A member may still manage another member there.
    expect(
      (await call(r.user.PATCH(req('PATCH', { moderator: false }), p({ id: team, loginId: mem3 }))))
        .status,
    ).toBe(200);
    expect(await userRow(team, mem3)).toEqual({ moderator: false });
  });

  it('the Admin workspace: adding a user is the admin role, removing it the member role', async () => {
    await as(mem);
    expect((await addUser(admin, mem)).status).toBe(404);
    await as(owner);
    const add = await addUser(admin, mem2);
    expect(add.status).toBe(200);
    expect(await roleOf(mem2)).toBe('admin');
    expect(await userRow(admin, mem2)).toEqual({ moderator: true });
    // The login bridge keeps them in Team as a Moderator.
    expect(await userRow(team, mem2)).toEqual({ moderator: true });
    const remove = await call(r.user.DELETE(req('DELETE'), p({ id: admin, loginId: mem2 })));
    expect(remove.status).toBe(200);
    expect(await roleOf(mem2)).toBe('member');
    expect(await userRow(admin, mem2)).toBeNull();
    // Never yourself, never the original account.
    await as(adm2);
    const self = await call(r.user.DELETE(req('DELETE'), p({ id: admin, loginId: adm2 })));
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('self_demote');
    expect(await roleOf(adm2)).toBe('admin');
    const anchor = await call(r.user.DELETE(req('DELETE'), p({ id: admin, loginId: owner })));
    expect(anchor.status).toBe(403);
    expect(anchor.body.code).toBe('owner_stays_admin');
    expect(await roleOf(owner)).toBe('admin');
  });

  it('PATCH: name by a Moderator; contact and assistant by an Admin user only', async () => {
    const ws = await create(mem, 'Mia renames');
    await as(mem);
    const id = p({ id: ws });
    expect((await call(r.one.PATCH(req('PATCH', { name: 'Mia renamed' }), id))).status).toBe(200);
    expect((await call(r.one.PATCH(req('PATCH', { name: 'Team' }), id))).body.code).toBe(
      'name_taken',
    );
    expect((await call(r.one.PATCH(req('PATCH', { assistantId: agentA }), id))).body.code).toBe(
      'admin_only',
    );
    expect((await call(r.one.PATCH(req('PATCH', { contactNodeId: note }), id))).body.code).toBe(
      'admin_only',
    );
    await as(owner);
    // A note is not a contact.
    expect((await call(r.one.PATCH(req('PATCH', { contactNodeId: note }), id))).status).toBe(400);
    const [ev] = await x<{ n: number }>(sql`select count(*)::int as n from workspace_events
      where workspace_id = ${ws} and action = 'workspace.update'`);
    expect(ev!.n).toBe(1);
  });

  it('the assistant is frozen once it has history', async () => {
    const ws = await create(mem2, 'Max assistant');
    await as(owner);
    const id = p({ id: ws });
    const set = await call(r.one.PATCH(req('PATCH', { assistantId: agentA }), id));
    expect(set.status).toBe(200);
    expect((set.body.assistant as Json).id).toBe(agentA);
    const [a] = await x<{ w: string }>(
      sql`select workspace_id::text as w from agents where id = ${agentA}`,
    );
    expect(a!.w).toBe(ws);
    // No history yet: it may be swapped; A is unbound again.
    expect((await call(r.one.PATCH(req('PATCH', { assistantId: agentB }), id))).status).toBe(200);
    const [a2] = await x<{ w: string | null }>(
      sql`select workspace_id::text as w from agents where id = ${agentA}`,
    );
    expect(a2!.w).toBeNull();
    // Another workspace cannot take B.
    const other = await create(mem3, 'Moe other');
    await as(owner);
    const taken = await call(r.one.PATCH(req('PATCH', { assistantId: agentB }), p({ id: other })));
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('assistant_in_use');
    // B gets history: frozen.
    await x(sql`insert into chat_threads (owner_id, agent_id, title, status)
      values (${owner}, ${agentB}, 'a thread', 'open')`);
    const screen = (await call(r.one.GET(req('GET'), id))).body;
    expect(screen.hasHistory).toBe(true);
    for (const body of [{ assistantId: agentA }, { assistantId: null }]) {
      const out = await call(r.one.PATCH(req('PATCH', body), id));
      expect(out.status).toBe(409);
      expect(out.body.code).toBe('assistant_has_history');
    }
    const del = await call(
      r.resOne.DELETE(req('DELETE'), p({ id: ws, kind: 'assistant', refId: agentB })),
    );
    expect(del.body.code).toBe('assistant_has_history');
  });

  it('resources: connectors by an Admin user; Admin and Team connectors are locked', async () => {
    const ws = await create(mem, 'Mia tools');
    await as(mem);
    const id = p({ id: ws });
    const byMember = await call(r.res.POST(req('POST', { kind: 'connector', id: CONN }), id));
    expect(byMember.status).toBe(403);
    expect(byMember.body.code).toBe('admin_only');
    await as(owner);
    const add = await call(r.res.POST(req('POST', { kind: 'connector', id: CONN }), id));
    expect(add.status).toBe(200);
    expect(add.body.resources).toEqual([
      { kind: 'connector', id: CONN, name: 'Connector W', write: false, locked: false },
    ]);
    expect(
      (await call(r.res.POST(req('POST', { kind: 'connector', id: CONN }), id))).body.code,
    ).toBe('resource_exists');
    expect(
      (await call(r.res.POST(req('POST', { kind: 'connector', id: 'nope' }), id))).status,
    ).toBe(400);
    const one = p({ id: ws, kind: 'connector', refId: CONN });
    const tick = await call(r.resOne.PATCH(req('PATCH', { write: true }), one));
    expect((tick.body.resources as Json[])[0]!.write).toBe(true);
    expect((await call(r.resOne.DELETE(req('DELETE'), one))).body.resources).toEqual([]);
    // The bridge workspaces: shown locked, refused.
    const teamScreen = (await call(r.one.GET(req('GET'), p({ id: admin })))).body;
    expect((teamScreen.resources as Json[]).find((x2) => x2.id === CONN)).toMatchObject({
      locked: true,
    });
    const locked = await call(
      r.resOne.PATCH(
        req('PATCH', { write: false }),
        p({ id: admin, kind: 'connector', refId: CONN }),
      ),
    );
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('bridge_owned');
  });

  it('archive: counts first, refusals, and the grants it drops', async () => {
    await as(owner);
    expect((await call(r.archive.POST(req('POST'), p({ id: admin })))).body.code).toBe(
      'admin_workspace',
    );
    expect((await call(r.archive.POST(req('POST'), p({ id: team })))).body.code).toBe(
      'bridge_owned',
    );
    const ws = await create(mem, 'Mia archive');
    // The note is shared here (not its home).
    await m.withHeads([note], 'update', (tx) =>
      tx.execute(
        sql`insert into item_grants (node_id, workspace_id, write) values (${note}, ${ws}, false)`,
      ),
    );
    await as(mem2);
    expect((await call(r.preview.GET(req('GET'), p({ id: ws })))).status).toBe(404);
    await as(mem);
    expect((await call(r.preview.GET(req('GET'), p({ id: ws })))).body).toEqual({
      grantCount: 1,
      itemCount: 0,
    });
    const done = await call(r.archive.POST(req('POST'), p({ id: ws })));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ grantCount: 1, itemCount: 0 });
    expect((done.body.workspace as Json).archived).toBe(true);
    const [n] = await x<{ has: boolean }>(
      sql`select ${ws}::uuid = any(read_ws) as has from nodes where id = ${note}`,
    );
    expect(n!.has).toBe(false);
    // Archived: gone from the member's list, and unchangeable.
    expect(((await call(r.root.GET())).body.workspaces as Json[]).some((w) => w.id === ws)).toBe(
      false,
    );
    await as(owner);
    expect((await call(r.one.PATCH(req('PATCH', { name: 'z' }), p({ id: ws })))).body.code).toBe(
      'archived',
    );
    // An empty one archives with nothing to drop.
    const bare = await create(mem, 'Mia bare');
    await as(mem);
    expect((await call(r.archive.POST(req('POST'), p({ id: bare })))).body).toMatchObject({
      grantCount: 0,
      itemCount: 0,
    });
    await as(owner);
    // A workspace that is an item's home cannot be archived.
    const home = await create(mem, 'Mia home');
    await m.withHeads([note], 'update', async (tx) => {
      await tx.execute(
        sql`update item_grants set is_home = false where node_id = ${note} and is_home`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${note}, ${home}, false, true)`);
    });
    await as(mem);
    expect((await call(r.preview.GET(req('GET'), p({ id: home })))).body).toEqual({
      grantCount: 0,
      itemCount: 1,
    });
    const held = await call(r.archive.POST(req('POST'), p({ id: home })));
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('workspace_holds_items');
  });

  it('user search (Q3): Moderators and Admin users, 3 characters, no disabled or client logins', async () => {
    const q = (v: string) =>
      call(r.search.GET(req('GET', undefined, `/user-search?q=${encodeURIComponent(v)}`)));
    await as(mem);
    expect((await q('Mo')).body.code).toBe('query_too_short');
    const hits = (await q('member')).body as unknown as Json[];
    const ids = hits.map((h2) => h2.loginId);
    expect(ids).toEqual(expect.arrayContaining([mem, mem2, mem3]));
    expect(ids).not.toContain(off);
    expect(ids).not.toContain(cli);
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(((await q('Olive')).body as unknown as Json[]).map((h2) => h2.loginId)).toEqual([owner]);
    // A login that moderates nothing may not search.
    const plain = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, role)
      values (${plain}, ${email(plain, 'plain')}, 'x', 'member')`);
    await x(sql`delete from workspace_users where login_id = ${plain}`);
    await as(plain);
    const no = await q('member');
    expect(no.status).toBe(403);
    // An Admin user may list everyone.
    await as(owner);
    expect(((await q('')).body as unknown as Json[]).length).toBeGreaterThanOrEqual(5);
  });

  it('/api/shell: the login workspaces and areas', async () => {
    const { shellWorkspaces } = await import('./workspaces');
    const ownerShell = await shellWorkspaces({
      kind: 'admin',
      loginId: owner,
      anchorId: owner,
      user: null,
    });
    expect(ownerShell.areas).toEqual(['settings', 'users', 'assistants', 'connectors', 'keys']);
    expect(ownerShell.workspaces.slice(0, 1)).toEqual([
      { id: admin, name: 'Admin', isAdmin: true, moderator: true },
    ]);
    const memShell = await shellWorkspaces({
      kind: 'member',
      loginId: mem,
      anchorId: owner,
      user: null,
    });
    expect(memShell.areas).toEqual([]);
    expect(memShell.workspaces.map((w) => w.name)).toContain('Team');
    expect(memShell.workspaces.some((w) => w.isAdmin)).toBe(false);
  });
});
