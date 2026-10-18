/**
 * The users of a workspace in SQL (workspaces arch plan v3.2, S2a a1;
 * migration 0305_ws_user_definers), on a database of its own (so
 * mantle_brain_id() is this file's anchor) that the workspaces switch made
 * live:
 *
 *  - mantle_ws_add_user, mantle_ws_set_moderator, mantle_ws_remove_user act
 *    for the acting login (mantle_scope_login_id, the write role's
 *    settings): a member, a Moderator, an Admin user with and without the
 *    users area, a login outside the workspace, each refusal in the order
 *    the routes answered in, each change with its event row;
 *  - member-negative: a Moderator of W cannot add to Admin; an Admin user
 *    without the users area cannot tick or add to Admin;
 *  - with no acting login every user definer, mantle_ws_create,
 *    mantle_ws_private_workspace and mantle_workspace_event refuse every
 *    actor but the SQL allowlist's (system:ws-clear-ticks): the asSystem
 *    exits (system:workspace-write, system:admin-area, system:app-data and
 *    every other reason), system:http:*, system:test, system:operator:*, a
 *    login actor with no scope, no actor at all; the allowlisted actor is
 *    refused with write_mode 'ro' and inside a scope;
 *  - another brain, a disabled acting login, a read-only one: refused;
 *  - the TypeScript side: systemWork('ws-clear-ticks') sets mantle.actor on
 *    the system pool in every check mode (test:actor-off runs this file
 *    with the check off), refuses inside a scope or an asSystem exit, and a
 *    definer inside asSystem('workspace-write') is refused;
 *  - createHomeFallback (createHomeIntent) makes the login's own private
 *    workspace with mantle.scope_login set;
 *  - the catalog: the private helpers run by no role; every function that
 *    writes the four workspace tables is a rule or a named exemption
 *    (workspaceTableWriterFns), each exemption's cell;
 *  - the renumber proof: 0305's `when` is above 0304's, and a database at
 *    0304 applies 0305 and only it.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ws-user-definers.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { sql as sqlTag } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyJournal } from './migrate-runner';
import type { JournalEntry } from './migrate-plan';
import {
  createMigratedScratchDatabase,
  createScratchDatabaseBefore,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';
import { OWNER_ROLE, RUNTIME_ROLE } from './runtime-role';
import { AS_SYSTEM_OTHER_REASONS, AS_SYSTEM_TURN_REASONS } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0305_ws_user_definers';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The one actor the SQL allowlist takes (mantle_ws_system_work, 0305). */
const CLEAR_TICKS = 'system:ws-clear-ticks';

/** Every function that writes workspaces, workspace_users, workspace_events
 *  or workspace_resources, with its rule or its named exemption (plan v3.2,
 *  "Every writer of the four tables"). A new one fails the catalog cell
 *  until it is added here with a rule or an F-reviewed exemption. */
const WRITERS: Readonly<Record<string, string>> = {
  mantle_ws_create: 'rule: the acting login, or system work (0305)',
  mantle_ws_add_user: 'rule: the acting login, or system work (0305)',
  mantle_ws_set_moderator: 'rule: the acting login, or system work (0305)',
  mantle_ws_remove_user: 'rule: the acting login, or system work (0305)',
  mantle_ws_private_workspace: 'rule: the acting login’s own, or system work (0305)',
  mantle_workspace_event: 'rule: refused with no acting login unless system work (0305)',
  mantle_ws_attach_assistants: 'S2a a2: a definer with the rule (invoker until then)',
  mantle_bridge_login: 'exemption until S8b: the runtime role only, its three callers pinned',
  mantle_bridge_connector: 'exemption: trigger only, its trigger dropped by the switch',
  mantle_ws_team_normal: 'exemption: migrator only (the switch)',
  mantle_ws_review_off: 'exemption: migrator only (the switch)',
  mantle_ws_spaces_fold: 'exemption: migrator only (the switch)',
  mantle_ws_migrate_bridged: 'exemption: migrator only (the switch)',
  mantle_ws_landing_held_trg: 'exemption: a guard trigger',
  mantle_ws_last_admin_mod_trg: 'exemption: a guard trigger',
};

