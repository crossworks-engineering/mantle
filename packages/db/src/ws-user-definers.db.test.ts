/**
 * The users of a workspace in SQL (the workspaces arch plan;
 * migration 0307_ws_user_definers), on a database of its own (so
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
 *  - with no acting login every workspace definer refuses every actor but
 *    the SQL allowlist's pair for it (system:ws-clear-ticks on
 *    mantle_ws_set_moderator, system:boot:migrate-workspaces on
 *    mantle_ws_attach_assistants; a listed actor on any other definer is
 *    refused): the asSystem exits (system:workspace-write,
 *    system:admin-area, system:app-data and every other reason),
 *    system:http:*, system:test, system:operator:*, a login actor with no
 *    scope, no actor at all; a listed actor is refused with write_mode 'ro'
 *    and inside a scope;
 *  - another brain, a disabled acting login, a read-only one: refused;
 *  - the TypeScript side: systemWork('ws-clear-ticks') sets mantle.actor on
 *    the system pool in every check mode (test:actor-off runs this file
 *    with the check off), refuses inside a scope or an asSystem exit, and a
 *    definer inside an asSystem exit is refused;
 *  - createHomeFallback (createHomeIntent) makes the login's own private
 *    workspace with mantle.scope_login set;
 *  - the catalog: the private helpers run by no role; every function that
 *    writes the four workspace tables is a rule or a named exemption
 *    (workspaceTableWriterFns), each exemption's cell;
 *  - the renumber proof: 0307's `when` is above every `when` before it (S8a's
 *    1790197680000 included), and a database just before it applies 0307
 *    and only it;
 *  - the rollback (plan rule 2): the older image's calls (createHomeFallback
 *    with no scope login; an unscoped create, event and attach) are refused
 *    under 0307 and work again after rollback/<tag>.revert.sql; the revert
 *    puts the four functions back byte for byte as a database just before 0307 has
 *    them, takes 0307 off the ledger, and a roll forward applies it again.
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
const TAG = '0307_ws_user_definers';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
/** What an operator runs before pinning the image one release back. */
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

/** The revert's statements, split as the runner splits a migration
 *  (`ledger` false: without the ledger line, for a database the runner
 *  never stamped). */
const revertStatements = (o: { ledger: boolean } = { ledger: true }): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '')
    .filter((st) => o.ledger || !st.includes('"drizzle"."__drizzle_migrations"'));

/** The four functions 0307 tightened that the older image calls. */
const TIGHTENED = [
  'public.mantle_ws_create(uuid,uuid,text,text)',
  'public.mantle_ws_private_workspace(uuid)',
  'public.mantle_workspace_event(uuid,uuid,text,jsonb)',
  'public.mantle_ws_attach_assistants()',
];

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

/** The actors the SQL allowlist takes (mantle_ws_system_work, 0307), each
 *  on its one definer. */
const CLEAR_TICKS = 'system:ws-clear-ticks';
const BOOT = 'system:boot:migrate-workspaces';

/** Every function that writes workspaces, workspace_users, workspace_events
 *  or workspace_resources, with its rule or its named exemption (plan v3.2,
 *  "Every writer of the four tables"). A new one fails the catalog cell
 *  until it is added here with a rule or an F-reviewed exemption. */
const WRITERS: Readonly<Record<string, string>> = {
  mantle_ws_create: 'rule: the acting login, no system work (0307)',
  mantle_ws_add_user: 'rule: the acting login, no system work (0307)',
  mantle_ws_set_moderator: 'rule: the acting login, or system:ws-clear-ticks (0307)',
  mantle_ws_remove_user: 'rule: the acting login, no system work (0307)',
  mantle_ws_private_workspace: 'rule: the acting login’s own, no system work (0307)',
  mantle_workspace_event: 'rule: refused with no acting login (0307)',
  mantle_ws_put_assistant:
    'private helper (no role): THE body that puts an assistant on a workspace; called by mantle_ws_set_assistant, mantle_ws_resource_add, mantle_ws_resource_remove and mantle_ws_attach_assistants, each with the rule (0307, S2a a2)',
  mantle_ws_resource_add: 'rule: the acting login, no system work (0307, S2a a2)',
  mantle_ws_resource_set_write: 'rule: the acting login, no system work (0307, S2a a2)',
  mantle_ws_resource_remove: 'rule: the acting login, no system work (0307, S2a a2)',
  mantle_ws_update_about: 'rule: the acting login, no system work (0309, S2b)',
  mantle_ws_set_contact: 'rule: the acting login, no system work (0309, S2b)',
  mantle_ws_set_landing: 'rule: the acting login, no system work (0309, S2b)',
  mantle_ws_archive: 'rule: the acting login, no system work (0309, S2b)',
  mantle_bridge_login: 'exemption until S8b: the runtime role only, its three callers pinned',
  mantle_bridge_connector: 'exemption: trigger only, its trigger dropped by the switch',
  mantle_ws_team_normal: 'exemption: migrator only (the switch)',
  mantle_ws_review_off: 'exemption: migrator only (the switch)',
  mantle_ws_spaces_fold: 'exemption: migrator only (the switch)',
  mantle_ws_migrate_bridged: 'exemption: migrator only (the switch)',
  mantle_ws_landing_held_trg: 'exemption: a guard trigger',
  mantle_ws_last_admin_mod_trg: 'exemption: a guard trigger',
};

