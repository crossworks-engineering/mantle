/**
 * users_list and workspace_user_set (builtins-users.ts) on a real, migrated
 * Postgres, through the one dispatcher:
 *
 *  - as the Control Center's admin channel calls them: no scope, a system
 *    actor, the owner surface by api naming no login (so the box owner
 *    acts);
 *  - as an Admin user's own MCP call, in its write request: the definer
 *    acts for that login;
 *  - a member is refused by the gate (the users area), nothing written.
 *
 * users_list: logins with names, roles, flags and workspaces; shared live
 * workspaces only; paged. workspace_user_set: add, tick, take out; the same
 * place writes nothing; the owner, the Admin workspace, a private or
 * archived workspace, an unknown login, a new place for a disabled login
 * and the last Moderator are refused, and no role ever changes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/builtins-users.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
type Row = Record<string, unknown>;

describe.skipIf(!URL)('users_list and workspace_user_set', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']> | undefined;
  let m: typeof import('@mantle/db');
  let dispatch: typeof import('./dispatch');
  let callers: typeof import('./gate-callers');
  const tag = `fu${randomUUID().slice(0, 6)}`;
  const boss = randomUUID(); // an Admin user
  const ann = randomUUID(); // a member, moved between workspaces
  const ben = randomUUID(); // a member, the one Moderator of `solo`
  const off = randomUUID(); // a disabled member, in `team`
  const mine = randomUUID(); // a member with a private workspace
  const team = randomUUID();
  const solo = randomUUID();
  const gone = randomUUID(); // archived
  const own = randomUUID(); // mine's private workspace
  let anchor = '';
  let admin = '';
  const emailOf = (id: string) => `${tag}-${id.slice(0, 6)}@example.invalid`;

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    su = ts.superuserClient(scratch.url);
    await su`insert into auth.users (id, email, password_hash, role, display_name, last_login_at, disabled_at) values
      (${boss}, ${emailOf(boss)}, 'x', 'admin', 'Boss', null, null),
      (${ann}, ${emailOf(ann)}, 'x', 'member', ${'Ann‮ Example\u0007'}, now(), null),
      (${ben}, ${emailOf(ben)}, 'x', 'member', 'Ben', null, null),
      (${off}, ${emailOf(off)}, 'x', 'member', null, null, now()),
      (${mine}, ${emailOf(mine)}, 'x', 'member', null, null, null)`;
    anchor = await ts.ensureTestAnchor(su);
    admin = await ts.ensureAdminUsers(su, [boss]);
    await su`insert into workspaces (id, owner_id, name) values
      (${team}, ${anchor}, ${`${tag} Team`}),
      (${solo}, ${anchor}, ${`${tag} Solo`}),
      (${gone}, ${anchor}, ${`${tag} Gone`}),
      (${own}, ${anchor}, ${`${tag} Mine`})`;
    await su`update workspaces set archived_at = now() where id = ${gone}`;
    await su`insert into private_workspaces (login_id, workspace_id) values (${mine}, ${own})`;
    await su`insert into workspace_users (workspace_id, login_id, moderator) values
      (${team}, ${boss}, true), (${team}, ${off}, false),
      (${solo}, ${ben}, true), (${own}, ${mine}, true)`;
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    dispatch = await import('./dispatch');
    callers = await import('./gate-callers');
    await import('./gate-narrowers');
    await import('./builtins');
  }, 120_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
  });

  const row = (slug: string) =>
    ({ slug, handler: { kind: 'builtin', ref: slug }, inputSchema: {} }) as unknown as Tool;

  /** As the admin channel calls it: no scope, a system actor, the owner
   *  surface by api naming no login. */
  const channel = (slug: string, input: Record<string, unknown>) =>
    m.runAsSystem('test:fleet-users', () =>
      dispatch.dispatchTool(row(slug), input, {
        ownerId: anchor,
        surface: { kind: 'owner', via: 'api' },
        caller: { ...callers.apiV1Caller(), masks: true },
      }),
    );

  /** As `login`'s own MCP call, in its write request. */
  const asLogin = (login: string, slug: string, input: Record<string, unknown>) =>
    m.runInRequestSlot(async () => {
      const scope = await m.loginScopeFor(login);
      expect(m.enterRequestScope(scope, { writes: true, drafts: false })).toBe(true);
      return dispatch.dispatchTool(row(slug), input, {
        ownerId: anchor,
        surface: { kind: 'web', loginId: login },
        caller: callers.ownerWebCaller(),
      });
    });

  const place = async (login: string, ws: string) => {
    const [r] = await su!<Row[]>`select moderator from workspace_users
      where workspace_id = ${ws} and login_id = ${login}`;
    return r ? (r.moderator ? 'moderator' : 'user') : 'none';
  };
  const set = async (
    via: 'channel' | string,
    changes: { loginId: string; workspaceId: string; role: string }[],
  ) => {
    const r =
      via === 'channel'
        ? await channel('workspace_user_set', { changes })
        : await asLogin(via, 'workspace_user_set', { changes });
    expect(r.ok, r.ok ? '' : String(r.error)).toBe(true);
    return (r as { output: { results: Row[] } }).output.results;
  };

  it('users_list over the channel: names, roles, flags, workspaces; shared live ones only', async () => {
    const r = await channel('users_list', {});
    expect(r.ok, r.ok ? '' : String(r.error)).toBe(true);
    const out = (r as { output: Row }).output as {
      total: number;
      next: number | null;
      workspaces: { id: string; admin: boolean }[];
      logins: {
        id: string;
        name: string | null;
        owner: boolean;
        disabled: boolean;
        workspaces: { id: string; moderator: boolean }[];
      }[];
    };
    const ids = out.workspaces.map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([admin, team, solo]));
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(own);
    expect(out.workspaces.find((w) => w.id === admin)!.admin).toBe(true);
    const a = out.logins.find((l) => l.id === ann)!;
    expect(a.name).toBe('Ann Example');
    expect(out.logins.find((l) => l.id === off)!.disabled).toBe(true);
    expect(out.logins.find((l) => l.id === anchor)!.owner).toBe(true);
    expect(out.logins.find((l) => l.id === ben)!.workspaces).toContainEqual({
      id: solo,
      moderator: true,
    });
    for (const l of out.logins) expect(l.workspaces.map((w) => w.id)).not.toContain(own);
    expect(JSON.stringify(out)).not.toMatch(/password|hash/i);
    // Paged by email.
    const p1 = await channel('users_list', { limit: 2 });
    const o1 = (p1 as { output: { logins: unknown[]; next: number | null; total: number } }).output;
    expect(o1.logins).toHaveLength(2);
    expect(o1.next).toBe(2);
    expect(o1.total).toBe(out.total);
  });

  it('workspace_user_set over the channel: as the Team screen, the owner its actor', async () => {
    expect(await set('channel', [{ loginId: ann, workspaceId: team, role: 'user' }])).toEqual([
      { loginId: ann, workspaceId: team, ok: true, was: 'none' },
    ]);
    expect(await place(ann, team)).toBe('user');
    const [ev] = await su!<Row[]>`select actor_id from workspace_events
      where workspace_id = ${team} and subject->>'login' = ${ann} and action = 'user.add'`;
    expect(ev!.actor_id).toBe(anchor);
    // The same place: ok, no write.
    expect(await set('channel', [{ loginId: ann, workspaceId: team, role: 'user' }])).toEqual([
      { loginId: ann, workspaceId: team, ok: true, was: 'user' },
    ]);
    expect(await set('channel', [{ loginId: ann, workspaceId: team, role: 'moderator' }])).toEqual([
      { loginId: ann, workspaceId: team, ok: true, was: 'user' },
    ]);
    expect(await place(ann, team)).toBe('moderator');
    expect(await set('channel', [{ loginId: ann, workspaceId: team, role: 'none' }])).toEqual([
      { loginId: ann, workspaceId: team, ok: true, was: 'moderator' },
    ]);
    expect(await place(ann, team)).toBe('none');
  });

  it('refusals, each its own, and no role ever changes', async () => {
    const no = (loginId: string, workspaceId: string, reason: string, was?: string) => ({
      loginId,
      workspaceId,
      ok: false,
      ...(was ? { was } : {}),
      reason,
    });
    const nobody = randomUUID();
    const nowhere = randomUUID();
    const results = await set('channel', [
      { loginId: anchor, workspaceId: team, role: 'user' },
      { loginId: ann, workspaceId: admin, role: 'moderator' },
      { loginId: boss, workspaceId: admin, role: 'none' },
      { loginId: ann, workspaceId: own, role: 'user' },
      { loginId: ann, workspaceId: gone, role: 'user' },
      { loginId: nobody, workspaceId: team, role: 'user' },
      { loginId: ann, workspaceId: nowhere, role: 'user' },
      { loginId: off, workspaceId: solo, role: 'user' },
      { loginId: ben, workspaceId: solo, role: 'none' },
      // One that works among the refused: the others do not stop it.
      { loginId: ann, workspaceId: solo, role: 'user' },
    ]);
    expect(results).toEqual([
      no(anchor, team, 'owner'),
      no(ann, admin, 'admin'),
      no(boss, admin, 'admin'),
      no(ann, own, 'workspace'),
      no(ann, gone, 'workspace'),
      no(nobody, team, 'login'),
      no(ann, nowhere, 'workspace'),
      no(off, solo, 'disabled'),
      no(ben, solo, 'last-moderator', 'moderator'),
      { loginId: ann, workspaceId: solo, ok: true, was: 'none' },
    ]);
    // A disabled login is taken out of a workspace.
    expect(await set('channel', [{ loginId: off, workspaceId: team, role: 'none' }])).toEqual([
      { loginId: off, workspaceId: team, ok: true, was: 'user' },
    ]);
    const roles = await su!<Row[]>`select id::text, role from auth.users
      where id in (${ann}, ${boss}, ${off}) order by id`;
    expect(Object.fromEntries(roles.map((r) => [r.id, r.role]))).toEqual({
      [ann]: 'member',
      [boss]: 'admin',
      [off]: 'member',
    });
    expect(await place(ann, admin)).toBe('none');
    expect(await place(ann, own)).toBe('none');
    // Input it does not take: no write.
    const bad = await channel('workspace_user_set', {
      changes: [{ loginId: ann, workspaceId: team, role: 'admin' }],
    });
    expect(bad.ok).toBe(false);
    const twice = await channel('workspace_user_set', {
      changes: [
        { loginId: ann, workspaceId: team, role: 'user' },
        { loginId: ann, workspaceId: team, role: 'none' },
      ],
    });
    expect(twice.ok).toBe(false);
    expect(await place(ann, team)).toBe('none');
  });

  it("an Admin user's own call: the definer acts for that login", async () => {
    expect(await set(boss, [{ loginId: ben, workspaceId: team, role: 'user' }])).toEqual([
      { loginId: ben, workspaceId: team, ok: true, was: 'none' },
    ]);
    const [ev] = await su!<Row[]>`select actor_id from workspace_events
      where workspace_id = ${team} and subject->>'login' = ${ben} and action = 'user.add'`;
    expect(ev!.actor_id).toBe(boss);
    const list = await asLogin(boss, 'users_list', {});
    expect(list.ok, list.ok ? '' : String(list.error)).toBe(true);
  });

  it('users_list pages stay under the admin channel cap and cover every login once', async () => {
    // 60 more workspaces and 90 more logins, each in every one of them.
    const ws = Array.from({ length: 60 }, () => randomUUID());
    const people = Array.from({ length: 90 }, () => randomUUID());
    for (const w of ws) {
      await su!`insert into workspaces (id, owner_id, name) values (${w}, ${anchor}, ${`${tag} Big ${w.slice(0, 8)} with a long enough name`})`;
    }
    for (const id of people) {
      await su!`insert into auth.users (id, email, password_hash, role, display_name)
        values (${id}, ${`${tag}-big-${id}@example.invalid`}, 'x', 'member', ${`A rather long display name ${id}`})`;
      await su!`insert into workspace_users (workspace_id, login_id, moderator)
        select unnest(${ws}::uuid[]), ${id}::uuid, true`;
    }
    const seen = new Set<string>();
    let offset: number | null = 0;
    let pages = 0;
    let total = 0;
    while (offset !== null && pages < 50) {
      const r = await channel('users_list', { offset });
      expect(r.ok, r.ok ? '' : String(r.error)).toBe(true);
      const out = (
        r as { output: { logins: { id: string }[]; next: number | null; total: number } }
      ).output;
      expect(JSON.stringify(out).length).toBeLessThan(64_000);
      for (const l of out.logins) {
        expect(seen.has(l.id)).toBe(false);
        seen.add(l.id);
      }
      total = out.total;
      offset = out.next;
      pages++;
    }
    expect(offset).toBeNull();
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(1);
  });

  it('a member: refused by the gate, nothing written', async () => {
    const r = await asLogin(ann, 'workspace_user_set', {
      changes: [{ loginId: ben, workspaceId: solo, role: 'none' }],
    });
    expect(r.ok).toBe(false);
    expect((await asLogin(ann, 'users_list', {})).ok).toBe(false);
    expect(await place(ben, solo)).toBe('moderator');
  });
});
