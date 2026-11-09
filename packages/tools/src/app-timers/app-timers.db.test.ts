/**
 * App timers (migration 0355, docs/app-timers.md) on a real, migrated
 * Postgres and real SQLite files:
 *  - rights: a login that manages the app sets, lists and deletes its
 *    timers in its own write request; a member who reads the app but does
 *    not manage it cannot; a risky tool needs an Admin user;
 *  - the timer rule at set time: a write tool and an undeclared tool are
 *    refused;
 *  - the database's caps (5 per app, 100 per box) and the cascade: a
 *    deleted app's timers go with it;
 *  - the scheduler: two ticks at once claim each due timer once;
 *  - a run: the tool runs as the timer's login and appends a row to the
 *    app's own `_timer_runs`, which app SQL reads and never changes;
 *  - fail closed: the login gone, disabled, no longer managing the app, not
 *    an Admin user for a risky tool; a tool whose policy or
 *    declaration changed is refused at run time;
 *  - back-off after five failures in a row and recovery on a success;
 *  - app_timer_run and app_timer_set keep the floors and the back-off;
 *  - rows read at admin rules: gone once the app runs below them (any run,
 *    a failed one included), and when their timer is switched off or
 *    deleted;
 *  - a login with timers can be removed while the non-Admin reserve is
 *    full;
 *  - the run log's retention prune (per timer, and timers gone), the
 *    result cap and the database file cap.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/tools/src/app-timers/app-timers.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppTimerRow } from '@mantle/db';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

describe.skipIf(!URL)('app timers', () => {
  type Ts = typeof import('@mantle/db/test-support');
  let scratch: Awaited<ReturnType<Ts['createMigratedScratchDatabase']>> | undefined;
  let su: ReturnType<Ts['superuserClient']>;
  let m: typeof import('@mantle/db');
  let broker: typeof import('@mantle/content/app-broker');
  let builtins: typeof import('../builtins-app-timers');
  let store: typeof import('./store');
  let run: typeof import('./run');
  let tick: typeof import('./tick');
  let rules: typeof import('./rules');
  let dir = '';
  const tag = `tmr${randomUUID().slice(0, 6)}`;
  const admin = randomUUID();
  /** An Admin user disabled later. */
  const admin3 = randomUUID();
  const member = randomUUID();
  const mod = randomUUID();
  /** A second Moderator of Team, no Admin user (the Admin users' reserve). */
  const mod2 = randomUUID();
  let anchor = '';
  let adminWs = '';
  let teamWs = '';
  const apps: { admin: string; team: string } & Record<string, string> = { admin: '', team: '' };
  const DECLARED = ['calculate', 'app_tools_set', 'peer_status'];
  const ARGS = { expression: '1 + 1' };

  const sys = <T>(fn: () => Promise<T>) => m.runAsSystem('test:app-timers', fn);

  /** An app homed in `home`, declaring DECLARED; readable by `alsoWs`. */
  async function makeApp(key: string, home: string, alsoWs?: string): Promise<string> {
    const id = randomUUID();
    await sys(async () => {
      await m.systemDb.execute(m.sql`insert into nodes (id, owner_id, type, title, path)
        values (${id}, ${anchor}, 'app', ${`${tag} ${key}`}, 'apps')`);
      await m.systemDb.execute(m.sql`insert into apps (node_id, manifest)
        values (${id}, ${JSON.stringify({ toolSlugs: DECLARED })}::jsonb)`);
      // The insert made its home (the create home: Admin); move it.
      await m.withHeads([id], 'update', (tx) =>
        tx.execute(m.sql`update item_grants set workspace_id = ${home}
          where node_id = ${id} and is_home`),
      );
      if (alsoWs) {
        await m.withHeads([id], 'update', (tx) =>
          tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write, is_home)
            values (${id}, ${alsoWs}, false, false)`),
        );
      }
    });
    apps[key] = id;
    return id;
  }

  /** A tool handler in `login`'s own write request, as its MCP connection
   *  or web chat runs it. */
  const call = (login: string, slug: string, input: Record<string, unknown>) =>
    m.runInRequestSlot(async () => {
      m.setRequestActor(m.loginActor(login, 'rw'));
      m.enterRequestScope(await m.loginScopeFor(login), { writes: true, drafts: false });
      const def = builtins.APP_TIMER_TOOLS.find((t) => t.slug === slug)!;
      return def.handler(input, { ownerId: anchor, surface: { kind: 'web', loginId: login } });
    });
  const ok = <T>(r: { ok: boolean; output?: unknown; error?: string }): T => {
    if (!r.ok) throw new Error(r.error);
    return r.output as T;
  };
  const timerRow = async (appId: string, name: string): Promise<AppTimerRow> => {
    const [row] = await sys(() =>
      m.db
        .select()
        .from(m.appTimers)
        .where(m.sql`app_node_id = ${appId} and name = ${name}`),
    );
    if (!row) throw new Error(`no timer ${name}`);
    return row;
  };
  const runs = (appId: string) =>
    sys(
      () =>
        broker.appDbQuery(
          anchor,
          appId,
          'SELECT timer_id, ok, result, error, ran_at, level FROM _timer_runs ORDER BY id',
        ) as Promise<
          {
            timer_id: string;
            ok: number;
            result: string | null;
            error: string | null;
            ran_at: string;
          }[]
        >,
    );
  const runOnce = async (
    appId: string,
    name: string,
    opts: Parameters<typeof run.runAppTimer>[2] = {},
  ) => {
    const t = await timerRow(appId, name);
    return sys(() => run.runAppTimer(t, [t.id], opts));
  };
  /** Delete apps (as the product deletes a node: its heads held). */
  const dropApps = (ids: string[]) =>
    sys(() =>
      m.withNodeDeleteHeads(ids, (tx) =>
        tx.execute(m.sql`delete from nodes where id = any(${`{${ids.join(',')}}`}::uuid[])`),
      ),
    );
  /** Only these timers are due (every other one far ahead). */
  const onlyDue = async (ids: string[]) => {
    await su`update app_timers set next_run_at = now() + interval '1 day', claim_id = null`;
    if (ids.length) {
      await su`update app_timers set next_run_at = now() - interval '1 minute' where id = any(${ids}::uuid[])`;
    }
  };

  beforeAll(async () => {
    const ts = await import('@mantle/db/test-support');
    scratch = await ts.createMigratedScratchDatabase(URL!);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    dir = await mkdtemp(path.join(tmpdir(), 'app-timers-db-'));
    process.env.APP_DB_DIR = dir;
    su = ts.superuserClient(scratch.url);
    const email = (id: string) => `${tag}-${id.slice(0, 6)}@example.invalid`;
    await su`insert into auth.users (id, email, password_hash, role, display_name) values
      (${admin}, ${email(admin)}, 'x', 'admin', 'Ada Admin'),
      (${admin3}, ${email(admin3)}, 'x', 'admin', null),
      (${member}, ${email(member)}, 'x', 'member', null),
      (${mod}, ${email(mod)}, 'x', 'member', null),
      (${mod2}, ${email(mod2)}, 'x', 'member', null)`;
    anchor = await ts.ensureTestAnchor(su);
    adminWs = await ts.ensureAdminUsers(su, [admin, admin3]);
    const [team] = await su<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${anchor}, ${`${tag} Team`}) returning id::text`;
    teamWs = team!.id;
    await su`insert into workspace_users (workspace_id, login_id, moderator) values
      (${teamWs}, ${member}, false), (${teamWs}, ${mod}, true), (${teamWs}, ${mod2}, true)`;
    m = await import('@mantle/db');
    m.openLoginWritePool({ max: 2 });
    await import('../gate-narrowers');
    await import('../builtins');
    const seed = await import('../seed');
    await sys(() => seed.seedBuiltinTools(anchor));
    // An enabled group that holds calculate: what a member's app run (the
    // team rules) may call.
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${`${tag}-reads`}, 'reads', '{calculate}', true)`;
    broker = await import('@mantle/content/app-broker');
    builtins = await import('../builtins-app-timers');
    store = await import('./store');
    run = await import('./run');
    tick = await import('./tick');
    rules = await import('./rules');
    await makeApp('admin', adminWs);
    await makeApp('team', teamWs);
  }, 180_000);

  afterAll(async () => {
    await m?.closeDb();
    await su?.end();
    await scratch?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('a login that manages the app sets, lists, changes and deletes a timer', async () => {
    const set = ok<{ created: boolean; timer: { runs_as: string; every_minutes: number } }>(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'calc',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    expect(set).toMatchObject({ created: true, timer: { runs_as: admin, every_minutes: 5 } });
    const changed = ok<{ created: boolean; timer: { every_minutes: number } }>(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'calc',
        tool: 'calculate',
        args: ARGS,
        every_minutes: 15,
      }),
    );
    expect(changed).toMatchObject({ created: false, timer: { every_minutes: 15 } });
    const list = ok<{ timers: { name: string }[] }>(
      await call(admin, 'app_timer_list', { app_id: apps.admin }),
    );
    expect(list.timers.map((t) => t.name)).toEqual(['calc']);
    // Bad input answers in words, nothing written.
    for (const bad of [
      { every_minutes: 0 },
      { every_minutes: 1441 },
      { keep_days: 401 },
      { args: [1] },
      { args: { big: 'x'.repeat(9000) } },
      { name: 'Bad Name' },
    ]) {
      const r = await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'calc2',
        tool: 'calculate',
        ...bad,
      });
      expect(r.ok, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
    const tmp = ok<{ created: boolean }>(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'tmp',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    expect(tmp.created).toBe(true);
    expect((await call(admin, 'app_timer_delete', { app_id: apps.admin, name: 'tmp' })).ok).toBe(
      true,
    );
    expect((await call(admin, 'app_timer_delete', { app_id: apps.admin, name: 'tmp' })).ok).toBe(
      false,
    );
  });

  it('a member who reads the app but does not manage it cannot set one, nor read its timers', async () => {
    await expect(
      call(member, 'app_timer_set', {
        app_id: apps.team,
        name: 'm',
        tool: 'calculate',
        args: ARGS,
      }),
    ).rejects.toThrow();
    // The Team's Moderator manages it and sets one.
    ok(
      await call(mod, 'app_timer_set', {
        app_id: apps.team,
        name: 'modcalc',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    const seen = ok<{ timers: unknown[] }>(
      await call(member, 'app_timer_list', { app_id: apps.team }),
    );
    expect(seen.timers).toEqual([]);
    await expect(
      call(member, 'app_timer_delete', { app_id: apps.team, name: 'modcalc' }),
    ).rejects.toThrow();
    // An app the member does not read: the answer of none.
    const none = await call(member, 'app_timer_list', { app_id: apps.admin });
    expect(none).toEqual({ ok: false, error: `app ${apps.admin} not found` });
    expect(await call(member, 'app_timer_list', { app_id: randomUUID() })).toMatchObject({
      ok: false,
    });
  });

  it('the timer rule at set time: a write tool, an undeclared tool and (below Admin) a risky one are refused', async () => {
    const write = await call(admin, 'app_timer_set', {
      app_id: apps.admin,
      name: 'w',
      tool: 'app_tools_set',
    });
    expect(write.ok).toBe(false);
    expect(!write.ok && write.error).toMatch(/read and spend nothing/);
    const undeclared = await call(admin, 'app_timer_set', {
      app_id: apps.admin,
      name: 'u',
      tool: 'box_status',
    });
    expect(!undeclared.ok && undeclared.error).toMatch(/does not declare/);
    const risky = await call(mod, 'app_timer_set', {
      app_id: apps.team,
      name: 'peers',
      tool: 'peer_status',
    });
    expect(!risky.ok && risky.error).toMatch(/only an Admin user/);
    ok(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'peers',
        tool: 'peer_status',
      }),
    );
  });

  it("the database's caps (5 an app, 20 a login, 100 a box with 20 kept for Admin users) and the cascade with the app", async () => {
    const capApp = await makeApp('cap', adminWs);
    for (let i = 0; i < 5; i++) {
      ok(
        await call(admin, 'app_timer_set', {
          app_id: capApp,
          name: `c${i}`,
          tool: 'calculate',
          args: ARGS,
        }),
      );
    }
    await expect(
      call(admin, 'app_timer_set', { app_id: capApp, name: 'c5', tool: 'calculate', args: ARGS }),
    ).rejects.toThrow(/at most 5 timers/);
    const filler: string[] = [];
    /** `n` system rows set by `login` (null: no login), 5 to an app. */
    const fill = async (n: number, login: string | null, home = adminWs) => {
      for (let done = 0; done < n;) {
        const id = await makeApp(`fill${filler.length}`, home);
        filler.push(id);
        for (let i = 0; i < 5 && done < n; i++, done++) {
          await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, created_by)
            values (${anchor}, ${id}, ${`f${i}`}, 'calculate', ${login})`;
        }
      }
    };
    const count = async (where: 'all' | 'mod' | 'nonAdmin') =>
      (
        await su<{ n: number }[]>`select count(*)::int as n from app_timers t where
          ${where === 'mod' ? su`t.created_by = ${mod}` : where === 'nonAdmin' ? su`not coalesce(mantle_login_is_admin(t.created_by), false)` : su`true`}`
      )[0]!.n;
    // 20 a login: the Team's Moderator at 20, the 21st refused; a re-stamp
    // onto it too (the cap holds on an update of created_by).
    await fill(20 - (await count('mod')), mod, teamWs);
    await expect(
      call(mod, 'app_timer_set', {
        app_id: apps.team,
        name: 'one-more',
        tool: 'calculate',
        args: ARGS,
      }),
    ).rejects.toThrow(/at most 20 app timers/);
    const [other] = await su<{ id: string }[]>`
      select id::text from app_timers where created_by is distinct from ${mod} limit 1`;
    await expect(
      su`update app_timers set created_by = ${mod} where id = ${other!.id}`,
    ).rejects.toThrow(/at most 20 app timers/);
    // A login that is no Admin user, with a timer, removed below.
    const leaver = randomUUID();
    await su`insert into auth.users (id, email, password_hash, role)
      values (${leaver}, ${`${tag}-leaver@example.invalid`}, 'x', 'member')`;
    const leaverApp = await makeApp('leaver', teamWs);
    filler.push(leaverApp);
    await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, created_by)
      values (${anchor}, ${leaverApp}, 'l', 'calculate', ${leaver})`;
    // 80 set by logins that are no Admin user: the next one is refused for
    // them, not for an Admin user.
    await fill(80 - (await count('nonAdmin')), null);
    await expect(
      call(mod2, 'app_timer_set', {
        app_id: apps.team,
        name: 'reserve',
        tool: 'calculate',
        args: ARGS,
      }),
    ).rejects.toThrow(/kept for Admin users/);
    // Past the reserve (an Admin user with a timer who is no Admin user any
    // more: 81 rows of logins that are not), removing a login that set a
    // timer still works: its timers' created_by goes NULL, a removal the
    // caps never refuse.
    const demoted = randomUUID();
    await su`insert into auth.users (id, email, password_hash, role)
      values (${demoted}, ${`${tag}-demoted@example.invalid`}, 'x', 'member')`;
    await su`insert into workspace_users (workspace_id, login_id, moderator)
      values (${adminWs}, ${demoted}, true)`;
    const demotedApp = await makeApp('demoted', adminWs);
    filler.push(demotedApp);
    await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, created_by)
      values (${anchor}, ${demotedApp}, 'd', 'calculate', ${demoted})`;
    await su`delete from workspace_users where workspace_id = ${adminWs} and login_id = ${demoted}`;
    expect(await count('nonAdmin')).toBe(81);
    await su`delete from auth.users where id = ${leaver}`;
    const [orphan] = await su<{ by: string | null }[]>`
      select created_by::text as by from app_timers where app_node_id = ${leaverApp}`;
    expect(orphan).toEqual({ by: null });
    const spare = await makeApp('spare', adminWs);
    ok(
      await call(admin, 'app_timer_set', {
        app_id: spare,
        name: 'one',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    // 100 a box: filled by the anchor (an Admin user), the next refused.
    await fill(100 - (await count('all')), anchor);
    await expect(
      call(admin, 'app_timer_set', { app_id: spare, name: 'two', tool: 'calculate', args: ARGS }),
    ).rejects.toThrow(/at most 100 app timers/);
    // A deleted app's timers go with it.
    await dropApps(filler);
    const after = (
      await su<{ left: number }[]>`
        select count(*)::int as left from app_timers where app_node_id = any(${filler}::uuid[])`
    )[0]!.left;
    expect(after).toBe(0);
    await dropApps([capApp, spare]);
  });

  it('two ticks at once claim each due timer once; a live claim is kept from a set and a run-now', async () => {
    const many = await makeApp('many', adminWs);
    for (let i = 0; i < 5; i++) {
      ok(
        await call(admin, 'app_timer_set', {
          app_id: many,
          name: `t${i}`,
          tool: 'calculate',
          args: ARGS,
        }),
      );
    }
    const ids = (
      await su<{ id: string }[]>`select id::text from app_timers where app_node_id = ${many}`
    ).map((r) => r.id);
    await onlyDue(ids);
    /** One tick's lane: claim until nothing is due. */
    const drain = async () => {
      const got: AppTimerRow[] = [];
      for (;;) {
        const t = await store.claimNextDueAppTimer();
        if (!t) return got;
        got.push(t);
      }
    };
    const [a, b] = await sys(() => Promise.all([drain(), drain()]));
    const got = [...a!, ...b!].map((t) => t.id);
    expect(new Set(got).size).toBe(got.length);
    expect(got.sort()).toEqual([...ids].sort());
    // Claimed: no tick claims it again while the claim is live.
    expect(await sys(() => store.claimNextDueAppTimer())).toBeNull();
    const t = a![0] ?? b![0]!;
    // A set during the run keeps the claim; a run-now is refused.
    ok(
      await call(admin, 'app_timer_set', {
        app_id: many,
        name: t.name,
        tool: 'calculate',
        args: ARGS,
        every_minutes: 7,
      }),
    );
    expect((await timerRow(many, t.name)).claimId).toBe(t.claimId);
    const now = await call(admin, 'app_timer_run', { app_id: many, name: t.name });
    expect(!now.ok && now.error).toMatch(/is running now/);
    // Only the claim's holder writes the outcome; the next run is the
    // row's own interval as it is now (7), at least the floor given.
    const outcome = { ranAt: new Date(), ok: true, ms: 1, error: null, minMinutes: 1 };
    expect(await sys(() => store.finishAppTimerRun(t.id, randomUUID(), outcome))).toBe(false);
    expect(await sys(() => store.finishAppTimerRun(t.id, t.claimId!, outcome))).toBe(true);
    const done = await timerRow(many, t.name);
    expect(done.claimId).toBeNull();
    const ahead = done.nextRunAt.getTime() - Date.now();
    expect(ahead).toBeGreaterThan(6.5 * 60_000);
    expect(ahead).toBeLessThan(7 * 60_000 + 45_000);
    // A claim past its 5 minutes is due again (a worker that died).
    const u = a![1] ?? b![1]!;
    await su`update app_timers set claimed_at = now() - interval '6 minutes' where id = ${u.id}`;
    expect((await sys(() => store.claimNextDueAppTimer()))?.id).toBe(u.id);
    await dropApps([many]);
  });

  it("a timer's floor: 5 minutes for a login that is no Admin user, at set and at run", async () => {
    const r = await call(mod, 'app_timer_set', {
      app_id: apps.team,
      name: 'fast',
      tool: 'calculate',
      args: ARGS,
      every_minutes: 1,
    });
    expect(!r.ok && r.error).toMatch(/at least 5/);
    // Args the tool does not take are refused.
    const bad = await call(admin, 'app_timer_set', {
      app_id: apps.admin,
      name: 'badargs',
      tool: 'calculate',
      args: { nope: 1 },
    });
    expect(!bad.ok && bad.error).toMatch(/^args: /);
    // A 1-minute timer of a member (as an older row): it runs every 5.
    await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, args, every_minutes, created_by)
      values (${anchor}, ${apps.team}, 'fast', 'calculate', ${su.json(ARGS)}, 1, ${mod})`;
    const t = await timerRow(apps.team, 'fast');
    await onlyDue([t.id]);
    expect(await sys(() => tick.runDueAppTimers({ jitterMs: 0 }))).toMatchObject({ ok: 1 });
    const after = await timerRow(apps.team, 'fast');
    expect(after.nextRunAt.getTime() - Date.now()).toBeGreaterThan(4.5 * 60_000);
    await su`delete from app_timers where id = ${t.id}`;
  });

  it('a run calls the tool as its login and appends a row the app reads and never changes', async () => {
    const res = await runOnce(apps.admin, 'calc');
    expect(res.error).toBeNull();
    expect(res.ok).toBe(true);
    const rows = await runs(apps.admin);
    const calc = await timerRow(apps.admin, 'calc');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ timer_id: calc.id, ok: 1, error: null });
    expect(rows[0]!.result).toContain('2');
    // App SQL reads it, never changes it.
    await expect(
      sys(() => broker.appDbExec(anchor, apps.admin, 'DELETE FROM _timer_runs')),
    ).rejects.toThrow(/authoriz/i);
    await expect(
      sys(() => broker.appDbExec(anchor, apps.admin, 'DROP TABLE _timer_runs')),
    ).rejects.toThrow(/authoriz/i);
    expect(await runs(apps.admin)).toHaveLength(1);
    // A member's timer runs at team rules, with the member's own rights.
    expect(await runOnce(apps.team, 'modcalc')).toMatchObject({ ok: true });
  });

  it('fails closed: the login gone, disabled, no longer managing the app, or no Admin user for a risky tool', async () => {
    const E = rules.APP_TIMER_ERRORS;
    // Gone: the timer's login NULL (a removed login sets it NULL).
    ok(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'gone',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    await su`update app_timers set created_by = null where app_node_id = ${apps.admin} and name = 'gone'`;
    expect(await runOnce(apps.admin, 'gone')).toMatchObject({ ok: false, error: E.loginGone });
    // Disabled.
    ok(
      await call(admin3, 'app_timer_set', {
        app_id: apps.admin,
        name: 'off',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    await su`update auth.users set disabled_at = now() where id = ${admin3}`;
    expect(await runOnce(apps.admin, 'off')).toMatchObject({ ok: false, error: E.loginCannot });
    // No longer managing the app: the Moderator tick taken off.
    await su`update workspace_users set moderator = false where workspace_id = ${teamWs} and login_id = ${mod}`;
    expect(await runOnce(apps.team, 'modcalc')).toMatchObject({ ok: false, error: E.loginCannot });
    await su`update workspace_users set moderator = true where workspace_id = ${teamWs} and login_id = ${mod}`;
    // A risky tool whose setter is no Admin user (as after a policy change:
    // set-time refuses it, see above): the timer rule refuses it at run.
    await su`insert into app_timers (owner_id, app_node_id, name, tool_slug, created_by)
      values (${anchor}, ${apps.team}, 'risky', 'peer_status', ${mod})`;
    expect(await runOnce(apps.team, 'risky')).toMatchObject({
      ok: false,
      error: E.toolNotAllowed,
    });
    // Every failure is in the run log with its fixed text (the login gone
    // records nothing: no one to run it as).
    const errors = [...(await runs(apps.admin)), ...(await runs(apps.team))]
      .filter((r) => r.ok === 0)
      .map((r) => r.error);
    expect(errors).toEqual(expect.arrayContaining([E.loginCannot, E.toolNotAllowed]));
    expect(errors).not.toContain(E.loginGone);
  });

  it('with MANTLE_NO_AUTO_TABLES a timer on a Table tool is refused at run time, at both rules', async () => {
    const E = rules.APP_TIMER_ERRORS;
    const declare = (id: string) =>
      sys(() =>
        m.systemDb.execute(m.sql`update apps
          set manifest = ${JSON.stringify({ toolSlugs: ['table_list'] })}::jsonb
          where node_id = ${id}`),
      );
    const holder = await makeApp('tables-admin', adminWs);
    const teamHeld = await makeApp('tables-team', teamWs);
    await declare(holder);
    await declare(teamHeld);
    await su`insert into tool_groups (owner_id, slug, name, tool_slugs, enabled)
      values (${anchor}, ${`${tag}-tables`}, 'tables', '{table_list}', true)`;
    try {
      ok(await call(admin, 'app_timer_set', { app_id: holder, name: 't', tool: 'table_list' }));
      ok(await call(mod, 'app_timer_set', { app_id: teamHeld, name: 't', tool: 'table_list' }));
      expect(await runOnce(holder, 't')).toMatchObject({ ok: true });
      expect(await runOnce(teamHeld, 't')).toMatchObject({ ok: true });
      vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
      expect(await runOnce(holder, 't')).toMatchObject({ ok: false, error: E.refused });
      expect(await runOnce(teamHeld, 't')).toMatchObject({ ok: false, error: E.refused });
    } finally {
      vi.unstubAllEnvs();
      await su`delete from tool_groups where owner_id = ${anchor} and slug = ${`${tag}-tables`}`;
      await dropApps([holder, teamHeld]);
    }
  });

  it('a tool whose policy or declaration changed is refused at run time', async () => {
    const E = rules.APP_TIMER_ERRORS;
    await su`update tools set requires_confirm = true where owner_id = ${anchor} and slug = 'calculate'`;
    expect(await runOnce(apps.admin, 'calc')).toMatchObject({ ok: false, error: E.toolNotAllowed });
    await su`update tools set requires_confirm = false where owner_id = ${anchor} and slug = 'calculate'`;
    await su`update apps set manifest = ${JSON.stringify({ toolSlugs: ['peer_status'] })}::jsonb where node_id = ${apps.admin}`;
    expect(await runOnce(apps.admin, 'calc')).toMatchObject({ ok: false, error: E.toolNotAllowed });
    await su`update apps set manifest = ${JSON.stringify({ toolSlugs: DECLARED })}::jsonb where node_id = ${apps.admin}`;
    expect(await runOnce(apps.admin, 'calc')).toMatchObject({ ok: true });
  });

  it('backs off after five failures in a row and recovers on a success', async () => {
    const t = await timerRow(apps.admin, 'calc');
    await onlyDue([t.id]);
    await su`update app_timers set fail_count = 4, created_by = null where id = ${t.id}`;
    const failed = await sys(() => tick.runDueAppTimers({ jitterMs: 0 }));
    expect(failed).toMatchObject({ claimed: 1, failed: 1 });
    const backed = await timerRow(apps.admin, 'calc');
    expect(backed.failCount).toBe(5);
    expect(backed.lastOk).toBe(false);
    expect(backed.claimId).toBeNull();
    const ahead = backed.nextRunAt.getTime() - Date.now();
    expect(ahead).toBeGreaterThan((rules.APP_TIMER_BACKOFF_MINUTES - 1) * 60_000);
    // Fixed (its login back): the next run succeeds and the clock is its own.
    await su`update app_timers set created_by = ${admin} where id = ${t.id}`;
    await onlyDue([t.id]);
    expect(await sys(() => tick.runDueAppTimers({ jitterMs: 0 }))).toMatchObject({ ok: 1 });
    const back = await timerRow(apps.admin, 'calc');
    expect(back).toMatchObject({ failCount: 0, lastOk: true, lastError: null });
    expect(back.nextRunAt.getTime() - Date.now()).toBeLessThan((back.everyMinutes + 1) * 60_000);
  });

  it("prunes the run log by keep_days and of timers gone; caps a run's result; stops at the file cap", async () => {
    const appId = await makeApp('log', adminWs);
    ok(
      await call(admin, 'app_timer_set', {
        app_id: appId,
        name: 'log',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    const t = await timerRow(appId, 'log');
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const row = (timerId: string, ranAt: string) => ({
      timerId,
      ranAt,
      ok: true,
      ms: 1,
      result: '1',
      error: null,
      level: 'admin' as const,
    });
    await sys(() =>
      broker.appTimerRecordRun(anchor, appId, row(t.id, old), { keepDays: 400, liveTimerIds: [] }),
    );
    await sys(() =>
      broker.appTimerRecordRun(anchor, appId, row('a-timer-gone', old), {
        keepDays: 400,
        liveTimerIds: [t.id, 'a-timer-gone'],
      }),
    );
    expect(await runs(appId)).toHaveLength(2);
    // A run with keep_days 90: the 200-day row goes, and the gone timer's.
    expect(await runOnce(appId, 'log')).toMatchObject({ ok: true });
    const kept = await runs(appId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ timer_id: t.id, ok: 1 });
    // The result cap: recorded failed, no result kept.
    expect(await runOnce(appId, 'log', { resultMaxBytes: 1 })).toMatchObject({
      ok: false,
      error: rules.APP_TIMER_ERRORS.tooLarge,
    });
    expect((await runs(appId)).at(-1)).toMatchObject({
      ok: 0,
      result: null,
      error: 'result too large',
    });
    // The file cap (APP_SQL_MAX_DB_MB): a write past it is full, and says so.
    const was = process.env.APP_SQL_MAX_DB_MB;
    process.env.APP_SQL_MAX_DB_MB = '1';
    try {
      // Fill the file to the last bytes: big rows until one does not fit,
      // then smaller ones.
      let first: unknown = null;
      for (const size of [300_000, 30_000, 3_000, 300, 60]) {
        for (let i = 0; i < 2000; i++) {
          const err = await sys(() =>
            broker.appTimerRecordRun(
              anchor,
              appId,
              { ...row(t.id, new Date().toISOString()), result: 'x'.repeat(size) },
              { keepDays: 90, liveTimerIds: [t.id] },
            ),
          ).then(
            () => null,
            (e: unknown) => e,
          );
          if (err) {
            first ??= err;
            break;
          }
        }
      }
      expect(broker.isAppDbFull(first)).toBe(true);
      // Full: the prune alone still runs (what a run does then, before it
      // records the failure on the timer).
      await expect(
        sys(() =>
          broker.appTimerRecordRun(anchor, appId, row(t.id, new Date().toISOString()), {
            keepDays: 90,
            liveTimerIds: [t.id],
            pruneOnly: true,
          }),
        ),
      ).resolves.toEqual([]);
    } finally {
      if (was === undefined) delete process.env.APP_SQL_MAX_DB_MB;
      else process.env.APP_SQL_MAX_DB_MB = was;
    }
  });

  it("records each run's rules; a run at team rules drops the timer's admin-rules rows", async () => {
    const appId = await makeApp('level', adminWs);
    ok(
      await call(admin, 'app_timer_set', {
        app_id: appId,
        name: 'lvl',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    expect(await runOnce(appId, 'lvl')).toMatchObject({ ok: true });
    expect((await runs(appId)).map((r) => (r as { level?: string }).level)).toEqual(['admin']);
    // The app is now held by Team too: an Admin user's run is at team rules,
    // and the rows kept at admin rules go before the members read the log.
    await sys(() =>
      m.withHeads([appId], 'update', (tx) =>
        tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${appId}, ${teamWs}, false, false)`),
      ),
    );
    expect(await runOnce(appId, 'lvl')).toMatchObject({ ok: true });
    expect((await runs(appId)).map((r) => (r as { level?: string }).level)).toEqual(['team']);
    await dropApps([appId]);
  });

  it('an app that runs below admin rules loses every admin-rules row, whatever a run of it came to', async () => {
    const E = rules.APP_TIMER_ERRORS;
    const appId = await makeApp('purge', adminWs);
    for (const name of ['p1', 'p2']) {
      ok(
        await call(admin, 'app_timer_set', { app_id: appId, name, tool: 'calculate', args: ARGS }),
      );
    }
    const both = [(await timerRow(appId, 'p1')).id, (await timerRow(appId, 'p2')).id];
    /** A run of `name` with both timers live (the log keeps their rows). */
    const runLive = async (name: string) =>
      sys(async () => run.runAppTimer(await timerRow(appId, name), both));
    expect(await runLive('p1')).toMatchObject({ ok: true });
    expect(await runLive('p2')).toMatchObject({ ok: true });
    const levels = async () => (await runs(appId)).map((r) => (r as { level?: string }).level);
    expect(await levels()).toEqual(['admin', 'admin']);
    // Held by Team too, then a run that fails before its rules are judged
    // (its login gone: no row of its own): both timers' rows go.
    await sys(() =>
      m.withHeads([appId], 'update', (tx) =>
        tx.execute(m.sql`insert into item_grants (node_id, workspace_id, write, is_home)
          values (${appId}, ${teamWs}, false, false)`),
      ),
    );
    await su`update app_timers set created_by = null where app_node_id = ${appId} and name = 'p1'`;
    expect(await runLive('p1')).toMatchObject({ ok: false, error: E.loginGone });
    expect(await levels()).toEqual([]);
    await dropApps([appId]);
  });

  it("switching a timer off or deleting it removes its admin-rules rows at once, in the caller's scope", async () => {
    const appId = await makeApp('offdel', adminWs);
    for (const name of ['o1', 'o2']) {
      ok(
        await call(admin, 'app_timer_set', { app_id: appId, name, tool: 'calculate', args: ARGS }),
      );
    }
    const both = [(await timerRow(appId, 'o1')).id, (await timerRow(appId, 'o2')).id];
    for (const name of ['o1', 'o2']) {
      const t = await timerRow(appId, name);
      expect(await sys(() => run.runAppTimer(t, both))).toMatchObject({ ok: true });
    }
    expect(await runs(appId)).toHaveLength(2);
    const o2 = await timerRow(appId, 'o2');
    const off = ok<{ note?: string }>(
      await call(admin, 'app_timer_set', {
        app_id: appId,
        name: 'o1',
        tool: 'calculate',
        args: ARGS,
        enabled: false,
      }),
    );
    expect(off.note).toBeUndefined();
    expect((await runs(appId)).map((r) => r.timer_id)).toEqual([o2.id]);
    const del = ok<{ note?: string }>(
      await call(admin, 'app_timer_delete', { app_id: appId, name: 'o2' }),
    );
    expect(del.note).toBeUndefined();
    expect(await runs(appId)).toEqual([]);
    // A Moderator who is no Admin user deletes a timer of a Team app: the
    // purge runs in that login's own write request too.
    ok(
      await call(mod, 'app_timer_set', {
        app_id: apps.team,
        name: 'modtmp',
        tool: 'calculate',
        args: ARGS,
      }),
    );
    expect(await runOnce(apps.team, 'modtmp')).toMatchObject({ ok: true });
    const gone = ok<{ note?: string }>(
      await call(mod, 'app_timer_delete', { app_id: apps.team, name: 'modtmp' }),
    );
    expect(gone.note).toBeUndefined();
    await dropApps([appId]);
  });

  it('app_timer_run keeps the floors and the back-off: refused inside them, with the time it can run from', async () => {
    const at = (name: string, appId = apps.admin) =>
      call(name === 'modcalc' ? mod : admin, 'app_timer_run', { app_id: appId, name });
    // An Admin user's timer: 1 minute.
    await su`update app_timers set last_run_at = now(), fail_count = 0 where app_node_id = ${apps.admin} and name = 'calc'`;
    const early = await at('calc');
    expect(!early.ok && early.error).toMatch(
      /ran too recently to run again now: it can run from \d{4}-/,
    );
    await su`update app_timers set last_run_at = now() - interval '2 minutes' where app_node_id = ${apps.admin} and name = 'calc'`;
    expect(ok<{ queued: boolean }>(await at('calc')).queued).toBe(true);
    // Backing off (5 failures in a row): 30 minutes.
    await su`update app_timers set last_run_at = now() - interval '10 minutes', fail_count = 5 where app_node_id = ${apps.admin} and name = 'calc'`;
    expect((await at('calc')).ok).toBe(false);
    await su`update app_timers set last_run_at = now() - interval '31 minutes' where app_node_id = ${apps.admin} and name = 'calc'`;
    expect((await at('calc')).ok).toBe(true);
    await su`update app_timers set fail_count = 0 where app_node_id = ${apps.admin} and name = 'calc'`;
    // A login that is no Admin user: 5 minutes.
    await su`update app_timers set last_run_at = now() - interval '3 minutes' where app_node_id = ${apps.team} and name = 'modcalc'`;
    expect((await at('modcalc', apps.team)).ok).toBe(false);
    await su`update app_timers set last_run_at = now() - interval '6 minutes' where app_node_id = ${apps.team} and name = 'modcalc'`;
    expect((await at('modcalc', apps.team)).ok).toBe(true);
  });

  it('app_timer_set keeps the floors and the back-off too: a flipped setting runs it no sooner', async () => {
    const set = (input: Record<string, unknown>) =>
      call(mod, 'app_timer_set', {
        app_id: apps.team,
        name: 'flip',
        tool: 'calculate',
        args: ARGS,
        ...input,
      });
    ok(await set({ every_minutes: 5 }));
    const id = (await timerRow(apps.team, 'flip')).id;
    /** Minutes from now to its next run. */
    const ahead = async () =>
      ((await timerRow(apps.team, 'flip')).nextRunAt.getTime() - Date.now()) / 60_000;
    // Never run: a changed set runs it within the minute.
    expect(await ahead()).toBeLessThan(1);
    // Ran a minute ago (a member's timer: a floor of 5): flipping its clock
    // back and forth never brings its next run nearer than 4 minutes.
    await su`update app_timers set last_run_at = now() - interval '1 minute', fail_count = 0 where id = ${id}`;
    for (const every of [6, 5, 6, 5]) {
      ok(await set({ every_minutes: every }));
      expect(await ahead()).toBeGreaterThan(3.5);
    }
    // Backing off (5 failures in a row, the last 10 minutes ago): a new
    // clock or a switch off and on keeps the count and the 30 minutes.
    await su`update app_timers set last_run_at = now() - interval '10 minutes', fail_count = 5 where id = ${id}`;
    ok(await set({ every_minutes: 7 }));
    ok(await set({ every_minutes: 7, enabled: false }));
    ok(await set({ every_minutes: 7, enabled: true }));
    let row = await timerRow(apps.team, 'flip');
    expect(row.failCount).toBe(5);
    expect(await ahead()).toBeGreaterThan(19);
    // Another call (new args): the count starts over, and the gap the old
    // count set still holds for this next run.
    ok(await set({ every_minutes: 7, args: { expression: '2 + 2' } }));
    row = await timerRow(apps.team, 'flip');
    expect(row.failCount).toBe(0);
    expect(await ahead()).toBeGreaterThan(19);
    // Once it has run again, the plain floor applies.
    await su`update app_timers set last_run_at = now() - interval '1 minute' where id = ${id}`;
    ok(await set({ every_minutes: 8, args: { expression: '2 + 2' } }));
    const plain = await ahead();
    expect(plain).toBeGreaterThan(3.5);
    expect(plain).toBeLessThan(4.6);
    await su`delete from app_timers where id = ${id}`;
  });

  it('app_timer_run makes a switched-on timer due now, with the same checks', async () => {
    await su`update app_timers set next_run_at = now() + interval '1 day', last_run_at = now() - interval '1 hour' where app_node_id = ${apps.admin} and name = 'calc'`;
    const r = ok<{ queued: boolean }>(
      await call(admin, 'app_timer_run', { app_id: apps.admin, name: 'calc' }),
    );
    expect(r.queued).toBe(true);
    expect((await timerRow(apps.admin, 'calc')).nextRunAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 1000,
    );
    ok(
      await call(admin, 'app_timer_set', {
        app_id: apps.admin,
        name: 'calc',
        tool: 'calculate',
        args: ARGS,
        enabled: false,
      }),
    );
    expect((await call(admin, 'app_timer_run', { app_id: apps.admin, name: 'calc' })).ok).toBe(
      false,
    );
    await expect(
      call(member, 'app_timer_run', { app_id: apps.team, name: 'modcalc' }),
    ).rejects.toThrow();
  });
});
