/**
 * The grant tools over MCP (access_grant_add, access_grant_remove) and the
 * Grant Access panel's routes, side by side on a scratch brain: the same
 * input on two twin items, one through the route and one through the tool,
 * as the same login in its own request scope (as the gate puts an MCP
 * request). They must agree: the same outcome, the refusal's same code and
 * words (the tool's error starts with them), the same grant rows and the
 * same workspace_events rows, with the login as their actor.
 *
 * Then what a change means for row security: a login outside the new
 * workspace still reads nothing of the item; a login inside reads it, and
 * what a folder grant flows to. access_get answers each login what its own
 * panel shows. An assistant's widening goes through the real queue and
 * the real approval: it runs once, in the asker's scope, as the asker, and
 * not when the asker lost the right in between; an in-brain call's folder
 * confirm never counts. Each tool's event names where it came from (`via`).
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test server/web/server/grants-mcp.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loginStandIn } from '@/server/run-route-stand-ins';
import { appAnswerOf } from '@/server/test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ res: null as unknown, login: null as unknown }));

vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn((await import('@/server/run-route-stand-ins')).adminFactsStandIn),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLoginOr401: vi.fn(async () => h.res),
  anyLoginCaller: vi.fn(() => {
    if (!h.login) throw new Error('anyLoginCaller(): the pipeline answered no login');
    return h.login;
  }),
}));
vi.mock('@/lib/audit', () => ({
  auditFireAndForget: () => undefined,
  requestMetaFrom: () => ({}),
  requestMeta: async () => ({ ip: null, userAgent: null }),
}));

type Json = Record<string, any>;
type Outcome = { ok: boolean; code: string | null; error: string | null };

describe.skipIf(!URL)('grant tools over MCP agree with the Grant Access routes', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let m: typeof import('@mantle/db');
  let t: typeof import('@mantle/tools');
  const owner = randomUUID(); // the anchor, an Admin user
  const mem = randomUUID(); // Moderator of P, plain user of Q
  const mem2 = randomUUID(); // Moderator of Q and R
  const mem3 = randomUUID(); // in no workspace of ours
  const P = randomUUID();
  const Q = randomUUID();
  const R = randomUUID();
  const Z = randomUUID(); // archived
  const X = randomUUID(); // mem's private workspace
  const T2 = randomUUID(); // mem moderates it: the approval tests' target
  const adm = randomUUID(); // an Admin user outside System
  let adminWs = '';
  const agent = randomUUID(); // a Proj assistant

  const x = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await m.systemDb.execute(q)) as unknown as T[];
  /** A fixture write, as the superuser (the app pools only read the
   *  workspace tables under the runtime role). */
  const su = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await import('@mantle/db/test-support')).superuserExec<T>(scratch!.url, q);
  const email = (id: string, who: string) => `gmcp-${who}-${id.slice(0, 8)}@example.invalid`;

  let who: string = owner;
  const as = async (id: string) => {
    who = id;
    const [r] = await x<{ role: string; email: string }>(
      sql`select role, email from auth.users where id = ${id}`,
    );
    const user = {
      id: owner,
      email: r!.email,
      actor: { id, email: r!.email, displayName: null, isOwner: id === owner },
    };
    h.res =
      r!.role === 'admin'
        ? { kind: 'admin', loginId: id, email: r!.email, user }
        : { kind: 'member', loginId: id, email: r!.email, member: { anchorId: owner } };
    h.login = loginStandIn({
      loginId: id,
      brainId: owner,
      email: r!.email,
      admin: r!.role === 'admin',
    });
  };
  /** Run `fn` in the login's own request scope, as the gate runs its
   *  /api/grants write and its MCP request. */
  const inScope = <T>(fn: () => Promise<T>, writes = true): Promise<T> =>
    m.runInRequestSlot(async () => {
      const scope = await m.loginScopeFor(who);
      m.enterRequestScope(scope, { writes, drafts: who === owner });
      return fn();
    });

  const req = (method: string, body?: unknown, q = '') =>
    new Request(`http://x/api/grants${q}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const p = <T extends Json>(v: T) => ({ params: Promise.resolve(v) });
  const routeAnswer = async (res: () => Promise<Response>): Promise<Outcome> => {
    const r = await appAnswerOf(inScope(res));
    const body = (await r.json()) as Json;
    return r.status === 200
      ? { ok: true, code: null, error: null }
      : { ok: false, code: body.code ?? null, error: body.error ?? null };
  };
  /** A login's own OAuth MCP connection, as the gate's caller says it. */
  const MCP = { entry: 'mcp', via: 'oauth' } as const;
  const toolAnswer = async (
    def: import('@mantle/tools').BuiltinToolDef,
    input: Json,
    caller: Json = MCP,
  ): Promise<Outcome & { output?: Json }> => {
    const res = await inScope(() =>
      def.handler(input, {
        ownerId: owner,
        surface: { kind: 'web', loginId: who },
        caller: caller as never,
      }),
    );
    if (res.ok) return { ok: true, code: null, error: null, output: res.output as Json };
    const m2 = /^([a-z_]+): /.exec(res.error);
    return { ok: false, code: m2?.[1] ?? null, error: res.error };
  };

  type Op = 'add' | 'addWrite' | 'writeOn' | 'writeOff' | 'remove';
  const viaRoute = async (op: Op, id: string, ws: string, confirm?: boolean) => {
    const one = await import('@/app/api/grants/[nodeId]/route');
    const row = await import('@/app/api/grants/[nodeId]/[wsId]/route');
    if (op === 'add' || op === 'addWrite') {
      const body = { wsId: ws, write: op === 'addWrite', ...(confirm ? { confirm } : {}) };
      return routeAnswer(() => one.POST(req('POST', body), p({ nodeId: id })));
    }
    if (op === 'writeOn' || op === 'writeOff') {
      const body = { write: op === 'writeOn', ...(confirm ? { confirm } : {}) };
      return routeAnswer(() => row.PATCH(req('PATCH', body), p({ nodeId: id, wsId: ws })));
    }
    return routeAnswer(() =>
      row.DELETE(
        req('DELETE', undefined, confirm ? '?confirm=1' : ''),
        p({ nodeId: id, wsId: ws }),
      ),
    );
  };
  const viaTool = (op: Op, id: string, ws: string, confirm?: boolean) => {
    const base = { node_id: id, workspace: ws, ...(confirm ? { confirm } : {}) };
    if (op === 'add') return toolAnswer(t.access_grant_add, base);
    if (op === 'addWrite' || op === 'writeOn') {
      return toolAnswer(t.access_grant_add, { ...base, write: true });
    }
    if (op === 'writeOff') return toolAnswer(t.access_grant_remove, { ...base, keep_read: true });
    return toolAnswer(t.access_grant_remove, base);
  };

  /** The item's grant rows, ids normalised to what they mean. */
  const rowsOf = async (id: string, twin: Record<string, string> = {}) =>
    (
      await x<{
        ws: string;
        write: boolean;
        is_home: boolean;
        via: string | null;
        excluded: boolean;
      }>(
        sql`select workspace_id::text as ws, write, is_home, via_folder_id::text as via, excluded
              from item_grants where node_id = ${id} order by workspace_id`,
      )
    ).map((r) => ({ ...r, via: r.via ? (twin[r.via] ?? 'folder') : null }));
  const eventsOf = async (id: string) =>
    x<{
      ws: string;
      action: string;
      actor: string | null;
      excluded: string | null;
      via: string | null;
    }>(
      sql`select workspace_id::text as ws, action, actor_id::text as actor,
                 subject->>'excluded' as excluded, subject->>'via' as via
            from workspace_events where subject->>'node' = ${id} order by at, action`,
    );

  const node = async (type: string, title: string, path: string, id = randomUUID()) => {
    await x(sql`insert into nodes (id, owner_id, type, title, path)
                values (${id}, ${owner}, ${type}::node_type, ${title}, ${path}::ltree)`);
    return id;
  };
  const homeIn = async (id: string, ws: string) => {
    await m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`delete from item_grants where node_id = ${id}`);
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, is_home)
                           values (${id}, ${ws}, true)
                           on conflict (node_id, workspace_id)
                           do update set is_home = true, via_folder_id = null, excluded = false`);
    });
  };
  /** Twin items set up by `prep` (as the owner), then `op` on each, as
   *  `actor`: A by the route, B by the tool. */
  const twins = async (
    prep: (id: string) => Promise<void>,
    actor: string,
    op: Op,
    ws: string,
    confirm?: boolean,
    make: () => Promise<string> = () => node('note', 'twin', 'notes'),
  ) => {
    const a = await make();
    const b = await make();
    await as(owner);
    await prep(a);
    await prep(b);
    await as(actor);
    const route = await viaRoute(op, a, ws, confirm);
    const tool = await viaTool(op, b, ws, confirm);
    return { a, b, route, tool };
  };
  const agree = async (r: Awaited<ReturnType<typeof twins>>) => {
    expect(r.tool.ok).toBe(r.route.ok);
    expect(r.tool.code).toBe(r.route.code);
    if (!r.route.ok)
      expect(r.tool.error!.startsWith(`${r.route.code}: ${r.route.error}`)).toBe(true);
    expect(await rowsOf(r.b)).toEqual(await rowsOf(r.a));
    const [ea, eb] = [await eventsOf(r.a), await eventsOf(r.b)];
    // The same rows; the screen's name no source, the tool's its connection.
    expect(eb.map((e) => ({ ...e, via: null }))).toEqual(ea);
    expect(ea.every((e) => e.via === null)).toBe(true);
    expect(eb.every((e) => e.via === 'mcp-oauth')).toBe(true);
  };

  beforeAll(async () => {
    const ts: Ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    process.env.SESSION_SECRET ??= 'grants-mcp-db-test-secret-at-least-32-chars';
    m = await import('@mantle/db');
    t = await import('@mantle/tools');
    await x(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${owner}, ${email(owner, 'owner')}, 'x', true, 'admin', 'Olive Owner'),
      (${mem}, ${email(mem, 'mem')}, 'x', false, 'member', 'Mia Member'),
      (${mem2}, ${email(mem2, 'mem')}, 'x', false, 'member', 'Max Member'),
      (${mem3}, ${email(mem3, 'mem')}, 'x', false, 'member', 'Moe Member')`);
    // A second Admin login: the app pools may not make one (a new login is a
    // member), so the superuser does.
    await su(sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
      values (${adm}, ${email(adm, 'adm')}, 'x', false, 'admin', 'Ada Admin')`);
    await x(sql`insert into spaces (id, kind, login_id) values (${owner}, 'brain', ${owner})
      on conflict (id) do nothing`);
    await ts.runWorkspacesSwitch();
    await su(sql`insert into workspaces (id, owner_id, name) values
      (${P}, ${owner}, 'Proj'), (${Q}, ${owner}, 'Quay'), (${R}, ${owner}, 'Reef'),
      (${Z}, ${owner}, 'Zinc'), (${X}, ${owner}, 'Mia (only you)'), (${T2}, ${owner}, 'Tide')`);
    await su(sql`insert into private_workspaces (login_id, workspace_id) values (${mem}, ${X})`);
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${P}, ${owner}, true), (${P}, ${mem}, true),
      (${Q}, ${owner}, true), (${Q}, ${mem2}, true), (${Q}, ${mem}, false),
      (${R}, ${mem2}, true), (${Z}, ${owner}, true), (${X}, ${mem}, true),
      (${T2}, ${mem}, true)`);
    adminWs = (
      await x<{ id: string }>(
        sql`select id::text as id from workspaces where owner_id = ${owner} and is_admin`,
      )
    )[0]!.id;
    // An Admin user is a Moderator of Admin, and here in no other workspace.
    await su(sql`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${adm}, true) on conflict (workspace_id, login_id) do update set moderator = true`);
    await x(sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role, workspace_id)
      values (${agent}, ${owner}, 'gmcp-proj', 'Proj', 'fake/model', 'p', 'responder', ${P})`);
    // Outside System, whatever the switch did with Admin users.
    await su(sql`delete from workspace_users w using workspaces s
      where w.workspace_id = s.id and s.bridge_key = 'system' and w.login_id = ${adm}`);
    await m.asSystem(() => t.seedBuiltinTools(owner), 'test');
    await su(sql`update workspaces set archived_at = now() where id = ${Z}`);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await scratch?.drop();
  });

  const none = async () => undefined;
  const inP = (id: string) => homeIn(id, P);
  /** Setup only, under the item's heads as the old grants test does. */
  const grantRow = (id: string, ws: string, write = false) =>
    m.withHeads([id], 'update', async (tx) => {
      await tx.execute(sql`insert into item_grants (node_id, workspace_id, write)
                           values (${id}, ${ws}, ${write})`);
    });
  const inPandQ = async (id: string) => {
    await homeIn(id, P);
    await grantRow(id, Q);
  };

  it('the changes a Moderator may make: add (read, write), Write on and off, revoke', async () => {
    for (const [op, ws, prep] of [
      ['add', P, none],
      ['addWrite', P, none],
      ['writeOn', Q, inPandQ],
      [
        'writeOff',
        Q,
        async (id: string) => {
          await homeIn(id, P);
          await grantRow(id, Q, true);
        },
      ],
      ['remove', Q, inPandQ],
    ] as const) {
      const r = await twins(prep, owner, op, ws);
      expect(r.route.ok, op).toBe(true);
      await agree(r);
      // Logged with the login as its actor, on the workspace it touched.
      const ev = await eventsOf(r.b);
      expect(ev.length, op).toBe(1);
      expect(ev[0]).toMatchObject({ ws, actor: owner });
    }
  });

  it('every refusal of the panel, in its own words', async () => {
    // mem moderates P (the home) but only uses Q: no add there.
    await agree(await twins(inP, mem, 'add', Q));
    // mem2 moderates Q and R but not the home P: no add to R.
    await agree(await twins(inPandQ, mem2, 'add', R));
    // Already in that workspace.
    await agree(await twins(inPandQ, owner, 'add', Q));
    // Write on needs both Moderators: mem has the home only.
    await agree(await twins(inPandQ, mem, 'writeOn', Q));
    // The home row never goes.
    await agree(await twins(inP, owner, 'remove', P));
    // An archived workspace names nothing.
    await agree(await twins(none, owner, 'add', Z));
    // Another login's private workspace: the owner does not moderate it.
    await agree(await twins(none, owner, 'add', X));
    // mem3 reads nothing of the item: not found, never forbidden.
    await agree(await twins(inP, mem3, 'remove', P));
    // An Admin-only kind stays in Admin.
    const contact = () => node('contact', 'Someone', 'contacts');
    const k = await twins(none, owner, 'add', P, undefined, contact);
    expect(k.route.code).toBe('kind_not_allowed');
    await agree(k);
    // A narrowing by a Moderator of the workspace alone (not of the home).
    const n = await twins(inPandQ, mem2, 'remove', Q);
    expect(n.route.ok).toBe(true);
    await agree(n);
  });

  it('folders: the confirm, what flows down, "Removed here", a derived row', async () => {
    // A folder's items sit at its path (the tree's own shape).
    const folderWithChild = async () => {
      const path = `notes.f${randomUUID().slice(0, 8).replace(/-/g, '')}`;
      const f = await node('branch', 'Shared', path);
      await node('note', 'inside', path);
      return f;
    };
    // Without the confirm: refused, the count said.
    const noConfirm = await twins(none, owner, 'add', P, undefined, folderWithChild);
    expect(noConfirm.route.code).toBe('confirm_required');
    expect(noConfirm.tool.error).toMatch(/confirm: true/);
    await agree(noConfirm);
    // With it: the folder and what it holds.
    const yes = await twins(none, owner, 'add', P, true, folderWithChild);
    expect(yes.route.ok).toBe(true);
    await agree(yes);
    const childOf = async (f: string) =>
      (
        await x<{ id: string }>(sql`select c.id::text as id from nodes c, nodes f
          where f.id = ${f} and c.path <@ f.path and c.id <> f.id`)
      )[0]!.id;
    const [ca, cb] = [await childOf(yes.a), await childOf(yes.b)];
    expect(await rowsOf(cb)).toEqual(await rowsOf(ca));
    expect((await rowsOf(cb)).find((r) => r.ws === P)).toMatchObject({ via: 'folder' });
    // A derived row's Write: the panel says to change it on the folder.
    await as(owner);
    const dr = await viaRoute('writeOn', ca, P);
    const dt = await viaTool('writeOn', cb, P);
    expect(dr.code).toBe('derived_row');
    expect(dt.code).toBe('derived_row');
    expect(dt.error!.startsWith(`derived_row: ${dr.error}`)).toBe(true);
    // Taking the folder's row away on the child: "Removed here".
    expect((await viaRoute('remove', ca, P)).ok).toBe(true);
    const removed = await viaTool('remove', cb, P);
    expect(removed.ok).toBe(true);
    expect(await rowsOf(cb)).toEqual(await rowsOf(ca));
    expect((await rowsOf(cb)).find((r) => r.ws === P)).toMatchObject({ excluded: true });
    expect((removed.output!.grants as Json[]).find((g) => g.workspaceId === P)).toMatchObject({
      removedHere: true,
    });
    // Adding it back on the child makes it a grant set on the item.
    expect((await viaRoute('add', ca, P)).ok).toBe(true);
    expect((await viaTool('add', cb, P)).ok).toBe(true);
    expect(await rowsOf(cb)).toEqual(await rowsOf(ca));
  });

  it('a workspace by its exact name; an unknown name is not found', async () => {
    const it1 = await node('note', 'by name', 'notes');
    await as(owner);
    const out = await viaTool('add', it1, 'Proj');
    expect(out.ok).toBe(true);
    expect(out.output).toMatchObject({ item: { id: it1 }, home: 'Admin' });
    expect((out.output!.grants as Json[]).map((g) => [g.workspace, g.write])).toEqual([
      ['Admin', false],
      ['Proj', false],
    ]);
    expect((await viaTool('add', it1, 'proj')).code).toBe('not_found');
    expect((await viaTool('add', it1, 'Nowhere')).code).toBe('not_found');
  });

  it('row security holds after a change by the tool', async () => {
    const reads = async (login: string, id: string) => {
      await as(login);
      return (
        await inScope(
          async () =>
            (await m.db.execute(sql`select id from nodes where id = ${id}`)) as unknown as Json[],
          false,
        )
      ).length;
    };
    const note = await node('note', 'secret', 'notes');
    expect(await reads(mem, note)).toBe(0);
    await as(owner);
    expect((await viaTool('add', note, P)).ok).toBe(true);
    expect(await reads(mem, note)).toBe(1); // in P
    expect(await reads(mem2, note)).toBe(0); // not in P
    expect(await reads(mem3, note)).toBe(0); // in nothing
    // A folder's grant flows to what it holds.
    const path = `notes.g${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const f = await node('branch', 'Flow', path);
    const child = await node('note', 'inside', path);
    expect(await reads(mem2, child)).toBe(0);
    await as(owner);
    expect((await viaTool('add', f, Q, true)).ok).toBe(true);
    expect(await reads(mem2, child)).toBe(1); // in Q, through the folder
    expect(await reads(mem3, child)).toBe(0);
    // And back: the revoke takes the reads away.
    await as(owner);
    expect((await viaTool('remove', f, Q, true)).ok).toBe(true);
    expect(await reads(mem2, child)).toBe(0);
  });

  it("access_get answers what the caller's own panel shows: a member, an Admin user, the owner", async () => {
    const one = await import('@/app/api/grants/[nodeId]/route');
    // Homed in P, granted to Q and R: mem sees P and Q, mem2 sees Q and R
    // and no home name, adm (Admin, users area) and the owner see all.
    const it1 = await node('note', 'read me', 'notes');
    await homeIn(it1, P);
    await grantRow(it1, Q);
    await grantRow(it1, R);
    // adm reads it through Admin (an Admin user reads only its workspaces).
    await grantRow(it1, adminWs);
    for (const login of [mem, mem2, adm, owner]) {
      await as(login);
      const r = await appAnswerOf(inScope(() => one.GET(req('GET'), p({ nodeId: it1 })), false));
      expect(r.status, login).toBe(200);
      const screen = (await r.json()) as Json;
      const tool = await toolAnswer(t.access_get, { node_id: it1 });
      expect(tool.ok, `${login} ${tool.error}`).toBe(true);
      expect(tool.output!.home, login).toBe(screen.home.name);
      expect(
        (tool.output!.grants as Json[]).map((g) => [g.workspaceId, g.workspace, g.write]),
        login,
      ).toEqual((screen.rows as Json[]).map((x) => [x.wsId, x.name, x.write]));
    }
    await as(mem2);
    const hidden = await toolAnswer(t.access_get, { node_id: it1 });
    expect(hidden.output!.home).toBeNull();
    expect((hidden.output!.grants as Json[]).map((g) => g.workspace)).toEqual(['Quay', 'Reef']);
    // An item the caller reads nothing of: not found, as on the screen.
    await as(mem3);
    expect((await toolAnswer(t.access_get, { node_id: it1 })).code).toBe('not_found');
  });

  it("an in-brain call's folder confirm never counts; a person's own connection's does", async () => {
    const path = `notes.h${randomUUID().slice(0, 8).replace(/-/g, '')}`;
    const f = await node('branch', 'Held', path);
    await node('note', 'inside', path);
    const before = await rowsOf(f);
    await as(owner);
    for (const caller of [
      { entry: 'pending', via: 'process' },
      { entry: 'turn', via: 'turn' },
      {},
    ]) {
      const res = await toolAnswer(
        t.access_grant_add,
        { node_id: f, workspace: P, confirm: true },
        caller,
      );
      expect(res.code, JSON.stringify(caller)).toBe('confirm_required');
      expect(res.error).toMatch(/Grant Access panel, which shows the count/);
    }
    expect(await rowsOf(f)).toEqual(before);
    expect(
      (await toolAnswer(t.access_grant_add, { node_id: f, workspace: P, confirm: true })).ok,
    ).toBe(true);
  });

  describe("an assistant's widening through the real queue and approval", () => {
    let rt: typeof import('@mantle/runtime/agent');
    let tracing: typeof import('@mantle/tracing');
    let ex: typeof import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    beforeAll(async () => {
      rt = await import('@mantle/runtime/agent');
      tracing = await import('@mantle/tracing');
      ex = await import('../../../packages/runtime/src/agent/tool-loop/execute-call');
    });

    /** mem asks the Proj assistant to widen `item`'s grants (default: Write
     *  on, on Proj's own row): the tool loop's own queue path. The pending
     *  row's id. A Proj assistant's turn reads Proj only, so that is all
     *  it can reach. */
    const ask = async (item: string, extra: Json = {}) => {
      const slug = 'access_grant_add';
      const input = { node_id: item, workspace: P, write: true, ...extra };
      const row = await m.asSystem(() => t.resolveTool(owner, slug), 'test');
      expect(row?.requiresConfirm).toBe(true);
      const pendingIds: string[] = [];
      await m.runAsActor(m.loginActor(mem, 'rw'), () =>
        rt.withAgentScope(
          { id: agent, ownerId: owner, workspaceId: P, role: 'responder' },
          () =>
            tracing.startTrace(
              { kind: 'responder_turn', ownerId: owner, agentId: agent, loginId: mem },
              () =>
                ex.executeToolCall({
                  args: {
                    ownerId: owner,
                    agentId: agent,
                    agentSlug: 'gmcp-proj',
                    surface: { kind: 'team', loginId: mem },
                  } as never,
                  slug,
                  call: {
                    id: `call-${randomUUID().slice(0, 6)}`,
                    function: { name: slug, arguments: JSON.stringify(input) },
                  },
                  tool: row!,
                  input,
                  argParseError: null,
                  argValidation: null,
                  argValidationMode: 'off',
                  lastUserMessage: undefined,
                  pendingIds,
                } as never),
            ),
          { loginId: mem },
        ),
      );
      expect(pendingIds).toHaveLength(1);
      return pendingIds[0]!;
    };
    /** The owner approves it, as a batch does. */
    const approve = (pending: string) =>
      m.runAsActor(m.loginActor(owner, 'owner'), () =>
        t.approvePendingCall(owner, pending, { approverLoginId: owner }),
      );
    const rowOf = async (pending: string) =>
      (
        await x<{ status: string; error: string | null }>(
          sql`select status::text as status, error from pending_tool_calls where id = ${pending}`,
        )
      )[0]!;
    const writeInP = async (item: string) =>
      (await rowsOf(item)).find((r) => r.ws === P)?.write === true;
    const inTide = async (item: string) => (await rowsOf(item)).some((r) => r.ws === T2);

    it("runs once, in the asker's scope, as the asker", async () => {
      const item = await node('note', 'asked', 'notes');
      await homeIn(item, P);
      const pending = await ask(item);
      // Held: nothing applied on the turn's say.
      expect(await writeInP(item)).toBe(false);
      expect(await approve(pending)).not.toBeNull();
      expect(await writeInP(item)).toBe(true);
      expect(await eventsOf(item)).toEqual([
        { ws: P, action: 'grant.write', actor: mem, excluded: null, via: 'pending' },
      ]);
      expect((await rowOf(pending)).status).toBe('approved');
      // Used once: a second approval finds nothing to decide.
      expect(await approve(pending)).toBeNull();
      expect(await eventsOf(item)).toHaveLength(1);
    });

    it('is refused when the asker lost Moderator of the home in between', async () => {
      const item = await node('note', 'asked then lost', 'notes');
      await homeIn(item, P);
      const pending = await ask(item);
      await su(sql`update workspace_users set moderator = false
        where workspace_id = ${P} and login_id = ${mem}`);
      try {
        let answer: unknown;
        try {
          answer = await approve(pending);
        } catch (err) {
          answer = err;
        }
        expect(await writeInP(item)).toBe(false);
        expect(await eventsOf(item)).toEqual([]);
        // Either the approval's re-check refused it (still pending), or it
        // ran in the asker's scope and the panel's rule refused it there.
        const after = await rowOf(pending);
        if (answer instanceof Error) expect(after.status).toBe('pending');
        else expect(after.error ?? '').toMatch(/forbidden/);
      } finally {
        await su(sql`update workspace_users set moderator = true
          where workspace_id = ${P} and login_id = ${mem}`);
      }
    });

    it("reaches no workspace outside the assistant's own, approved or not", async () => {
      // mem moderates Tide too, but a Proj assistant's turn reads Proj only.
      const item = await node('note', 'asked elsewhere', 'notes');
      await homeIn(item, P);
      const pending = await ask(item, { workspace: T2, write: false });
      await approve(pending);
      expect(await inTide(item)).toBe(false);
      expect((await rowOf(pending)).error ?? '').toMatch(/^not_found: Workspace not found/);
    });

    it('a folder: the approval is no confirm, so nothing changes', async () => {
      const path = `notes.q${randomUUID().slice(0, 8).replace(/-/g, '')}`;
      const f = await node('branch', 'Asked folder', path);
      await node('note', 'inside', path);
      await homeIn(f, P);
      const pending = await ask(f, { confirm: true });
      await approve(pending);
      expect(await writeInP(f)).toBe(false);
      expect((await rowOf(pending)).error ?? '').toMatch(/^confirm_required/);
    });
  });

  it('with no login scope the tools refuse and change nothing', async () => {
    const it1 = await node('note', 'no scope', 'notes');
    const before = await rowsOf(it1);
    for (const def of [t.access_grant_add, t.access_grant_remove]) {
      const res = await def.handler({ node_id: it1, workspace: P }, { ownerId: owner });
      expect(res).toEqual({ ok: false, error: t.GRANT_NEEDS_LOGIN });
    }
    expect(await rowsOf(it1)).toEqual(before);
  });
});
