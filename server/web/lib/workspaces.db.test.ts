/**
 * Workspace management (W5a), through the real routes on a scratch brain the
 * workspaces migration made live (the session is stood in):
 *
 *  - who sees what: an Admin user every workspace, a login its own; a
 *    workspace the caller may not see is 404, never 403 (GET, PATCH, users,
 *    resources, archive, a bad id);
 *  - who may add whom: a Moderator adds anyone, a plain user nobody (asked
 *    before the login is looked up), an Admin user anyone, itself included,
 *    private workspaces too (S1), logged and shown as "Added by";
 *  - names: only Admin is reserved (Team too until 0286); a name clash
 *    with a workspace the caller cannot see is allowed (audit M3);
 *  - the last Moderator can be neither removed nor demoted;
 *  - only an Admin user ticks or clears Moderator (owner decision
 *    2026-10-13, 0286): a Moderator who is not one gets 403 admin_only on
 *    setModerator and on an add with the tick; the maker of a workspace is
 *    its Moderator; Team's Moderators keep their ticks from the switch;
 *  - Team is a normal workspace (0286): renamed, given a look, archived
 *    like any (refused while it is an item's home), no Admin user kept;
 *  - the Admin workspace's users are the admin logins (the role change, its
 *    owner and self rules, its checks inside the change, its audit row);
 *  - the assistant is frozen once it has history; resources need the area;
 *    Admin and Team take connectors like any workspace (W5b2: no level
 *    attaches one any more, so nothing is locked);
 *  - archive counts, the refusals, the grants and exclusions it drops, and
 *    no grant lands in an archived workspace, even racing the archive;
 *  - user search (Q3): 3 characters, Moderators and Admin users only, an
 *    Admin user pages through everyone;
 *  - the look (task 5edc9149): colour and icon by whoever may rename, the
 *    folder's validators, the built-in workspaces too; on the list, the
 *    screen and the shell, with the kind;
 *  - /api/shell's workspaces and areas.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/lib/workspaces.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appAnswerOf } from '@/server/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  res: null as unknown,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.res),
  // The reader the workspace routes call (A4 hand batch A): the same
  // stand-in. The api.write row is the gate's any-login answer step's now
  // (pinned by the guard sweep's guard writes and gate-caller.test.ts).
  loginCaller: vi.fn(() => h.res),
}));
vi.mock('@/lib/audit', () => ({
  auditFireAndForget: (row: Record<string, unknown>) => h.audits.push(row),
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));
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
    // Admin and member are the only roles (W8a).
    h.res =
      r!.role === 'admin'
        ? { kind: 'admin', loginId: id, email: r!.email, user }
        : { kind: 'member', loginId: id, email: r!.email, member: { anchorId: owner } };
  };
  const req = (method: string, body?: unknown, q = '') =>
    new Request(`http://x/api/workspaces${q}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  // The app's answer: a WsError or GrantError thrown by the route answers
  // by its row in the one table (A10 part 2 fix round 1, L7).
  const call = async (res: Response | Promise<Response>) => {
    const r = await appAnswerOf(res);
    return { status: r.status, body: (await r.json()) as Json };
  };
  const p = <T extends Json>(v: T) => ({ params: Promise.resolve(v) });
  /** An error's message with its causes (drizzle wraps the database's). */
  const errText = (err: unknown): string => {
    const out: string[] = [];
    for (let e: unknown = err, d = 0; e && d < 4; d++) {
      out.push(String((e as { message?: unknown }).message ?? e));
      e = (e as { cause?: unknown }).cause;
    }
    return out.join(' | ');
  };

  /**
   * The gate's scope for a login's call (session.ts anyLoginScope): its
   * reads and writes in its own request scope, as every member's request
   * runs since F4 and an Admin user's on /api/workspaces since plan v3.2
   * S2a a2 (drafts for an Admin user, as requestMode gives). The workspace
   * definers act for the scope's login (0305), so a change called with no
   * scope at all is refused.
   */
  const gated = <T extends object>(mod: T): T =>
    new Proxy(mod, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (typeof k !== 'string' || !/^(GET|POST|PATCH|PUT|DELETE)$/.test(k)) return v;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          const res = h.res as { kind: string; loginId: string } | null;
          const fn = () => (v as (...a: unknown[]) => unknown)(...args);
          if (!res) return fn();
          return m.runInRequestSlot(async () => {
            const scope = await m.loginScopeFor(res.loginId);
            m.enterRequestScope(scope, { writes: k !== 'GET', drafts: res.kind === 'admin' });
            return fn();
          });
        };
      },
    });
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
  const gatedRoutes = async () =>
    Object.fromEntries(
      Object.entries(await routes()).map(([k, mod]) => [k, gated(mod)]),
    ) as Awaited<ReturnType<typeof routes>>;
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
    await (await import('@mantle/db/test-support')).runWorkspacesSwitch();
    // After the migration, so it attaches neither (it picks the persona).
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role) values
      (${agentA}, ${owner}, 'w5a-a', 'Assistant A', 'm', 'p', 'responder'),
      (${agentB}, ${owner}, 'w5a-b', 'Assistant B', 'm', 'p', 'responder')`);
    const ws = await x<{ id: string; key: string }>(sql`
      select id::text as id, (case when is_admin then 'admin' when name = 'Team' then 'team' end) as key from workspaces where owner_id = ${owner}`);
    team = ws.find((w) => w.key === 'team')!.id;
    admin = ws.find((w) => w.key === 'admin')!.id;
    r = await gatedRoutes();
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  it('lists: an Admin user every workspace, a member its own', async () => {
    const mine = await create(mem3, 'Moe private');
    await as(owner);
    const all = await call(r.root.GET());
    const names = (all.body.workspaces as Json[]).map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(['Admin', 'Team', 'Moe private']));
    // builtIn: Admin only (Team too until 0286), on the list and the screen.
    const builtIn = Object.fromEntries(
      (all.body.workspaces as Json[]).map((w) => [w.name as string, w.builtIn]),
    );
    expect(builtIn).toMatchObject({ Admin: true, Team: false, 'Moe private': false });
    for (const [id, want] of [
      [admin, true],
      [team, false],
      [mine, false],
    ] as const) {
      const one = await call(r.one.GET(req('GET'), p({ id })));
      expect((one.body.workspace as Json).builtIn, id).toBe(want);
    }
    await as(mem);
    const memList = (await call(r.root.GET())).body.workspaces as Json[];
    expect(memList.map((w) => w.name)).toEqual(['Team']);
    expect(memList[0]!.builtIn).toBe(false);
    // The switch made every member a Team Moderator before 0286: the tick
    // stays (decision 2.a) until an Admin user clears it.
    expect(memList[0]!.me).toEqual({ member: true, moderator: true });
    expect(memList[0]!.adminModerated).toBe(false);
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

  it('who may add whom: Moderators anyone; plain users nobody; Admin users anyone (S1)', async () => {
    const ws = await create(mem, 'Mia team');
    await as(mem);
    // A Moderator adds a user (not a Moderator by default).
    expect((await addUser(ws, mem2)).status).toBe(200);
    expect(await userRow(ws, mem2)).toEqual({ moderator: false });
    // Twice is refused; a missing login too.
    expect((await addUser(ws, mem2)).body.code).toBe('already_user');
    expect((await addUser(ws, randomUUID())).status).toBe(404);
    // A plain user of the workspace adds nobody (it sees the workspace:
    // 403), and is told so before the login it names is looked up (audit
    // L1): a missing login answers the same 403 as a real one.
    await as(mem2);
    for (const target of [mem3, randomUUID()]) {
      const plain = await addUser(ws, target);
      expect(plain.status, target).toBe(403);
      expect(plain.body.code, target).toBe('forbidden');
    }
    // An Admin user who is not a user of it adds another user...
    await as(adm2);
    expect((await addUser(ws, mem3)).status).toBe(200);
    // ...and itself, to this private workspace with users (S1): logged with
    // self, shown as "Added by".
    const self = await addUser(ws, adm2);
    expect(self.status).toBe(200);
    expect(await userRow(ws, adm2)).toEqual({ moderator: false });
    const [ev] = await x<{ subject: Json }>(sql`select subject from workspace_events
      where workspace_id = ${ws} and actor_id = ${adm2} and action = 'user.add'
        and subject->>'login' = ${adm2}`);
    expect(ev!.subject).toEqual({ login: adm2, moderator: false, self: true });
    const users = self.body.users as Json[];
    const by = (id: string) => users.find((u) => u.loginId === id)!;
    expect(by(adm2).addedBy).toEqual({ loginId: adm2, name: 'Ada Admin' });
    expect(by(mem2).addedBy).toEqual({ loginId: mem, name: 'Mia Member' });
    expect(by(mem).addedBy).toEqual({ loginId: mem, name: 'Mia Member' });
    expect(Number.isNaN(Date.parse(by(adm2).addedAt as string))).toBe(false);
    // The adder's login gone: no name to show.
    const gone = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, role)
      values (${gone}, ${email(gone, 'gone')}, 'x', 'member')`);
    const empty = await create(gone, 'Former user');
    expect((await addUser(empty, mem)).status).toBe(200);
    await x(sql`delete from auth.users where id = ${gone}`);
    await as(adm2);
    const screen = (await call(r.one.GET(req('GET'), p({ id: empty })))).body;
    expect((screen.users as Json[])[0]).toMatchObject({ loginId: mem, addedBy: null });
  });

  it('names: only Admin is reserved; a hidden name never clashes (audit M3)', async () => {
    // A private workspace the member cannot see...
    await create(mem2, 'Secret plans');
    // ...does not stop the member using its name (a 409 would tell them it
    // exists).
    const twin = await create(mem, 'secret PLANS');
    await as(mem);
    expect((await call(r.one.GET(req('GET'), p({ id: twin })))).status).toBe(200);
    // The reserved name, any case and spacing, for anyone.
    for (const [who, name] of [
      [mem, 'Admin'],
      [mem, ' admin '],
      [owner, 'ADMIN'],
    ] as const) {
      await as(who);
      const out = await call(r.root.POST(req('POST', { name })));
      expect(out.status, name).toBe(409);
      expect(out.body.code, name).toBe('reserved_name');
    }
    // "Team" is a name like any other since 0286.
    await as(mem2);
    const team2 = await call(r.root.POST(req('POST', { name: ' team ' })));
    expect(team2.status).toBe(201);
    expect((team2.body as Json).builtIn).toBe(false);
  });

  it('names: Admin keeps its name and no other may take it; Team renames (fix round 2, L-3; 0286)', async () => {
    // A Team Moderator renames Team like any workspace (0286)...
    await as(mem);
    const team1 = await call(r.one.PATCH(req('PATCH', { name: 'Staff' }), p({ id: team })));
    expect(team1.status).toBe(200);
    expect((team1.body as Json).name).toBe('Staff');
    // ...and back, with a description.
    const desc = await call(
      r.one.PATCH(req('PATCH', { name: 'Team', description: 'Everyone' }), p({ id: team })),
    );
    expect(desc.status).toBe(200);
    expect((desc.body as Json).name).toBe('Team');
    // An Admin user cannot rename Admin.
    await as(owner);
    const admin1 = await call(r.one.PATCH(req('PATCH', { name: 'Owners' }), p({ id: admin })));
    expect(admin1.body.code).toBe('reserved_name');
    // Any other workspace: never "Admin", in any case or spacing; "Team" is
    // free.
    const mine = await create(mem3, 'Moe renames');
    for (const name of ['Admin', ' ADMIN ']) {
      const out = await call(r.one.PATCH(req('PATCH', { name }), p({ id: mine })));
      expect(out.status, name).toBe(409);
      expect(out.body.code, name).toBe('reserved_name');
    }
    expect((await call(r.one.PATCH(req('PATCH', { name: 'TEAM' }), p({ id: mine })))).status).toBe(
      200,
    );
    const [names] = await x<{ n: number }>(sql`select count(*)::int as n from workspaces
      where owner_id = ${owner} and lower(btrim(name)) = 'admin'`);
    expect(names!.n).toBe(1);
  });

  it('the last Moderator can be neither removed nor demoted', async () => {
    const ws = await create(mem2, 'Max solo');
    await as(mem2);
    const leave = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(leave.body.code).toBe('last_moderator');
    // An Admin user can neither demote them (only an Admin user clears a
    // tick, 0286) nor remove them.
    await as(owner);
    const demote = await call(
      r.user.PATCH(req('PATCH', { moderator: false }), p({ id: ws, loginId: mem2 })),
    );
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('last_moderator');
    const byAdmin = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(byAdmin.body.code).toBe('last_moderator');
    // With a second Moderator (an Admin user ticks it), the first may leave.
    await as(mem2);
    expect((await addUser(ws, mem3)).status).toBe(200);
    await as(owner);
    expect(
      (await call(r.user.PATCH(req('PATCH', { moderator: true }), p({ id: ws, loginId: mem3 }))))
        .status,
    ).toBe(200);
    await as(mem2);
    const ok = await call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId: mem2 })));
    expect(ok.status).toBe(200);
    expect(await userRow(ws, mem2)).toBeNull();
    expect(await userRow(ws, mem3)).toEqual({ moderator: true });
  });

  it('only an Admin user ticks or clears Moderator, Team included (0286, decision 3.a)', async () => {
    const tick = (wsId: string, loginId: string, moderator: boolean) =>
      call(r.user.PATCH(req('PATCH', { moderator }), p({ id: wsId, loginId })));
    // A Team Moderator who is no Admin user (the switch ticked them): neither
    // way, for anyone, and their own tick and every row stay as they are.
    await as(mem);
    for (const [loginId, moderator] of [
      [mem3, false],
      [adm2, false],
      [mem, false],
    ] as const) {
      const out = await tick(team, loginId, moderator);
      expect(out.status, loginId).toBe(403);
      expect(out.body.code, loginId).toBe('admin_only');
      expect(out.body.error, loginId).toBe(
        'Only an Admin user can make someone a Moderator or take the tick away.',
      );
    }
    expect(await userRow(team, mem3)).toEqual({ moderator: true });
    expect(await userRow(team, mem)).toEqual({ moderator: true });
    // The maker of a workspace is its Moderator, and still may not tick.
    const own = await create(mem, 'Mia ticks');
    await as(mem);
    expect((await addUser(own, mem2)).status).toBe(200);
    expect((await tick(own, mem2, true)).body.code).toBe('admin_only');
    const withTick = await addUser(own, mem3, true);
    expect(withTick.status).toBe(403);
    expect(withTick.body.code).toBe('admin_only');
    expect(await userRow(own, mem3)).toBeNull();
    // An Admin user ticks and clears, in Team and in any workspace (the
    // review of decision 2.a), and adds with the tick.
    await as(owner);
    expect((await tick(team, mem3, false)).status).toBe(200);
    expect(await userRow(team, mem3)).toEqual({ moderator: false });
    expect((await tick(own, mem2, true)).status).toBe(200);
    expect(await userRow(own, mem2)).toEqual({ moderator: true });
    expect((await addUser(own, mem3, true)).status).toBe(200);
    expect(await userRow(own, mem3)).toEqual({ moderator: true });
    const [ev] = await x<{ subject: Json }>(sql`select subject from workspace_events
      where workspace_id = ${own} and action = 'user.moderator'`);
    expect(ev!.subject).toEqual({ login: mem2, moderator: true });
  });

  it('Team keeps no Admin user (0286): demoted and removed like anyone', async () => {
    const id = p({ id: team, loginId: adm2 });
    expect(await userRow(team, adm2)).toEqual({ moderator: true });
    const screen0 = (await call(r.one.GET(req('GET'), p({ id: team })))).body;
    const ada0 = (screen0.users as Json[]).find((u) => u.loginId === adm2)!;
    expect(ada0.adminViaArea).toBe(false);
    // An Admin user clears another Admin user's tick there.
    await as(owner);
    expect((await call(r.user.PATCH(req('PATCH', { moderator: false }), id))).status).toBe(200);
    expect(await userRow(team, adm2)).toEqual({ moderator: false });
    // A Moderator removes them, and an Admin user adds itself back: not a
    // Moderator unless asked (no 18.8 rule any more).
    await as(mem);
    expect((await call(r.user.DELETE(req('DELETE'), id))).status).toBe(200);
    expect(await userRow(team, adm2)).toBeNull();
    await as(adm2);
    expect((await addUser(team, adm2)).status).toBe(200);
    expect(await userRow(team, adm2)).toEqual({ moderator: false });
    const [ev] = await x<{ subject: Json }>(sql`select subject from workspace_events
      where workspace_id = ${team} and action = 'user.add' and subject->>'login' = ${adm2}`);
    expect(ev!.subject).toEqual({ login: adm2, moderator: false, self: true });
    expect((await call(r.user.PATCH(req('PATCH', { moderator: true }), id))).status).toBe(200);
    expect(await userRow(team, adm2)).toEqual({ moderator: true });
  });

  it('only an Admin user removes a Moderator; a plain user by a Moderator; anyone leaves (Q2)', async () => {
    const ws = await create(mem, 'Mia removes');
    await as(mem);
    expect((await addUser(ws, mem2)).status).toBe(200);
    expect((await addUser(ws, mem3)).status).toBe(200);
    await as(owner);
    expect(
      (await call(r.user.PATCH(req('PATCH', { moderator: true }), p({ id: ws, loginId: mem2 }))))
        .status,
    ).toBe(200);
    // A Moderator who is no Admin user cannot remove another Moderator (the
    // remove-and-re-add bypass of the tick): 403 admin_only, the row stays.
    await as(mem);
    const del = (loginId: string) => call(r.user.DELETE(req('DELETE'), p({ id: ws, loginId })));
    const refused = await del(mem2);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('admin_only');
    expect(await userRow(ws, mem2)).toEqual({ moderator: true });
    // A plain user: a Moderator removes them as before.
    expect((await del(mem3)).status).toBe(200);
    expect(await userRow(ws, mem3)).toBeNull();
    // A Moderator still leaves, while another Moderator stays...
    await as(mem2);
    expect((await del(mem2)).status).toBe(200);
    expect(await userRow(ws, mem2)).toBeNull();
    // ...and the last one cannot, with the text that says who can help.
    await as(mem);
    const last = await del(mem);
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('last_moderator');
    expect(last.body.error).toBe(
      'This is the last Moderator of the workspace. An Admin user must make another user a Moderator first.',
    );
    // An Admin user removes a Moderator (never the last).
    await as(mem);
    expect((await addUser(ws, mem2)).status).toBe(200);
    await as(owner);
    expect(
      (await call(r.user.PATCH(req('PATCH', { moderator: true }), p({ id: ws, loginId: mem2 }))))
        .status,
    ).toBe(200);
    expect((await del(mem2)).status).toBe(200);
    expect(await userRow(ws, mem2)).toBeNull();
    expect(await userRow(ws, mem)).toEqual({ moderator: true });
  });

  it('the Admin workspace: adding a user is the admin role, removing it the member role', async () => {
    await as(mem);
    expect((await addUser(admin, mem)).status).toBe(404);
    await as(owner);
    const teamRowBefore = await userRow(team, mem2);
    h.audits.length = 0;
    const add = await addUser(admin, mem2);
    expect(add.status).toBe(200);
    // The Users screen's audit row (audit M2).
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'user.update',
        actorId: owner,
        method: 'POST',
        path: `/api/workspaces/${admin}/users`,
        detail: {
          targetId: mem2,
          targetEmail: email(mem2, 'mem'),
          changes: { role: 'admin' },
          sessionsEnded: true,
        },
      }),
    ]);
    expect(await roleOf(mem2)).toBe('admin');
    expect(await userRow(admin, mem2)).toEqual({ moderator: true });
    // The login bridge keeps the Admin row only: Team's is as it was (0286).
    expect(await userRow(team, mem2)).toEqual(teamRowBefore);
    h.audits.length = 0;
    const remove = await call(r.user.DELETE(req('DELETE'), p({ id: admin, loginId: mem2 })));
    expect(remove.status).toBe(200);
    expect(await roleOf(mem2)).toBe('member');
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'user.update',
        method: 'DELETE',
        path: `/api/workspaces/${admin}/users/${mem2}`,
        detail: expect.objectContaining({
          targetId: mem2,
          changes: { role: 'member' },
          sessionsEnded: true,
          releasedAgentId: null,
        }),
      }),
    ]);
    // A refused change writes none.
    h.audits.length = 0;
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
    expect(h.audits).toEqual([]);
  });

  it('the Admin workspace: its checks run inside the role change, before the bridge (audit L2)', async () => {
    const { applyLoginChange, loadLoginTarget } = await import('@/lib/login-update');
    const target = (await loadLoginTarget(mem3))!;
    const actor = {
      id: owner,
      email: email(owner, 'owner'),
      actor: { id: owner, email: email(owner, 'owner'), displayName: null, isOwner: true },
    };
    const seen: string[] = [];
    const rowIn = async (tx: { execute: (typeof m.db)['execute'] }) =>
      (
        (await tx.execute(sql`select 1 from workspace_users
          where workspace_id = ${admin} and login_id = ${mem3}`)) as unknown as unknown[]
      ).length;
    // A refusal in the first step ends the change: no role, no row.
    await expect(
      applyLoginChange(actor, target, { role: 'admin' }, undefined, async (tx) => {
        seen.push(`first:${await rowIn(tx)}`);
        throw new Error('refused here');
      }),
    ).rejects.toThrow('refused here');
    expect(await roleOf(mem3)).toBe('member');
    // The first step sees the rows before the bridge, the last after it.
    const done = await applyLoginChange(
      actor,
      target,
      { role: 'admin' },
      async (tx) => {
        seen.push(`last:${await rowIn(tx)}`);
      },
      async (tx) => {
        seen.push(`first:${await rowIn(tx)}`);
      },
    );
    expect(done.ok).toBe(true);
    expect(seen).toEqual(['first:0', 'first:0', 'last:1']);
    // Back to a member, through the workspace screen.
    await as(owner);
    const back = await call(r.user.DELETE(req('DELETE'), p({ id: admin, loginId: mem3 })));
    expect(back.status).toBe(200);
    expect(await roleOf(mem3)).toBe('member');
  });

  it('PATCH: name by a Moderator; contact and assistant by an Admin user only', async () => {
    const ws = await create(mem, 'Mia renames');
    await as(mem);
    const id = p({ id: ws });
    expect((await call(r.one.PATCH(req('PATCH', { name: 'Mia renamed' }), id))).status).toBe(200);
    expect((await call(r.one.PATCH(req('PATCH', { name: 'Admin' }), id))).body.code).toBe(
      'reserved_name',
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

  it('look: colour and icon by whoever may rename it, on every list (task 5edc9149)', async () => {
    const ws = await create(mem, 'Mia colours');
    const id = p({ id: ws });
    const patch = async (body: Json, wsId = id) => call(r.one.PATCH(req('PATCH', body), wsId));
    // A Moderator sets both; the answer carries them, with the kind.
    await as(mem);
    const set = await patch({ color: 'teal', icon: 'lucide:rocket' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ color: 'teal', icon: 'lucide:rocket', kind: 'other' });
    // The folder's validators: an unknown tint or a word is a 400.
    for (const body of [{ color: 'mauve' }, { icon: 'rocket' }, { icon: 'lucide:Not Valid' }]) {
      const bad = await patch(body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.body.code, JSON.stringify(body)).toBe('invalid');
    }
    // A plain user of it may not (the rename rule), an outsider sees 404.
    expect((await addUser(ws, mem2)).status).toBe(200);
    await as(mem2);
    expect((await patch({ color: 'red' })).body.code).toBe('forbidden');
    await as(mem3);
    expect((await patch({ color: 'red' })).status).toBe(404);
    // An Admin user who is not a user of it may, as for the name.
    await as(adm2);
    expect((await patch({ color: 'pink', icon: '🚀' })).body).toMatchObject({
      color: 'pink',
      icon: '🚀',
    });
    // null and '' clear (the default look).
    await as(mem);
    expect((await patch({ color: null, icon: '' })).body).toMatchObject({
      color: null,
      icon: null,
    });
    const [ev] = await x<{ n: number }>(sql`select count(*)::int as n from workspace_events
      where workspace_id = ${ws} and action = 'workspace.update' and subject ? 'color'`);
    expect(ev!.n).toBe(3);
    // Team's look by the same rule (0286: no built-in switch): a Team
    // Moderator sets it. The switch kept the icon the old 'team' kind drew.
    const teamLook = await patch({ color: 'green' }, p({ id: team }));
    expect(teamLook.status).toBe(200);
    expect(teamLook.body).toMatchObject({ color: 'green', icon: 'lucide:users', kind: 'other' });
    // Admin's look: its Moderators, who are Admin users; a member sees 404.
    expect((await patch({ color: 'red' }, p({ id: admin }))).status).toBe(404);
    // On the list, the screen and the shell.
    await as(owner);
    const list = (await call(r.root.GET())).body.workspaces as Json[];
    const look = (wsId: string) => {
      const w = list.find((x) => x.id === wsId)!;
      return [w.kind, w.color, w.icon];
    };
    expect(look(admin)).toEqual(['admin', null, null]);
    expect(look(team)).toEqual(['other', 'green', 'lucide:users']);
    const screen = (await call(r.one.GET(req('GET'), p({ id: team })))).body;
    expect(screen.workspace).toMatchObject({ kind: 'other', color: 'green' });
    // An Admin user (Admin's Moderator) sets Admin's look, and clears it.
    expect((await patch({ color: 'blue' }, p({ id: admin }))).body).toMatchObject({
      color: 'blue',
      kind: 'admin',
    });
    expect((await patch({ color: null }, p({ id: admin }))).status).toBe(200);
    const { shellWorkspaces } = await import('./workspaces');
    const shell = await shellWorkspaces({
      kind: 'member',
      loginId: mem,
      anchorId: owner,
      user: null,
    });
    expect(shell.workspaces.find((w) => w.id === team)).toMatchObject({
      kind: 'other',
      color: 'green',
      icon: 'lucide:users',
    });
    // Back to how the switch left it, so the other tests see Team as it was.
    await as(mem);
    expect((await patch({ color: null }, p({ id: team }))).status).toBe(200);
    // mantle_ws_kind answers for this brain's workspaces only (audit L1).
    const other = randomUUID();
    const otherWs = randomUUID();
    await x(sql`insert into auth.users (id, email, password_hash, role)
      values (${other}, ${email(other, 'other')}, 'x', 'admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${other}, 'brain', ${other})`);
    await x(sql`insert into workspaces (id, owner_id, name, is_admin)
      values (${otherWs}, ${other}, 'Other brain', true)`);
    const kinds = await x<{ mine: string | null; theirs: string | null }>(
      sql`select mantle_ws_kind(${team}::uuid) as mine, mantle_ws_kind(${otherWs}::uuid) as theirs`,
    );
    expect(kinds).toEqual([{ mine: 'other', theirs: null }]);
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

  it('resources: connectors by an Admin user; Team takes one like any workspace', async () => {
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
      { kind: 'connector', id: CONN, name: 'Connector W', write: false },
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
    // Team (a built-in workspace) takes a connector like any other since
    // W5b2: no level attaches one, so nothing is locked or refused.
    const onTeam = await call(
      r.res.POST(req('POST', { kind: 'connector', id: CONN }), p({ id: team })),
    );
    expect(onTeam.status).toBe(200);
    const teamConn = (onTeam.body.resources as Json[]).find((x2) => x2.id === CONN);
    expect(teamConn).toEqual({ kind: 'connector', id: CONN, name: 'Connector W', write: false });
    const teamOne = p({ id: team, kind: 'connector', refId: CONN });
    expect((await call(r.resOne.PATCH(req('PATCH', { write: true }), teamOne))).status).toBe(200);
    const gone = await call(r.resOne.DELETE(req('DELETE'), teamOne));
    expect(gone.status).toBe(200);
    expect((gone.body.resources as Json[]).find((x2) => x2.id === CONN)).toBeUndefined();
    // A member of Team who is no Admin user still may not.
    await as(mem);
    expect(
      (await call(r.res.POST(req('POST', { kind: 'connector', id: CONN }), p({ id: team })))).body
        .code,
    ).toBe('admin_only');
  });

  it('archive: counts first, refusals, and the grants it drops', async () => {
    await as(owner);
    expect((await call(r.archive.POST(req('POST'), p({ id: admin })))).body.code).toBe(
      'admin_workspace',
    );
    const ws = await create(mem, 'Mia archive');
    // The note is shared here (not its home); a second item is "removed
    // here" (an exclusion row).
    const other = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${other}, ${owner}, 'note', 'another note', 'notes')`);
    await m.withHeads([note, other], 'update', async (tx) => {
      await tx.execute(
        sql`insert into item_grants (node_id, workspace_id, write) values (${note}, ${ws}, false)`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, excluded)
        values (${other}, ${ws}, false, true)`);
    });
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
    // The event counts both kinds of row it dropped (audit L5).
    const [ev] = await x<{ subject: Json }>(sql`select subject from workspace_events
      where workspace_id = ${ws} and action = 'workspace.archive'`);
    expect(ev!.subject).toEqual({ grantsDropped: 1, exclusionsDropped: 1 });
    const [left] = await x<{ n: number }>(
      sql`select count(*)::int as n from item_grants where workspace_id = ${ws}`,
    );
    expect(left!.n).toBe(0);
    // An archived workspace takes no grant (audit L3).
    const late = await m
      .withHeads([note], 'update', (tx) =>
        tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
          values (${note}, ${ws}, false)`),
      )
      .then(() => 'landed', errText);
    expect(late).toMatch(/is archived: it takes no grants/);
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

  it('a grant racing the archive on another connection never lands (audit L3)', async () => {
    const ws = await create(mem, 'Mia race');
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const isLocked = new Promise<void>((res) => (locked = res));
    // Connection 1: the archive, holding the workspace row FOR UPDATE.
    const archive = m.systemDb.transaction(async (tx) => {
      await tx.execute(sql`select id from workspaces where id = ${ws} for update`);
      locked();
      await held;
      await tx.execute(sql`delete from item_grants where workspace_id = ${ws} and not is_home`);
      await tx.execute(sql`update workspaces set archived_at = now() where id = ${ws}`);
    });
    await isLocked;
    // Connection 2: a grant to it, while the archive holds the row.
    let settled = false;
    const grant = m
      .withHeads([note], 'update', (tx) =>
        tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
          values (${note}, ${ws}, false)`),
      )
      .finally(() => {
        settled = true;
      });
    const outcome = grant.then(() => 'landed', errText);
    await new Promise((res) => setTimeout(res, 400));
    // It waits on the archive's lock...
    expect(settled).toBe(false);
    release();
    await archive;
    // ...and then sees the archive: refused, nothing left behind.
    expect(await outcome).toMatch(/is archived: it takes no grants/);
    const [n] = await x<{ n: number }>(
      sql`select count(*)::int as n from item_grants where workspace_id = ${ws}`,
    );
    expect(n!.n).toBe(0);
  });

  it('user search (Q3): Moderators and Admin users, 3 characters, no disabled logins', async () => {
    const q = (v: string) =>
      call(r.search.GET(req('GET', undefined, `/user-search?q=${encodeURIComponent(v)}`)));
    await as(mem);
    expect((await q('Mo')).body.code).toBe('query_too_short');
    const hits = (await q('member')).body as unknown as Json[];
    const ids = hits.map((h2) => h2.loginId);
    expect(ids).toEqual(expect.arrayContaining([mem, mem2, mem3]));
    expect(ids).not.toContain(off);
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

  it('user search: an Admin user pages through everyone, 50 a page', async () => {
    const page = (offset: string) =>
      call(r.search.GET(req('GET', undefined, `/user-search?q=pager&offset=${offset}`)));
    const many = Array.from({ length: 53 }, () => randomUUID());
    for (const [i, id] of many.entries()) {
      await x(sql`insert into auth.users (id, email, password_hash, role, display_name)
        values (${id}, ${email(id, 'pager')}, 'x', 'member', ${`Pager ${String(i).padStart(2, '0')}`})`);
    }
    await as(owner);
    const first = (await page('0')).body as unknown as Json[];
    const second = (await page('50')).body as unknown as Json[];
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(3);
    const seen = [...first, ...second].map((h2) => h2.loginId);
    expect(new Set(seen).size).toBe(53);
    expect([...seen].sort()).toEqual([...many].sort());
    expect((await page('x')).body.code).toBe('invalid');
    // A Moderator who is not an Admin user gets no paging.
    await as(mem);
    expect((await page('10')).body.code).toBe('invalid');
    expect(((await page('0')).body as unknown as Json[]).length).toBe(10);
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
      {
        id: admin,
        name: 'Admin',
        isAdmin: true,
        moderator: true,
        color: null,
        icon: null,
        kind: 'admin',
      },
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

  it('Team archives like any workspace (0286): refused while an item has its home there', async () => {
    // An item homed in Team.
    const homed = randomUUID();
    await x(sql`insert into nodes (id, owner_id, type, title, path)
      values (${homed}, ${owner}, 'note', 'a Team note', 'notes')`);
    await m.withHeads([homed], 'update', async (tx) => {
      await tx.execute(
        sql`update item_grants set is_home = false where node_id = ${homed} and is_home`,
      );
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write, is_home)
        values (${homed}, ${team}, false, true)`);
    });
    await as(mem);
    const held = await call(r.archive.POST(req('POST'), p({ id: team })));
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('workspace_holds_items');
    // Moved home again (to Admin), Team archives: a Moderator of it may.
    await m.withHeads([homed], 'update', async (tx) => {
      await tx.execute(
        sql`delete from item_grants where node_id = ${homed} and workspace_id = ${team}`,
      );
      await tx.execute(sql`update item_grants set is_home = true
        where node_id = ${homed} and workspace_id = ${admin}`);
    });
    const done = await call(r.archive.POST(req('POST'), p({ id: team })));
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body.workspace as Json).archived).toBe(true);
  });
});