describe('0305 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor (0304, 1790197560000)', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197560000);
  });
});

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

type Out = { ok: true; v: unknown } | { ok: false; state: string; msg: string };

describe.skipIf(!URL)('the workspace user definers (S2a a1)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let brain = '';
  let adminWs = '';
  const tag = `wud${randomUUID().slice(0, 8)}`;
  const W = randomUUID(); // a normal workspace: mod (Moderator), mem, dis
  const ARCH = randomUUID(); // an archived workspace: mod (Moderator)
  const L = {
    adm: randomUUID(), // role admin, in Admin (the switch puts it there)
    adm2: randomUUID(), // role admin, in Admin
    noUsers: randomUUID(), // role admin, in Admin, the users area off
    mod: randomUUID(), // member, Moderator of W
    mem: randomUUID(), // member, a plain user of W
    dis: randomUUID(), // member, Moderator of W, disabled
    out: randomUUID(), // member, in no workspace
    target: randomUUID(), // member, in no workspace: the one added
    priv: randomUUID(), // member: its private workspace is made here
  };

  /** `q` in a transaction rolled back after it, with `settings` set
   *  transaction-local first: its result, or its error's SQLSTATE and text. */
  const run = async (
    settings: Record<string, string>,
    q: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<Out> => {
    let out: Out = { ok: false, state: 'none', msg: 'not run' };
    await sql
      .begin(async (tx) => {
        for (const [k, v] of Object.entries(settings)) {
          await tx`select set_config(${k}, ${v}, true)`;
        }
        try {
          out = { ok: true, v: await q(tx) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          out = { ok: false, state: e.code ?? '', msg: e.message ?? '' };
        }
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    return out;
  };

  /** The write role's settings for `login` (client.ts writeRoleSettingsSql):
   *  its scope, its login, its actor. */
  const asLogin = async (
    login: string,
    o: { extraWs?: string[]; mode?: 'rw' | 'ro' } = {},
  ): Promise<Record<string, string>> => {
    const scope = await m.loginScopeFor(login);
    const arr = (ids: readonly string[]) => `{${ids.join(',')}}`;
    return {
      'mantle.ws': arr([...scope.ws, ...(o.extraWs ?? [])]),
      'mantle.mod_ws': arr(scope.modWs),
      'mantle.login_id': login,
      'mantle.actor': `login:${o.mode ?? 'rw'}:${login}`,
      'mantle.write_mode': o.mode ?? 'rw',
    };
  };
  /** No scope, no login: only an actor (or none). */
  const asActor = (actor: string, mode: 'rw' | 'ro' = 'rw'): Record<string, string> => ({
    'mantle.actor': actor,
    'mantle.write_mode': mode,
  });

  const add =
    (ws: string, login: string | null, tick: boolean, owner = brain) =>
    (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_add_user(${owner}::uuid, ${ws}::uuid, ${login}::uuid, ${tick})`;
  const setMod =
    (ws: string, login: string | null, tick: boolean, by: string | null = null, owner = brain) =>
    (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_set_moderator(${owner}::uuid, ${ws}::uuid, ${login}::uuid, ${tick}, ${by})`;
  const remove =
    (ws: string, login: string | null, owner = brain) =>
    (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_remove_user(${owner}::uuid, ${ws}::uuid, ${login}::uuid)`;
  /** `q`, then the row it left for (ws, login) and the last event of ws. */
  const andAfter =
    (ws: string, login: string, q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    async (tx: postgres.TransactionSql) => {
      await q(tx);
      const [row] = await tx<{ moderator: boolean; added_by: string | null }[]>`
        select moderator, added_by::text from workspace_users
         where workspace_id = ${ws} and login_id = ${login}`;
      const [ev] = await tx<{ actor: string | null; action: string; subject: unknown }[]>`
        select actor_id::text as actor, action, subject from workspace_events
         where workspace_id = ${ws} order by created_at desc, id desc limit 1`;
      return { row: row ?? null, ev: ev ?? null };
    };
  const refused = (out: Out, state: string, code: string) => {
    expect(out.ok, JSON.stringify(out)).toBe(false);
    if (out.ok) return;
    expect(out.state, out.msg).toBe(state);
    expect(out.msg).toMatch(new RegExp(`^mantle_ws:${code}\\b`));
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    const email = (k: string) => `${tag}-${k}@example.invalid`;
    const role = (k: string) => (k.startsWith('adm') || k === 'noUsers' ? 'admin' : 'member');
    for (const [k, id] of Object.entries(L)) {
      await sql`insert into auth.users (id, email, password_hash, role, display_name)
                values (${id}, ${email(k)}, 'x', ${role(k)}, ${k})`;
    }
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
    await runWorkspacesSwitch(scratch.url);
    m = await import('./index');
    const [a] = await sql<{ id: string }[]>`
      select id::text from workspaces where owner_id = ${brain} and is_admin`;
    adminWs = a!.id;
    // The fixtures write the four tables as the superuser (never through the
    // SQL allowlist).
    await sql`update workspace_users set limits = ${sql.json({ areas: { users: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noUsers}`;
    await sql`insert into workspaces (id, owner_id, name) values
      (${W}, ${brain}, ${`${tag} W`}), (${ARCH}, ${brain}, ${`${tag} Arch`})`;
    await sql`update workspaces set archived_at = now() where id = ${ARCH}`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W}, ${L.mod}, true), (${W}, ${L.mem}, false), (${W}, ${L.dis}, true),
      (${ARCH}, ${L.mod}, true)`;
    await sql`update auth.users set disabled_at = now() where id = ${L.dis}`;
    // The fixture is what the cells assume.
    const admins = await sql<{ id: string }[]>`
      select login_id::text as id from workspace_users where workspace_id = ${adminWs} order by 1`;
    expect(admins.map((r) => r.id)).toEqual([brain, L.adm, L.adm2, L.noUsers].sort());
  }, 300_000);

  afterAll(async () => {
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  it('a Moderator adds a user without the tick: the row and its event name the acting login', async () => {
    const out = await run(await asLogin(L.mod), andAfter(W, L.target, add(W, L.target, false)));
    expect(out).toEqual({
      ok: true,
      v: {
        row: { moderator: false, added_by: L.mod },
        ev: { actor: L.mod, action: 'user.add', subject: { login: L.target, moderator: false } },
      },
    });
  });

  it('an Admin user with the users area adds anywhere, with the tick, itself too (self: true)', async () => {
    const adm = await asLogin(L.adm);
    expect(await run(adm, andAfter(W, L.target, add(W, L.target, true)))).toEqual({
      ok: true,
      v: {
        row: { moderator: true, added_by: L.adm },
        ev: { actor: L.adm, action: 'user.add', subject: { login: L.target, moderator: true } },
      },
    });
    expect(await run(adm, andAfter(adminWs, L.target, add(adminWs, L.target, true)))).toMatchObject(
      {
        ok: true,
        v: { row: { moderator: true, added_by: L.adm }, ev: { action: 'user.add' } },
      },
    );
    expect(await run(adm, andAfter(W, L.adm, add(W, L.adm, false)))).toEqual({
      ok: true,
      v: {
        row: { moderator: false, added_by: L.adm },
        ev: {
          actor: L.adm,
          action: 'user.add',
          subject: { login: L.adm, moderator: false, self: true },
        },
      },
    });
  });

  it('who may add: each refusal in the order the route answered (who may comes before the login)', async () => {
    const cells: Array<[string, string, string | null, boolean, string, string]> = [
      [L.mod, W, L.target, true, '42501', 'admin_only'],
      [L.mod, W, randomUUID(), true, '42501', 'admin_only'],
      [L.mem, W, L.target, false, '42501', 'forbidden'],
      [L.mem, W, randomUUID(), false, '42501', 'forbidden'],
      [L.out, W, L.target, false, 'P0002', 'not_found'],
      // member-negative: a Moderator of W cannot add to Admin.
      [L.mod, adminWs, L.target, true, 'P0002', 'not_found'],
      // member-negative: an Admin user without the users area cannot add to Admin.
      [L.noUsers, adminWs, L.target, true, '42501', 'admin_users_only'],
      [L.noUsers, W, L.target, false, 'P0002', 'not_found'],
      [L.adm, adminWs, L.target, false, '55000', 'admin_workspace'],
      [L.adm, ARCH, L.target, false, '55000', 'archived'],
      [L.mod, ARCH, L.target, false, 'P0002', 'not_found'],
      [L.adm, W, randomUUID(), false, 'P0002', 'user_not_found'],
      [L.adm, W, null, false, 'P0002', 'user_not_found'],
      [L.adm, W, L.mem, false, '55000', 'already_user'],
      [L.adm, randomUUID(), L.target, false, 'P0002', 'not_found'],
    ];
    for (const [who, ws, login, tick, state, code] of cells) {
      refused(await run(await asLogin(who), add(ws, login, tick)), state, code);
    }
  });

  it('the Moderator tick: an Admin user with the users area only; never the last Moderator, never off in Admin', async () => {
    const adm = await asLogin(L.adm);
    expect(await run(adm, andAfter(W, L.mem, setMod(W, L.mem, true)))).toEqual({
      ok: true,
      v: {
        row: { moderator: true, added_by: null },
        ev: { actor: L.adm, action: 'user.moderator', subject: { login: L.mem, moderator: true } },
      },
    });
    // No change, no event.
    const same = await run(adm, async (tx) => {
      await setMod(W, L.mod, true)(tx);
      return (
        await tx<{ n: number }[]>`select count(*)::int as n from workspace_events
                                   where workspace_id = ${W} and action = 'user.moderator'`
      )[0]!.n;
    });
    expect(same).toEqual({ ok: true, v: 0 });
    const cells: Array<[string, string, string | null, boolean, string, string]> = [
      [L.mod, W, L.mem, true, '42501', 'admin_only'],
      [L.mem, W, L.mem, true, '42501', 'forbidden'],
      [L.out, W, L.mem, true, 'P0002', 'not_found'],
      // member-negative: an Admin user without the users area cannot tick.
      [L.noUsers, adminWs, L.adm, true, '42501', 'admin_only'],
      [L.adm, adminWs, L.adm2, false, '55000', 'admin_workspace'],
      [L.adm, ARCH, L.mod, false, '55000', 'archived'],
      [L.adm, W, L.out, true, 'P0002', 'not_user'],
      [L.adm, W, null, true, 'P0002', 'not_user'],
    ];
    for (const [who, ws, login, tick, state, code] of cells) {
      refused(await run(await asLogin(who), setMod(ws, login, tick)), state, code);
    }
    // W's Moderators are mod and dis (disabled): clearing both, the last refused.
    refused(
      await run(adm, async (tx) => {
        await setMod(W, L.dis, false)(tx);
        return setMod(W, L.mod, false)(tx);
      }),
      '55000',
      'last_moderator',
    );
  });

  it('removing a user: a Moderator removes a plain user, anyone leaves, an Admin user removes a Moderator; Admin keeps its anchor', async () => {
    expect(await run(await asLogin(L.mod), andAfter(W, L.mem, remove(W, L.mem)))).toEqual({
      ok: true,
      v: { row: null, ev: { actor: L.mod, action: 'user.remove', subject: { login: L.mem } } },
    });
    expect(await run(await asLogin(L.mem), andAfter(W, L.mem, remove(W, L.mem)))).toEqual({
      ok: true,
      v: { row: null, ev: { actor: L.mem, action: 'user.leave', subject: { login: L.mem } } },
    });
    expect(
      await run(await asLogin(L.adm), andAfter(adminWs, L.noUsers, remove(adminWs, L.noUsers))),
    ).toMatchObject({ ok: true, v: { row: null, ev: { action: 'user.remove' } } });
    // A Moderator removing another Moderator takes the tick away: the tick's rule.
    refused(
      await run(await asLogin(L.mod), async (tx) => {
        await tx`update workspace_users set moderator = true
                  where workspace_id = ${W} and login_id = ${L.mem}`;
        return remove(W, L.mem)(tx);
      }),
      '42501',
      'admin_only',
    );
    const cells: Array<[string, string, string | null, string, string]> = [
      [L.mem, W, L.mod, '42501', 'forbidden'],
      [L.out, W, L.mem, 'P0002', 'not_found'],
      [L.adm, adminWs, brain, '42501', 'owner_stays_admin'],
      [L.adm, adminWs, L.adm, '42501', 'self_demote'],
      // member-negative: no users area, no Admin change.
      [L.noUsers, adminWs, L.adm, '42501', 'admin_users_only'],
      [L.adm, ARCH, L.mod, '55000', 'archived'],
      [L.adm, W, L.out, 'P0002', 'not_user'],
      [L.adm, W, null, 'P0002', 'not_user'],
    ];
    for (const [who, ws, login, state, code] of cells) {
      refused(await run(await asLogin(who), remove(ws, login)), state, code);
    }
    // mod leaving W once dis (the other Moderator) is a plain user: the last one.
    refused(
      await run(await asLogin(L.mod), async (tx) => {
        await tx`update workspace_users set moderator = false
                  where workspace_id = ${W} and login_id = ${L.dis}`;
        return remove(W, L.mod)(tx);
      }),
      '55000',
      'last_moderator',
    );
  });

  it('the users area is the scope`s own login`s: a scope that holds Admin whose login is no Admin user holds none', async () => {
    refused(
      await run(await asLogin(L.mod, { extraWs: [adminWs] }), add(W, L.target, true)),
      '42501',
      'admin_only',
    );
  });

  it('another brain, a disabled acting login and a read-only one are refused', async () => {
    const adm = await asLogin(L.adm);
    const other = randomUUID();
    refused(await run(adm, add(W, L.target, false, other)), '42501', 'not_brain');
    refused(await run(adm, setMod(W, L.mem, true, null, other)), '42501', 'not_brain');
    refused(await run(adm, remove(W, L.mem, other)), '42501', 'not_brain');
    refused(await run(await asLogin(L.dis), remove(W, L.mem)), '42501', 'no_acting_login');
    refused(
      await run(await asLogin(L.adm, { mode: 'ro' }), add(W, L.target, false)),
      '42501',
      'read_only',
    );
  });

  it('no acting login: every user definer and the other three writers refuse every actor but the allowlist`s', async () => {
    const actors = [
      '',
      'system:workspace-write',
      'system:admin-area',
      'system:app-data',
      'system:http:admin-area',
      'system:http:login-self',
      'system:http:no-login',
      'system:operator:repair',
      'system:script:ws-clear-member-ticks',
      'system:boot:migrate-workspaces',
      'system:ws-clear-ticks-x',
      'system:unnamed',
      `login:rw:${L.adm}`,
      `login:owner:${brain}`,
      'assistant:none',
      ...[...AS_SYSTEM_TURN_REASONS, ...AS_SYSTEM_OTHER_REASONS].map((r) => `system:${r}`),
    ];
    expect(actors).toContain('system:test');
    const writers: Array<[string, (tx: postgres.TransactionSql) => Promise<unknown>]> = [
      ['add', add(W, L.target, false)],
      ['tick', setMod(W, L.mem, true)],
      ['remove', remove(W, L.mem)],
      ['create', (tx) => tx`select mantle_ws_create(${brain}::uuid, ${L.adm}::uuid, 'X', '')`],
      ['private', (tx) => tx`select mantle_ws_private_workspace(${L.priv}::uuid)`],
      [
        'event',
        (tx) => tx`select mantle_workspace_event(${W}::uuid, ${L.adm}::uuid, 'grant.add', '{}')`,
      ],
    ];
    const allowed: string[] = [];
    for (const actor of actors) {
      for (const [name, q] of writers) {
        const out = await run(asActor(actor), q);
        if (out.ok || out.state !== '42501' || !/no acting login|only the acting/.test(out.msg)) {
          allowed.push(`${actor} ${name}: ${JSON.stringify(out)}`);
        }
      }
    }
    expect(allowed).toEqual([]);
  });

  it('the allowlisted actor is system work: allowed with no scope; refused read-only or inside a scope', async () => {
    const sys = asActor(CLEAR_TICKS);
    expect(
      await run(sys, andAfter(W, L.mem, setMod(W, L.mem, true, 'ws:clear-member-ticks'))),
    ).toEqual({
      ok: true,
      v: {
        row: { moderator: true, added_by: null },
        ev: {
          actor: null,
          action: 'user.moderator',
          subject: { login: L.mem, moderator: true, by: 'ws:clear-member-ticks' },
        },
      },
    });
    expect(await run(sys, andAfter(W, L.target, add(W, L.target, false)))).toMatchObject({
      ok: true,
      v: { row: { moderator: false, added_by: null }, ev: { actor: null, action: 'user.add' } },
    });
    // The invariants hold for system work too.
    refused(await run(sys, setMod(adminWs, L.adm, false)), '55000', 'admin_workspace');
    refused(await run(sys, setMod(ARCH, L.mod, false)), '55000', 'archived');
    refused(await run(sys, remove(adminWs, brain)), '42501', 'owner_stays_admin');
    // write_mode 'ro', a scope open, a login set: never system work.
    refused(await run(asActor(CLEAR_TICKS, 'ro'), setMod(W, L.mem, true)), '42501', 'read_only');
    refused(
      await run({ ...sys, 'mantle.ws': `{${W}}` }, setMod(W, L.mem, true)),
      '42501',
      'no_acting_login',
    );
    const fact = async (s: Record<string, string>) =>
      run(s, async (tx) => (await tx<{ a: boolean }[]>`select mantle_ws_system_work() as a`)[0]!.a);
    expect(await fact(sys)).toEqual({ ok: true, v: true });
    expect(await fact(asActor(CLEAR_TICKS, 'ro'))).toEqual({ ok: true, v: false });
    expect(await fact({ ...sys, 'mantle.ws': '{}' })).toEqual({ ok: true, v: false });
    expect(await fact({ ...sys, 'mantle.scope_login': L.adm })).toEqual({ ok: true, v: false });
    expect(await fact(asActor('system:workspace-write'))).toEqual({ ok: true, v: false });
    expect(await fact({})).toEqual({ ok: true, v: false });
  });

  it('mantle_ws_create: the acting login`s own, on its brain; system work may make one', async () => {
    const mod = await asLogin(L.mod);
    const made = await run(mod, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        select mantle_ws_create(${brain}::uuid, ${L.mod}::uuid, 'Made', '')::text as id`;
      return (
        await tx<{ moderator: boolean }[]>`
          select moderator from workspace_users where workspace_id = ${r!.id} and login_id = ${L.mod}`
      )[0];
    });
    expect(made).toEqual({ ok: true, v: { moderator: true } });
    const other = await run(
      mod,
      (tx) => tx`select mantle_ws_create(${brain}::uuid, ${L.mem}::uuid, 'X', '')`,
    );
    expect(other).toMatchObject({ ok: false, state: '42501' });
    // Only the login set (no workspaces in the scope): the same rule.
    const loginOnly = await run(
      { 'mantle.scope_login': L.mod, ...asActor(`login:rw:${L.mod}`) },
      (tx) => tx`select mantle_ws_create(${brain}::uuid, ${L.mem}::uuid, 'X', '')`,
    );
    expect(loginOnly).toMatchObject({ ok: false, state: '42501' });
    expect(
      await run(
        asActor(CLEAR_TICKS),
        (tx) => tx`select mantle_ws_create(${brain}::uuid, ${L.mod}::uuid, 'Sys', '')`,
      ),
    ).toMatchObject({ ok: true });
  });

  it('mantle_ws_private_workspace makes only the acting login`s own; createHomeIntent sets that login', async () => {
    const own = await run(
      { 'mantle.scope_login': L.priv },
      async (tx) =>
        (
          await tx<
            { ws: string | null }[]
          >`select mantle_ws_private_workspace(${L.priv}::uuid)::text as ws`
        )[0]!.ws,
    );
    expect(own.ok && typeof own.v === 'string').toBe(true);
    const another = await run(
      { 'mantle.scope_login': L.mem },
      (tx) => tx`select mantle_ws_private_workspace(${L.priv}::uuid)`,
    );
    expect(another).toMatchObject({ ok: false, state: '42501' });
    // The TypeScript path (createHomeFallback): it sets mantle.scope_login.
    const home = await m.createHomeIntent(L.priv, null, { ownWork: true, makePrivate: true });
    expect('privateWs' in home && typeof home.privateWs === 'string').toBe(true);
    const [p] = await sql<{ ws: string }[]>`
      select workspace_id::text as ws from private_workspaces where login_id = ${L.priv}`;
    expect('privateWs' in home ? home.privateWs : null).toBe(p!.ws);
  });

  it('mantle_workspace_event: in the acting login`s scope as before', async () => {
    const ok = await run(
      await asLogin(L.mod),
      (tx) => tx`select mantle_workspace_event(${W}::uuid, ${L.mod}::uuid, 'grant.add', '{}')`,
    );
    expect(ok).toMatchObject({ ok: true });
  });

  it('TypeScript: systemWork(ws-clear-ticks) sets mantle.actor on the system pool in every check mode', async () => {
    // test:actor-off runs this file with the check off: the actor is set
    // for workspace system work there too (client.ts actorParams).
    const seen = (await m.systemWork(
      () =>
        m.db.transaction(async (tx) =>
          tx.execute(sqlTag`select current_setting('mantle.actor', true) as a,
                                   current_setting('mantle.write_mode', true) as w`),
        ),
      'ws-clear-ticks',
    )) as unknown as { a: string; w: string }[];
    expect(seen[0]).toEqual({ a: CLEAR_TICKS, w: 'rw' });
    // And the definer takes it: a tick, then the tick cleared, both by it.
    await m
      .systemWork(
        () =>
          m.db.transaction(async (tx) => {
            await tx.execute(
              sqlTag`select mantle_ws_set_moderator(mantle_brain_id(), ${W}::uuid, ${L.out}::uuid, true, 'x')`,
            );
          }),
        'ws-clear-ticks',
      )
      .then(
        () => expect.unreachable('L.out is no user of W'),
        (err: unknown) =>
          expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(
            /mantle_ws:not_user/,
          ),
      );
  });

  it('TypeScript: a definer inside asSystem(workspace-write) is refused; systemWork(ws-clear-ticks) refuses any scope', async () => {
    const inExit = m.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx.execute(
            sqlTag`select mantle_ws_set_moderator(mantle_brain_id(), ${W}::uuid, ${L.mem}::uuid, true, null)`,
          );
        }),
      'workspace-write',
    );
    await expect(inExit).rejects.toSatisfy((err: unknown) =>
      /no acting login/.test(String((err as { cause?: Error }).cause?.message ?? err)),
    );
    await expect(
      m.asSystem(() => m.systemWork(async () => 1, 'ws-clear-ticks'), 'workspace-write'),
    ).rejects.toThrow(/outside every scope and request/);
    await expect(
      m.withViewer({ login: L.mod }, () => m.systemWork(async () => 1, 'ws-clear-ticks')),
    ).rejects.toThrow(/outside every scope and request/);
    // asSystem takes no workspace system reason (a type error):
    // @ts-expect-error: 'ws-clear-ticks' is no AsSystemReason.
    const typed: Parameters<typeof m.asSystem>[1] = 'ws-clear-ticks';
    expect(typed).toBe('ws-clear-ticks');
  });

  it('catalog: the private helpers run by no role; the user definers are definers PUBLIC may not run', async () => {
    const helpers = [
      'public.mantle_ws_system_work()',
      'public.mantle_ws_acting_login(text,uuid)',
      'public.mantle_ws_user_seat(text,uuid,uuid,uuid)',
    ];
    const rows = await sql<{ fn: string; pub: boolean; may: string[] }[]>`
      select f.fn, has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             array(select r.rolname::text from pg_roles r
                    where not r.rolsuper and r.rolname <> ${OWNER_ROLE}
                      and has_function_privilege(r.oid, p.oid, 'EXECUTE') order by 1) as may
        from unnest(${helpers}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(rows.map((r) => r.fn).sort()).toEqual([...helpers].sort());
    expect(rows.filter((r) => r.pub || r.may.length)).toEqual([]);
    const definers = [
      'public.mantle_ws_add_user(uuid,uuid,uuid,boolean)',
      'public.mantle_ws_set_moderator(uuid,uuid,uuid,boolean,text)',
      'public.mantle_ws_remove_user(uuid,uuid,uuid)',
      'public.mantle_ws_create(uuid,uuid,text,text)',
    ];
    const defs = await sql<{ fn: string; definer: boolean; pub: boolean; path: string[] }[]>`
      select f.fn, p.prosecdef as definer, has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             coalesce(p.proconfig, '{}') as path
        from unnest(${definers}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(defs).toHaveLength(definers.length);
    for (const d of defs) {
      expect(d.definer, d.fn).toBe(true);
      expect(d.pub, d.fn).toBe(false);
      expect(d.path, d.fn).toContain('search_path="public", pg_temp');
    }
  });

  it('catalog: every function writing the four workspace tables is a rule or a named exemption (workspaceTableWriterFns)', async () => {
    // The scoreboard's own test of a body (eslint-rules/rights-counts.mjs),
    // on the live catalog (rights-catalog.db.test.ts proves the two agree).
    const counts = (await import(join(ROOT, 'eslint-rules/rights-counts.mjs'))) as {
      writesWorkspaceTable(body: string): boolean;
    };
    const fns = await sql<{ name: string; src: string }[]>`
      select p.proname::text as name, p.prosrc as src from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                            and d.deptype = 'e')`;
    const writers = [
      ...new Set(fns.filter((f) => counts.writesWorkspaceTable(f.src)).map((f) => f.name)),
    ].sort();
    expect(writers).toEqual(Object.keys(WRITERS).sort());
  });

  it('catalog: the named exemptions hold (bridge_login runtime only; the switch`s steps and the bridge connector run by no app role; the guards are triggers)', async () => {
    const mayRun = async (fn: string) =>
      (
        await sql<{ r: string }[]>`
          select r.rolname::text as r from pg_roles r
           where not r.rolsuper and r.rolname <> ${OWNER_ROLE}
             and has_function_privilege(r.oid, to_regprocedure(${fn}), 'EXECUTE') order by 1`
      ).map((x) => x.r);
    const hasRuntime = (
      await sql<{ on: boolean }[]>`select to_regrole(${RUNTIME_ROLE}) is not null as on`
    )[0]!.on;
    expect(await mayRun('public.mantle_bridge_login(uuid)')).toEqual(
      hasRuntime ? [RUNTIME_ROLE] : [],
    );
    for (const fn of [
      'public.mantle_bridge_connector(uuid,text)',
      'public.mantle_ws_team_normal(boolean)',
      'public.mantle_ws_review_off()',
      'public.mantle_ws_spaces_fold()',
      'public.mantle_ws_migrate_bridged()',
    ]) {
      expect(await mayRun(fn), fn).toEqual([]);
    }
    // The bridge connector's trigger is gone once the switch ran.
    const [t] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
       where tgfoid = 'public.mantle_bridge_connector'::regproc or tgname = 'tool_groups_zz_bridge'`;
    expect(t!.n).toBe(0);
    const guards = await sql<{ name: string; trg: boolean }[]>`
      select p.proname::text as name, p.prorettype = 'trigger'::regtype as trg from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('mantle_ws_landing_held_trg', 'mantle_ws_last_admin_mod_trg') order by 1`;
    expect(guards).toEqual([
      { name: 'mantle_ws_landing_held_trg', trg: true },
      { name: 'mantle_ws_last_admin_mod_trg', trg: true },
    ]);
  });
});

describe.skipIf(!URL)('a database at 0304 runs 0305 and only it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });

  beforeAll(async () => {
    scratch = await createScratchDatabaseBefore(URL!, TAG);
    sql = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
    await sql`create schema if not exists "drizzle"`;
    await sql`create table if not exists "drizzle"."__drizzle_migrations" (
                id serial primary key, hash text not null, created_at bigint)`;
    for (const mg of all.slice(0, at)) {
      await sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at)
                values (${mg.hash}, ${mg.folderMillis})`;
    }
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0305 and only it', async () => {
    const fn = async () =>
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from pg_proc where proname = 'mantle_ws_add_user'`
      )[0]!.n;
    expect(await fn()).toBe(0);
    const out = { lines: [] as string[], warnings: [] as string[] };
    const applied = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(applied).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(await fn()).toBe(1);
  }, 120_000);
});