describe('0307 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and S8a`s 1790197680000', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197680000);
    expect(Math.max(...journal.slice(0, at).map((e) => e.when))).toBeLessThan(journal[at]!.when);
  });

  it('the revert takes this migration off the ledger by its own `when`', () => {
    expect(readFileSync(REVERT, 'utf8')).toContain(
      `DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = ${journal[at]!.when};`,
    );
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
    noConn: randomUUID(), // role admin, in Admin, the connectors area off
    noAsst: randomUUID(), // role admin, in Admin, the assistants area off
  };
  const CONN = `${tag}-conn`; // a connector of the brain
  const AG = { a: randomUUID(), b: randomUUID() }; // chat assistants, no workspace

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

  /** The write role's settings for `login` (gateway/write-route.ts writeRoleSettingsSql):
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
  /** `q`, then the row it left for (ws, login) and the one event it wrote
   *  in ws (null: none; two or more fail the cell). */
  const andAfter =
    (ws: string, login: string, q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    async (tx: postgres.TransactionSql) => {
      const before = (
        await tx<{ id: string }[]>`select id::text from workspace_events where workspace_id = ${ws}`
      ).map((r) => r.id);
      await q(tx);
      const [row] = await tx<{ moderator: boolean; added_by: string | null }[]>`
        select moderator, added_by::text from workspace_users
         where workspace_id = ${ws} and login_id = ${login}`;
      const evs = await tx<{ actor: string | null; action: string; subject: unknown }[]>`
        select actor_id::text as actor, action, subject from workspace_events
         where workspace_id = ${ws} and id::text <> all (${before}::text[])`;
      expect(evs.length).toBeLessThanOrEqual(1);
      return { row: row ?? null, ev: evs[0] ?? null };
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
    const role = (k: string) =>
      k.startsWith('adm') || ['noUsers', 'noConn', 'noAsst'].includes(k) ? 'admin' : 'member';
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
    await sql`update workspace_users set limits = ${sql.json({ areas: { connectors: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noConn}`;
    await sql`update workspace_users set limits = ${sql.json({ areas: { assistants: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noAsst}`;
    await sql`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${brain}, ${CONN}, 'Connector', ARRAY['c_do']::text[], 'admin', true,
              ${sql.json({ service: CONN, mcp: { url: 'https://mcp.example.invalid/mcp' } })})`;
    await sql`insert into agents (id, owner_id, slug, name, model, system_prompt, role) values
      (${AG.a}, ${brain}, ${`${tag}-a`}, 'A', 'm', 'p', 'responder'),
      (${AG.b}, ${brain}, ${`${tag}-b`}, 'B', 'm', 'p', 'responder')`;
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
    expect(admins.map((r) => r.id)).toEqual(
      [brain, L.adm, L.adm2, L.noUsers, L.noConn, L.noAsst].sort(),
    );
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

  it('no acting login: every workspace definer refuses every actor but its own allowlist pair (a listed actor on another definer too)', async () => {
    const actors = [
      '',
      CLEAR_TICKS,
      BOOT,
      'system:workspace-write',
      'system:admin-area',
      'system:app-data',
      'system:http:admin-area',
      'system:http:login-self',
      'system:http:no-login',
      'system:operator:repair',
      'system:script:ws-clear-member-ticks',
      'system:boot:migrate-workspaces-x',
      'system:first-owner-attach',
      'system:onboarding-attach',
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
      // Part a2: the resources, the assistant and the attach.
      [
        'resource',
        (tx) =>
          tx`select mantle_ws_resource_add(${brain}::uuid, ${W}::uuid, 'connector', 'x', false)`,
      ],
      [
        'write tick',
        (tx) =>
          tx`select mantle_ws_resource_set_write(${brain}::uuid, ${W}::uuid, 'connector', 'x', true)`,
      ],
      [
        'unresource',
        (tx) => tx`select mantle_ws_resource_remove(${brain}::uuid, ${W}::uuid, 'connector', 'x')`,
      ],
      [
        'assistant',
        (tx) => tx`select mantle_ws_set_assistant(${brain}::uuid, ${W}::uuid, null::uuid)`,
      ],
      ['attach', (tx) => tx`select mantle_ws_attach_assistants()`],
    ];
    // The two pairs the allowlist takes (their cells follow); every other
    // pair is refused, a listed actor on another definer included.
    const pairs = new Set([`${CLEAR_TICKS} tick`, `${BOOT} attach`]);
    const allowed: string[] = [];
    // No setting at all (no actor, no write mode), then each actor alone.
    const settings: Array<[string, Record<string, string>]> = [
      ['(none)', {}],
      ...actors.map((a): [string, Record<string, string>] => [a, asActor(a)]),
    ];
    for (const [actor, set] of settings) {
      for (const [name, q] of writers) {
        if (pairs.has(`${actor} ${name}`)) continue;
        const out = await run(set, q);
        if (out.ok || out.state !== '42501' || !/no acting login|only the acting/.test(out.msg)) {
          allowed.push(`${actor} ${name}: ${JSON.stringify(out)}`);
        }
      }
    }
    expect(allowed).toEqual([]);
  });

  it('a listed actor is system work on its one definer: allowed with no scope; refused read-only, inside a scope, or on another definer', async () => {
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
    // On another definer: refused, nothing written.
    refused(await run(sys, add(W, L.target, false)), '42501', 'no_acting_login');
    refused(await run(sys, remove(W, L.mem)), '42501', 'no_acting_login');
    refused(await run(asActor(BOOT), setMod(W, L.mem, true)), '42501', 'no_acting_login');
    // The invariants hold for system work too.
    refused(await run(sys, setMod(adminWs, L.adm, false)), '55000', 'admin_workspace');
    refused(await run(sys, setMod(ARCH, L.mod, false)), '55000', 'archived');
    // write_mode 'ro', a scope open, a login set: never system work.
    refused(await run(asActor(CLEAR_TICKS, 'ro'), setMod(W, L.mem, true)), '42501', 'read_only');
    refused(
      await run({ ...sys, 'mantle.ws': `{${W}}` }, setMod(W, L.mem, true)),
      '42501',
      'no_acting_login',
    );
    const fact = async (s: Record<string, string>, fn: string) =>
      run(
        s,
        async (tx) => (await tx<{ a: boolean }[]>`select mantle_ws_system_work(${fn}) as a`)[0]!.a,
      );
    const TICK = 'mantle_ws_set_moderator';
    const ATTACH = 'mantle_ws_attach_assistants';
    expect(await fact(sys, TICK)).toEqual({ ok: true, v: true });
    expect(await fact(asActor(BOOT), ATTACH)).toEqual({ ok: true, v: true });
    // Each actor on its one definer only.
    for (const fn of [
      ATTACH,
      'mantle_ws_add_user',
      'mantle_ws_remove_user',
      'mantle_ws_create',
      'mantle_ws_private_workspace',
      'mantle_workspace_event',
      'mantle_ws_resource_add',
      'mantle_ws_resource_set_write',
      'mantle_ws_resource_remove',
      'mantle_ws_set_assistant',
    ]) {
      expect(await fact(sys, fn), fn).toEqual({ ok: true, v: false });
    }
    for (const fn of [TICK, 'mantle_ws_add_user', 'mantle_ws_create', 'mantle_ws_set_assistant']) {
      expect(await fact(asActor(BOOT), fn), fn).toEqual({ ok: true, v: false });
    }
    expect(await fact(asActor(BOOT, 'ro'), ATTACH)).toEqual({ ok: true, v: false });
    expect(await fact(asActor(CLEAR_TICKS, 'ro'), TICK)).toEqual({ ok: true, v: false });
    expect(await fact({ ...sys, 'mantle.ws': '{}' }, TICK)).toEqual({ ok: true, v: false });
    expect(await fact({ ...sys, 'mantle.scope_login': L.adm }, TICK)).toEqual({
      ok: true,
      v: false,
    });
    expect(await fact(asActor('system:workspace-write'), TICK)).toEqual({ ok: true, v: false });
    expect(await fact({}, TICK)).toEqual({ ok: true, v: false });
  });

  it('resources (a2): connectors by the connectors area, the assistant by the assistants area; each refusal in the routes` order', async () => {
    const resAdd =
      (kind: string, ref: string, w = false, ws = W) =>
      (tx: postgres.TransactionSql) =>
        tx`select mantle_ws_resource_add(${brain}::uuid, ${ws}::uuid, ${kind}, ${ref}, ${w})`;
    const tick =
      (ref: string, w: boolean, kind = 'connector') =>
      (tx: postgres.TransactionSql) =>
        tx`select mantle_ws_resource_set_write(${brain}::uuid, ${W}::uuid, ${kind}, ${ref}, ${w})`;
    const resDel = (kind: string, ref: string) => (tx: postgres.TransactionSql) =>
      tx`select mantle_ws_resource_remove(${brain}::uuid, ${W}::uuid, ${kind}, ${ref})`;
    const rowsOf = async (tx: postgres.TransactionSql) => ({
      res: await tx`select type, ref_id, write, added_by::text from workspace_resources
                     where workspace_id = ${W} order by type, ref_id`,
      ev: await tx`select actor_id::text as actor, action, subject from workspace_events
                    where workspace_id = ${W} and action like 'resource.%' order by action`,
    });
    const adm = await asLogin(L.adm);
    // A connector with the Write tick, then cleared, then taken off.
    const conn = await run(adm, async (tx) => {
      await resAdd('connector', CONN, true)(tx);
      await tick(CONN, false)(tx);
      await resDel('connector', CONN)(tx);
      return rowsOf(tx);
    });
    expect(conn).toEqual({
      ok: true,
      v: {
        res: [],
        ev: [
          {
            actor: L.adm,
            action: 'resource.add',
            subject: { kind: 'connector', id: CONN, write: true },
          },
          { actor: L.adm, action: 'resource.remove', subject: { kind: 'connector', id: CONN } },
          {
            actor: L.adm,
            action: 'resource.update',
            subject: { kind: 'connector', id: CONN, write: false },
          },
        ],
      },
    });
    // The assistant: on, then off; agents.workspace_id follows.
    const asst = await run(adm, async (tx) => {
      await resAdd('assistant', AG.a.toUpperCase())(tx);
      const [on] = await tx`select workspace_id::text as w from agents where id = ${AG.a}`;
      await resDel('assistant', AG.a)(tx);
      const [off] = await tx`select workspace_id::text as w from agents where id = ${AG.a}`;
      return { on: on!.w, off: off!.w, ...(await rowsOf(tx)) };
    });
    expect(asst).toEqual({
      ok: true,
      v: {
        on: W,
        off: null,
        res: [],
        ev: [
          { actor: L.adm, action: 'resource.add', subject: { kind: 'assistant', id: AG.a } },
          { actor: L.adm, action: 'resource.remove', subject: { kind: 'assistant', id: AG.a } },
        ],
      },
    });
    // Member-negative: a Moderator of W, an Admin user without connectors
    // (or without assistants), another login's scope: refused, nothing written.
    refused(
      await run(await asLogin(L.mod), resAdd('connector', CONN)),
      '42501',
      'resources_admin_only',
    );
    refused(
      await run(await asLogin(L.mem), resAdd('connector', CONN)),
      '42501',
      'resources_admin_only',
    );
    refused(
      await run(await asLogin(L.noConn), resAdd('connector', CONN)),
      '42501',
      'resources_admin_only',
    );
    refused(
      await run(await asLogin(L.noAsst), resAdd('assistant', AG.a)),
      '42501',
      'resources_admin_only',
    );
    expect(await run(await asLogin(L.noAsst), resAdd('connector', CONN))).toMatchObject({
      ok: true,
    });
    refused(await run(await asLogin(L.out), resAdd('connector', CONN)), 'P0002', 'not_found');
    refused(await run(adm, resAdd('connector', CONN, false, ARCH)), '55000', 'archived');
    refused(await run(adm, resAdd('connector', 'nope')), '22023', 'no_connector');
    refused(await run(adm, resAdd('assistant', 'not-a-uuid')), '22023', 'invalid_id');
    refused(await run(adm, resAdd('assistant', randomUUID())), '22023', 'no_assistant');
    refused(await run(adm, resAdd('widget', CONN)), 'P0002', 'no_kind');
    refused(await run(adm, tick(CONN, true)), 'P0002', 'connector_not_on');
    refused(await run(adm, tick(AG.a, true, 'assistant')), '22023', 'no_write_tick');
    refused(await run(adm, resDel('assistant', AG.a)), 'P0002', 'assistant_not_on');
    refused(
      await run(adm, async (tx) => {
        await resAdd('connector', CONN)(tx);
        await resAdd('connector', CONN)(tx);
      }),
      '55000',
      'connector_exists',
    );
    refused(
      await run(adm, async (tx) => {
        await resAdd('assistant', AG.a)(tx);
        await resAdd('assistant', AG.b)(tx);
      }),
      '55000',
      'assistant_exists',
    );
    // One with history stays where it is.
    refused(
      await run(adm, async (tx) => {
        await tx`select mantle_ws_set_assistant(${brain}::uuid, ${W}::uuid, ${AG.a}::uuid)`;
        await tx`insert into chat_threads (owner_id, agent_id, title, status)
                 values (${brain}, ${AG.a}, 't', 'open')`;
        await tx`select mantle_ws_set_assistant(${brain}::uuid, ${W}::uuid, ${AG.b}::uuid)`;
      }),
      '55000',
      'assistant_has_history',
    );
    refused(
      await run(await asLogin(L.adm, { mode: 'ro' }), resAdd('connector', CONN)),
      '42501',
      'read_only',
    );
  });

  it('the assistant attach (a2): system work at boot, the assistants area in a login`s scope, refused otherwise', async () => {
    const attach = async (tx: postgres.TransactionSql) =>
      (await tx<{ n: number }[]>`select mantle_ws_attach_assistants() as n`)[0]!.n;
    // An Admin with no assistant and no removal event: the persona goes on.
    const persona = randomUUID();
    const setup = async (tx: postgres.TransactionSql) => {
      await tx`delete from workspace_resources where workspace_id = ${adminWs} and type = 'assistant'`;
      await tx`delete from workspace_events where workspace_id = ${adminWs} and action like 'resource.%'`;
      await tx`insert into agents (id, owner_id, slug, name, model, system_prompt, role, audience, enabled, priority)
               values (${persona}, ${brain}, ${`${tag}-p`}, 'P', 'm', 'p', 'responder', 'admin', true, 1000)`;
    };
    const after = async (tx: postgres.TransactionSql) => {
      const n = await attach(tx);
      const res = await tx`select ref_id, write, added_by from workspace_resources
                            where workspace_id = ${adminWs} and type = 'assistant'`;
      const ev = await tx`select actor_id, action, subject from workspace_events
                           where workspace_id = ${adminWs} and action = 'resource.add'`;
      return { n, res, ev };
    };
    const want = {
      ok: true,
      v: {
        n: 1,
        res: [{ ref_id: persona, write: true, added_by: null }],
        ev: [
          {
            actor_id: null,
            action: 'resource.add',
            subject: { kind: 'assistant', id: persona, by: 'attach' },
          },
        ],
      },
    };
    for (const set of [asActor(BOOT), await asLogin(L.adm), await asLogin(L.noUsers)]) {
      expect(await run(set, async (tx) => (await setup(tx), after(tx)))).toEqual(want);
    }
    refused(
      await run(await asLogin(L.noAsst), async (tx) => (await setup(tx), attach(tx))),
      '42501',
      'resources_admin_only',
    );
    refused(
      await run(await asLogin(L.mod), async (tx) => (await setup(tx), attach(tx))),
      '42501',
      'resources_admin_only',
    );
    refused(await run(asActor(BOOT, 'ro'), attach), '42501', 'read_only');
    refused(await run(asActor('system:workspace-write'), attach), '42501', 'no_acting_login');
    // The other listed actor: not on this definer.
    refused(await run(asActor(CLEAR_TICKS), attach), '42501', 'no_acting_login');
    // Nothing to do: 0, nothing written.
    expect(await run(asActor(BOOT), attach)).toMatchObject({ ok: true });
  });

  it('mantle_ws_create: the acting login`s own, on its brain; no system work makes one', async () => {
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
    for (const actor of [CLEAR_TICKS, BOOT]) {
      refused(
        await run(
          asActor(actor),
          (tx) => tx`select mantle_ws_create(${brain}::uuid, ${L.mod}::uuid, 'Sys', '')`,
        ),
        '42501',
        'no_acting_login',
      );
    }
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
    // The TypeScript path (createHomeFallback): it sets mantle.scope_login
    // to the login bound to the call, and refuses another.
    const ask = () => m.createHomeIntent(L.priv, null, { ownWork: true, makePrivate: true });
    await expect(m.runAsActor(m.loginActor(L.mem), ask)).rejects.toThrow(/not the one bound/);
    await expect(ask()).rejects.toThrow(/not the one bound/);
    const home = await m.runAsActor(m.loginActor(L.priv), ask);
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

  it('rollback: the older image`s calls are refused under 0307 and work again after the revert (rolled back)', async () => {
    const fresh = randomUUID();
    const mk = async (tx: postgres.TransactionSql) => {
      await tx`insert into auth.users (id, email, password_hash, role, display_name)
               values (${fresh}, ${`${tag}-fresh@example.invalid`}, 'x', 'member', 'fresh')`;
    };
    // This database has no ledger (the test support applies the migrations
    // itself): the four functions only.
    const revert = async (tx: postgres.TransactionSql) => {
      for (const st of revertStatements({ ledger: false })) await tx.unsafe(st);
    };
    const priv = async (tx: postgres.TransactionSql) =>
      (
        await tx<
          { ws: string | null }[]
        >`select mantle_ws_private_workspace(${fresh}::uuid)::text as ws`
      )[0]!.ws;
    // createHomeFallback as the older image runs it: the system pool, the
    // request's login actor, no scope login. Under 0307: refused, so every
    // create that needs the private workspace is refused.
    const older = asActor(`login:rw:${fresh}`);
    expect(await run(older, async (tx) => (await mk(tx), priv(tx)))).toMatchObject({
      ok: false,
      state: '42501',
    });
    expect(
      await run(older, async (tx) => {
        await mk(tx);
        await revert(tx);
        const ws = await priv(tx);
        const [p] = await tx<{ ws: string }[]>`
          select workspace_id::text as ws from private_workspaces where login_id = ${fresh}`;
        return { made: typeof ws === 'string', kept: p?.ws === ws };
      }),
    ).toEqual({ ok: true, v: { made: true, kept: true } });
    // The other three unscoped, by an actor no allowlist pair names (the
    // older image's onboarding attach): refused under 0307 (the cell "no
    // acting login" above), back to their 0293, 0279 and 0260 answers.
    expect(
      await run(asActor('system:onboarding-attach'), async (tx) => {
        await revert(tx);
        const [c] = await tx<{ id: string }[]>`
          select mantle_ws_create(${brain}::uuid, ${L.mod}::uuid, ${`${tag} rb`}, '')::text as id`;
        await tx`select mantle_workspace_event(${W}::uuid, ${L.mod}::uuid, 'grant.add', '{}')`;
        const [n] = await tx<{ n: number }[]>`select mantle_ws_attach_assistants() as n`;
        return { created: typeof c?.id === 'string', attached: typeof n?.n === 'number' };
      }),
    ).toEqual({ ok: true, v: { created: true, attached: true } });
    // Rolled back: 0307's bodies are in place for the cells after this one.
    expect(await run({}, priv)).toMatchObject({ ok: false, state: '42501' });
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
    // Outside a transaction too, a read included: every
    // statement of workspace system work goes with its actor.
    const bare = (await m.systemWork(
      () =>
        m.db.execute(sqlTag`select current_setting('mantle.actor', true) as a,
                                   current_setting('mantle.write_mode', true) as w`),
      'ws-clear-ticks',
    )) as unknown as { a: string; w: string }[];
    expect(bare[0]).toEqual({ a: CLEAR_TICKS, w: 'rw' });
    await m
      .systemWork(
        () =>
          m.db.execute(
            sqlTag`select mantle_ws_set_moderator(mantle_brain_id(), ${W}::uuid, ${L.out}::uuid, true, 'x')`,
          ),
        'ws-clear-ticks',
      )
      .then(
        () => expect.unreachable('L.out is no user of W'),
        (err: unknown) =>
          expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(
            /mantle_ws:not_user/,
          ),
      );
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

  it('TypeScript: a definer inside an asSystem exit (admin-area) is refused; systemWork(ws-clear-ticks) refuses any scope', async () => {
    const inExit = m.asSystem(
      () =>
        m.db.transaction(async (tx) => {
          await tx.execute(
            sqlTag`select mantle_ws_set_moderator(mantle_brain_id(), ${W}::uuid, ${L.mem}::uuid, true, null)`,
          );
        }),
      'admin-area',
    );
    await expect(inExit).rejects.toSatisfy((err: unknown) =>
      /no acting login/.test(String((err as { cause?: Error }).cause?.message ?? err)),
    );
    await expect(
      m.asSystem(() => m.systemWork(async () => 1, 'ws-clear-ticks'), 'admin-area'),
    ).rejects.toThrow(/outside every scope and request/);
    await expect(
      m.withViewer({ login: L.mod }, () => m.systemWork(async () => 1, 'ws-clear-ticks')),
    ).rejects.toThrow(/outside every scope and request/);
    // asSystem takes no workspace system reason (a type error):
    // @ts-expect-error: 'ws-clear-ticks' is no AsSystemReason.
    const typed: Parameters<typeof m.asSystem>[1] = 'ws-clear-ticks';
    expect(typed).toBe('ws-clear-ticks');
    // Nor the retired 'workspace-write' (plan v3.2 S2b, 0309).
    // @ts-expect-error: 'workspace-write' is no AsSystemReason.
    const retired: Parameters<typeof m.asSystem>[1] = 'workspace-write';
    expect(retired).toBe('workspace-write');
  });

  it('catalog: the private helpers run by no role; the user definers are definers PUBLIC may not run', async () => {
    const helpers = [
      'public.mantle_ws_system_work(text)',
      'public.mantle_ws_acting_login(text,uuid)',
      'public.mantle_ws_user_seat(text,uuid,uuid,uuid)',
      'public.mantle_ws_put_assistant(text,uuid,uuid,uuid,uuid,uuid,text)',
      'public.mantle_ws_resource_seat(text,uuid,uuid,text)',
      'public.mantle_ws_assistant_of(uuid)',
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
      'public.mantle_ws_resource_add(uuid,uuid,text,text,boolean)',
      'public.mantle_ws_resource_set_write(uuid,uuid,text,text,boolean)',
      'public.mantle_ws_resource_remove(uuid,uuid,text,text)',
      'public.mantle_ws_set_assistant(uuid,uuid,uuid)',
      'public.mantle_ws_attach_assistants()',
    ];
    const defs = await sql<{ fn: string; definer: boolean; pub: boolean; path: string[] }[]>`
      select f.fn, p.prosecdef as definer, has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             coalesce(p.proconfig, '{}') as path
        from unnest(${definers}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(defs).toHaveLength(definers.length);
    for (const d of defs) {
      expect(d.definer, d.fn).toBe(true);
      expect(d.pub, d.fn).toBe(false);
      expect(d.path, d.fn).toContain('search_path=public, pg_temp');
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

describe.skipIf(!URL)('a database just before 0307 runs 0307 and only it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  /** The four tightened functions as the catalog has them: the whole
   *  definition and the grants. */
  type Def = { fn: string; def: string; acl: string | null };
  const defs = async (): Promise<Def[]> => [
    ...(await sql<Def[]>`
      select f.fn, pg_get_functiondef(p.oid) as def, p.proacl::text as acl
        from unnest(${TIGHTENED}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)
       order by 1`),
  ];
  let atBefore: Def[] = [];

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
    atBefore = await defs();
    expect(atBefore).toHaveLength(TIGHTENED.length);
  }, 300_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it('the runner applies 0307 and only it', async () => {
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

  it('rollback: the revert puts the four back byte for byte, takes 0307 off the ledger; a roll forward applies it again', async () => {
    const at0307 = await defs();
    expect(at0307).not.toEqual(atBefore);
    const ledger = async () =>
      (
        await sql<{ n: number }[]>`
          select count(*)::int as n from "drizzle"."__drizzle_migrations"
           where created_at = ${journal[at]!.when}`
      )[0]!.n;
    expect(await ledger()).toBe(1);
    await sql.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await defs()).toEqual(atBefore);
    expect(await ledger()).toBe(0);
    const out = { lines: [] as string[], warnings: [] as string[] };
    const applied = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(applied).toBe(1);
    expect(out.warnings).toEqual([]);
    expect(await defs()).toEqual(at0307);
  }, 120_000);
});
