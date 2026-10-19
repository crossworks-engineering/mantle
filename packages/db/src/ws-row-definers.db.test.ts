/**
 * The workspace row in SQL (workspaces arch plan v3.2, S2b; migration
 * 0309_ws_row_definers), on a database of its own (so mantle_brain_id() is
 * this file's anchor) that the workspaces switch made live, with the actor
 * and the edit check in warn and in on (as on the fleet):
 *
 *  - mantle_ws_update_about, mantle_ws_set_contact, mantle_ws_set_landing
 *    and mantle_ws_archive act for the acting login: a Moderator of the
 *    workspace and an Admin user with the users area as the routes allowed
 *    them; a plain user, another workspace's Moderator, an Admin user
 *    without the users area, no acting login and an archived workspace
 *    refused, nothing written; each change with its one event row;
 *  - every refusal a route answers, by its code and SQLSTATE;
 *  - no acting login: each definer refuses every actor, the two the SQL
 *    allowlist names included (mantle_ws_system_work names none of these);
 *  - the catalog: definers with a fixed search_path, PUBLIC revoked, the
 *    write role's three and the runtime role's archive, the private app
 *    rule run by no role;
 *  - the renumber proof: 0309's `when` is above every `when` before it (S6
 *    c1's 1790197800000 included), and a database just before it applies
 *    0309 and only it;
 *  - the rollback: rollback/<tag>.revert.sql drops 0309's functions, takes
 *    it off the ledger, and a roll forward applies it again.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ws-row-definers.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
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
import { viewerRoleName } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const DIR = join(__dirname, '..', 'migrations');
const TAG = '0309_ws_row_definers';
/** What an operator runs before pinning the image one release back. */
const REVERT = join(__dirname, '..', 'rollback', `${TAG}.revert.sql`);

const revertStatements = (): string[] =>
  readFileSync(REVERT, 'utf8')
    .split('--> statement-breakpoint')
    .map((st) => st.trim())
    .filter((st) => st.replace(/^--.*$/gm, '').trim() !== '');

/** The functions 0309 adds. */
const ADDED = [
  'public.mantle_ws_update_about(uuid,uuid,jsonb)',
  'public.mantle_ws_set_contact(uuid,uuid,uuid)',
  'public.mantle_ws_app_held(uuid,uuid,uuid)',
  'public.mantle_ws_set_landing(uuid,uuid,uuid)',
  'public.mantle_ws_archive(uuid,uuid)',
];

const journal = (
  JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  }
).entries;
const at = journal.findIndex((e) => e.tag === TAG);

describe('0309 is stamped above every `when` before it (renumber proof)', () => {
  it('is stamped above its predecessor and S6 c1`s 1790197800000', () => {
    expect(at).toBeGreaterThan(0);
    expect(journal[at]!.when).toBeGreaterThan(journal[at - 1]!.when);
    expect(journal[at]!.when).toBeGreaterThan(1790197800000);
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
type Mode = 'warn' | 'on';

describe.skipIf(!URL)('the workspace row definers (S2b)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let m: typeof import('./index');
  let brain = '';
  let adminWs = '';
  const tag = `wrd${randomUUID().slice(0, 8)}`;
  const W = randomUUID(); // mod (Moderator), mem (plain user)
  const X = randomUUID(); // modX (Moderator): another workspace
  const ARCH = randomUUID(); // archived: mod (Moderator)
  const V = randomUUID(); // mod (Moderator): holds a share only
  const L = {
    adm: randomUUID(), // role admin, in Admin, the users area
    noUsers: randomUUID(), // role admin, in Admin, the users area off
    mod: randomUUID(),
    mem: randomUUID(),
    modX: randomUUID(),
  };
  const CONTACT = randomUUID(); // a contact node of the brain
  const NOTE = randomUUID(); // a note node: no contact
  const APP = { ready: randomUUID(), broken: randomUUID(), elsewhere: randomUUID() };
  const SHARED = randomUUID(); // a note homed in X, shared with W
  const HOMED = randomUUID(); // a note homed in X (X cannot archive)

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

  /** The write role's settings for `login` (client.ts writeRoleSettingsSql). */
  const asLogin = async (login: string): Promise<Record<string, string>> => {
    const scope = await m.loginScopeFor(login);
    const arr = (ids: readonly string[]) => `{${ids.join(',')}}`;
    return {
      'mantle.ws': arr(scope.ws),
      'mantle.mod_ws': arr(scope.modWs),
      'mantle.login_id': login,
      'mantle.actor': `login:rw:${login}`,
      'mantle.write_mode': 'rw',
    };
  };
  const refused = (out: Out, state: string, code: string) => {
    expect(out.ok, JSON.stringify(out)).toBe(false);
    if (out.ok) return;
    expect(out.state, out.msg).toBe(state);
    expect(out.msg).toMatch(new RegExp(`^mantle_ws:${code}\\b`));
  };
  const setMode = async (mode: Mode) => {
    await sql`select mantle_set_actor_check(${mode}, 50, 'test')`;
    await sql`select mantle_set_edit_check(${mode}, 50, 'test')`;
  };

  const about = (ws: string, patch: Record<string, unknown>) => (tx: postgres.TransactionSql) =>
    tx`select mantle_ws_update_about(${brain}::uuid, ${ws}::uuid, ${tx.json(patch as never)})`;
  const contact = (ws: string, c: string | null) => (tx: postgres.TransactionSql) =>
    tx`select mantle_ws_set_contact(${brain}::uuid, ${ws}::uuid, ${c}::uuid)`;
  const landing = (ws: string, app: string | null) => (tx: postgres.TransactionSql) =>
    tx`select mantle_ws_set_landing(${brain}::uuid, ${ws}::uuid, ${app}::uuid)`;
  const archive = (ws: string) => async (tx: postgres.TransactionSql) =>
    (await tx<{ r: unknown }[]>`select mantle_ws_archive(${brain}::uuid, ${ws}::uuid) as r`)[0]!.r;

  /** `q`, then the workspace row and the events it wrote in `ws`. */
  const andAfter =
    (ws: string, q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    async (tx: postgres.TransactionSql) => {
      const before = (
        await tx<{ id: string }[]>`select id::text from workspace_events where workspace_id = ${ws}`
      ).map((r) => r.id);
      const v = await q(tx);
      const [row] = await tx<Record<string, unknown>[]>`
        select name, description, color, icon, contact_id::text as contact,
               landing_app_id::text as landing, archived_at is not null as archived
          from workspaces where id = ${ws}`;
      const evs = await tx<{ actor: string | null; action: string; subject: unknown }[]>`
        select actor_id::text as actor, action, subject from workspace_events
         where workspace_id = ${ws} and id::text <> all (${before}::text[]) order by at, action`;
      return { v, row, evs };
    };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    brain = await ensureTestAnchor(sql);
    process.env.DATABASE_URL = scratch.url;
    process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
    for (const [k, id] of Object.entries(L)) {
      await sql`insert into auth.users (id, email, password_hash, role, display_name)
                values (${id}, ${`${tag}-${k}@example.invalid`}, 'x',
                        ${k.startsWith('adm') || k === 'noUsers' ? 'admin' : 'member'}, ${k})`;
    }
    await sql`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
              on conflict (id) do nothing`;
    await runWorkspacesSwitch(scratch.url);
    m = await import('./index');
    adminWs = (
      await sql<{ id: string }[]>`
        select id::text from workspaces where owner_id = ${brain} and is_admin`
    )[0]!.id;
    // The fixtures write the tables as the superuser.
    await sql`update workspace_users set limits = ${sql.json({ areas: { users: false } })}
               where workspace_id = ${adminWs} and login_id = ${L.noUsers}`;
    await sql`insert into workspaces (id, owner_id, name) values
      (${W}, ${brain}, ${`${tag} W`}), (${X}, ${brain}, ${`${tag} X`}),
      (${ARCH}, ${brain}, ${`${tag} Arch`}), (${V}, ${brain}, ${`${tag} V`})`;
    await sql`update workspaces set archived_at = now() where id = ${ARCH}`;
    await sql`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W}, ${L.mod}, true), (${W}, ${L.mem}, false), (${X}, ${L.modX}, true),
      (${ARCH}, ${L.mod}, true), (${V}, ${L.mod}, true)`;
    // Items: made under their kind's root folder, then given their home.
    const rootOf = async (path: string) => {
      await sql`insert into nodes (owner_id, type, title, path)
        select ${brain}, 'branch', ${path}, ${path}::ltree
         where not exists (select 1 from nodes where owner_id = ${brain}
                             and type = 'branch' and path = ${path}::ltree)`;
      return (
        await sql<{ id: string }[]>`select id::text as id from nodes
          where owner_id = ${brain} and type = 'branch' and path = ${path}::ltree`
      )[0]!.id;
    };
    const roots: Record<string, { id: string; path: string }> = {};
    for (const [type, path] of [
      ['note', 'notes'],
      ['app', 'apps'],
      ['contact', 'contacts'],
    ] as const) {
      roots[type] = { id: await rootOf(path), path };
    }
    const item = async (id: string, type: string, home: string) => {
      const root = roots[type]!;
      await sql.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${root.id}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path, data)
                 values (${id}, ${brain}, ${type}, ${`${tag} ${type} ${id.slice(0, 8)}`},
                         ${root.path}::ltree, ${sql.json({ rank: 'a0' })})`;
      });
      await sql.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true)`;
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
        await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                 values (${id}, ${home}, true, false)`;
      });
    };
    await item(CONTACT, 'contact', adminWs);
    await item(NOTE, 'note', W);
    for (const id of [APP.ready, APP.broken]) await item(id, 'app', W);
    await item(APP.elsewhere, 'app', X);
    await sql`insert into apps (node_id, published_build) values
      (${APP.ready}, ${sql.json({ ok: true })}), (${APP.broken}, ${sql.json({ ok: false })}),
      (${APP.elsewhere}, ${sql.json({ ok: true })})`;
    await item(SHARED, 'note', X);
    await item(HOMED, 'note', X);
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`select mantle_lock_heads(array[${SHARED}]::uuid[], 'update')`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${SHARED}, ${W}, false, false), (${SHARED}, ${V}, false, false)`;
    });
  }, 300_000);

  afterAll(async () => {
    if (sql) await sql`select mantle_set_actor_check('warn', 50, 'test')`;
    if (sql) await sql`select mantle_set_edit_check('warn', 50, 'test')`;
    await m?.closeDb();
    await sql?.end();
    await scratch?.drop();
  });

  for (const mode of ['warn', 'on'] as const) {
    it(`${mode}: the name, description and look (mantle_ws_update_about)`, async () => {
      await setMode(mode);
      const patch = { name: `${tag} W2`, description: 'd', color: null, icon: 'star' };
      for (const who of [L.mod, L.adm]) {
        const out = await run(await asLogin(who), andAfter(W, about(W, patch)));
        expect(out).toEqual({
          ok: true,
          v: {
            v: expect.anything(),
            row: expect.objectContaining({ name: `${tag} W2`, description: 'd', icon: 'star' }),
            evs: [
              {
                actor: who,
                action: 'workspace.update',
                subject: { name: `${tag} W2`, description: 'd', icon: 'star' },
              },
            ],
          },
        });
      }
      // Nothing that changes: no event, no write.
      const same = await run(
        await asLogin(L.mod),
        andAfter(W, about(W, { name: `${tag} W`, color: null })),
      );
      expect(same.ok && (same.v as { evs: unknown[] }).evs).toEqual([]);
      // Refused, in the route's order.
      refused(await run(await asLogin(L.mem), about(W, patch)), '42501', 'about_forbidden');
      refused(await run(await asLogin(L.modX), about(W, patch)), 'P0002', 'not_found');
      refused(await run(await asLogin(L.noUsers), about(W, patch)), 'P0002', 'not_found');
      refused(await run({}, about(W, patch)), '42501', 'no_acting_login');
      refused(await run(await asLogin(L.mod), about(ARCH, patch)), 'P0002', 'not_found');
      refused(await run(await asLogin(L.adm), about(ARCH, patch)), '55000', 'archived');
      refused(
        await run(await asLogin(L.adm), about(adminWs, { name: 'Renamed' })),
        '55000',
        'admin_keeps_name',
      );
      refused(
        await run(await asLogin(L.mod), about(W, { name: ' ADMIN ' })),
        '55000',
        'reserved_name',
      );
      refused(await run(await asLogin(L.mod), about(W, { name: 3 })), '22023', 'invalid');
      // Admin's look changes; its name stays.
      const look = await run(
        await asLogin(L.adm),
        andAfter(adminWs, about(adminWs, { icon: 'x' })),
      );
      expect(look.ok && (look.v as { evs: unknown[] }).evs).toHaveLength(1);
    });

    it(`${mode}: the contact (mantle_ws_set_contact): an Admin user with the users area only`, async () => {
      await setMode(mode);
      const out = await run(await asLogin(L.adm), andAfter(W, contact(W, CONTACT)));
      expect(out.ok && (out.v as { row: { contact: string } }).row.contact).toBe(CONTACT);
      expect(out.ok && (out.v as { evs: unknown[] }).evs).toEqual([
        { actor: L.adm, action: 'workspace.update', subject: { contactNodeId: CONTACT } },
      ]);
      // Clearing a contact that is none changes nothing.
      const none = await run(await asLogin(L.adm), andAfter(W, contact(W, null)));
      expect(none.ok && (none.v as { evs: unknown[] }).evs).toEqual([]);
      refused(await run(await asLogin(L.adm), contact(W, NOTE)), '22023', 'no_contact');
      refused(await run(await asLogin(L.adm), contact(W, randomUUID())), '22023', 'no_contact');
      refused(await run(await asLogin(L.mod), contact(W, CONTACT)), '42501', 'contact_admin_only');
      refused(await run(await asLogin(L.mem), contact(W, CONTACT)), '42501', 'contact_admin_only');
      refused(await run(await asLogin(L.modX), contact(W, CONTACT)), 'P0002', 'not_found');
      refused(
        await run(await asLogin(L.noUsers), contact(adminWs, CONTACT)),
        '42501',
        'contact_admin_only',
      );
      refused(await run({}, contact(W, CONTACT)), '42501', 'no_acting_login');
      refused(await run(await asLogin(L.adm), contact(ARCH, CONTACT)), '55000', 'archived');
    });

    it(`${mode}: the landing app (mantle_ws_set_landing): a Moderator of the workspace, an app it holds with a green build`, async () => {
      await setMode(mode);
      const out = await run(await asLogin(L.mod), andAfter(W, landing(W, APP.ready)));
      expect(out.ok && (out.v as { row: { landing: string } }).row.landing).toBe(APP.ready);
      expect(out.ok && (out.v as { evs: unknown[] }).evs).toEqual([
        { actor: L.mod, action: 'workspace.landing', subject: { appId: APP.ready } },
      ]);
      const none = await run(await asLogin(L.mod), andAfter(W, landing(W, null)));
      expect(none.ok && (none.v as { evs: unknown[] }).evs).toEqual([]);
      refused(
        await run(await asLogin(L.mod), landing(W, APP.broken)),
        '55000',
        'landing_app_not_ready',
      );
      for (const app of [APP.elsewhere, NOTE, randomUUID()]) {
        refused(await run(await asLogin(L.mod), landing(W, app)), '55000', 'landing_app_not_held');
      }
      // Never an Admin area: an Admin user outside the workspace may not.
      refused(await run(await asLogin(L.adm), landing(W, APP.ready)), '42501', 'landing_forbidden');
      refused(await run(await asLogin(L.mem), landing(W, APP.ready)), '42501', 'landing_forbidden');
      refused(await run(await asLogin(L.modX), landing(W, APP.ready)), 'P0002', 'not_found');
      refused(await run({}, landing(W, APP.ready)), '42501', 'no_acting_login');
      refused(await run(await asLogin(L.mod), landing(ARCH, null)), 'P0002', 'not_found');
      refused(await run(await asLogin(L.adm), landing(ARCH, null)), '55000', 'archived');
    });

    it(`${mode}: the archive (mantle_ws_archive): heads first, the shares dropped, the event`, async () => {
      await setMode(mode);
      for (const who of [L.mod, L.adm]) {
        const out = await run(await asLogin(who), async (tx) => {
          const r = await andAfter(V, archive(V))(tx);
          const left = await tx<{ n: number }[]>`
            select count(*)::int as n from item_grants where workspace_id = ${V}`;
          return { ...r, left: left[0]!.n };
        });
        expect(out, JSON.stringify(out)).toEqual({
          ok: true,
          v: {
            v: { items: 0, grants: 1 },
            row: expect.objectContaining({ archived: true }),
            evs: [
              {
                actor: who,
                action: 'workspace.archive',
                subject: { grantsDropped: 1, exclusionsDropped: 0 },
              },
            ],
            left: 0,
          },
        });
      }
      // While W is an item's home (NOTE and the two apps): refused, with the count.
      const held = await run(await asLogin(L.mod), archive(W));
      refused(held, '55000', 'holds_items');
      expect(!held.ok && held.msg).toMatch(/: 3 item\(s\) have their home/);
      // A scope that names W but not the Moderator seat (mod_ws empty) still
      // counts every home: the count is the owner's, never the scope's (audit
      // MED-1: through mantle_ws_item_counts it counted 0 and archived W).
      const narrow = {
        'mantle.ws': `{${W}}`,
        'mantle.mod_ws': '{}',
        'mantle.scope_login': L.mod,
        'mantle.login_id': L.mod,
        'mantle.actor': `login:rw:${L.mod}`,
        'mantle.write_mode': 'rw',
      };
      const heldNarrow = await run(narrow, archive(W));
      refused(heldNarrow, '55000', 'holds_items');
      expect(!heldNarrow.ok && heldNarrow.msg).toMatch(/: 3 item\(s\) have their home/);
      refused(await run(await asLogin(L.mem), archive(W)), '42501', 'archive_forbidden');
      refused(await run(await asLogin(L.modX), archive(W)), 'P0002', 'not_found');
      refused(await run(await asLogin(L.noUsers), archive(W)), 'P0002', 'not_found');
      refused(await run({}, archive(W)), '42501', 'no_acting_login');
      refused(await run(await asLogin(L.adm), archive(adminWs)), '55000', 'archive_admin');
      refused(await run(await asLogin(L.adm), archive(ARCH)), '55000', 'archived');
      refused(await run(await asLogin(L.mod), archive(ARCH)), 'P0002', 'not_found');
      // X is the home of SHARED and HOMED: its Moderator may not either.
      refused(await run(await asLogin(L.modX), archive(X)), '55000', 'holds_items');
    });
  }

  it('no acting login: each definer refuses every actor, the SQL allowlist`s two included', async () => {
    const actors = [
      '',
      'system:ws-clear-ticks',
      'system:boot:migrate-workspaces',
      'system:workspace-write',
      'system:admin-area',
      'system:test',
      'system:operator:repair',
      `login:rw:${L.adm}`,
    ];
    const allowed: string[] = [];
    for (const actor of actors) {
      for (const [name, q] of [
        ['about', about(W, { name: 'x' })],
        ['contact', contact(W, null)],
        ['landing', landing(W, null)],
        ['archive', archive(W)],
      ] as const) {
        const out = await run({ 'mantle.actor': actor, 'mantle.write_mode': 'rw' }, q);
        if (out.ok || out.state !== '42501' || !/no acting login/.test(out.msg)) {
          allowed.push(`${actor} ${name}: ${JSON.stringify(out)}`);
        }
      }
    }
    expect(allowed).toEqual([]);
    // Read-only and another brain: refused before anything.
    const ro = { ...(await asLogin(L.mod)), 'mantle.write_mode': 'ro' };
    refused(await run(ro, about(W, { name: 'x' })), '42501', 'read_only');
    refused(
      await run(
        await asLogin(L.mod),
        (tx) => tx`select mantle_ws_set_landing(${randomUUID()}::uuid, ${W}::uuid, null::uuid)`,
      ),
      '42501',
      'not_brain',
    );
  });

  it('catalog: the definers have a fixed search_path and no PUBLIC; the write role runs three, the runtime role the archive; the app rule no role', async () => {
    const rows = await sql<
      { fn: string; definer: boolean; pub: boolean; path: string[]; may: string[] }[]
    >`
      select f.fn, p.prosecdef as definer, has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             coalesce(p.proconfig, '{}') as path,
             array(select r.rolname::text from pg_roles r
                    where not r.rolsuper and r.rolname <> ${OWNER_ROLE}
                      and has_function_privilege(r.oid, p.oid, 'EXECUTE') order by 1) as may
        from unnest(${ADDED}::text[]) f(fn) join pg_proc p on p.oid = to_regprocedure(f.fn)`;
    expect(rows.map((r) => r.fn).sort()).toEqual([...ADDED].sort());
    for (const r of rows) {
      expect(r.pub, r.fn).toBe(false);
      expect(r.path, r.fn).toContain('search_path=public, pg_temp');
      const helper = r.fn.includes('mantle_ws_app_held');
      expect(r.definer, r.fn).toBe(!helper);
      const wanted = helper
        ? []
        : r.fn.includes('mantle_ws_archive')
          ? [RUNTIME_ROLE]
          : [viewerRoleName('write'), RUNTIME_ROLE];
      // A role the scratch database lacks holds nothing; no other role may run
      // it (the runtime role runs what the write role runs, by its membership).
      for (const role of r.may) expect(wanted, `${r.fn} ${role}`).toContain(role);
    }
  });
});

describe.skipIf(!URL)('a database just before 0309 runs 0309 and only it', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabaseBefore>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const all = readMigrationFiles({ migrationsFolder: DIR });
  const present = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from unnest(${ADDED}::text[]) f(fn)
         where to_regprocedure(f.fn) is not null`
    )[0]!.n;
  const ledger = async () =>
    (
      await sql<{ n: number }[]>`
        select count(*)::int as n from "drizzle"."__drizzle_migrations"
         where created_at = ${journal[at]!.when}`
    )[0]!.n;
  const apply = async () => {
    const out = { lines: [] as string[], warnings: [] as string[] };
    const n = await applyJournal(sql, all.slice(0, at + 1), journal.slice(0, at + 1), {
      log: (l) => out.lines.push(l),
      warn: (l) => out.warnings.push(l),
    });
    expect(out.warnings).toEqual([]);
    return n;
  };

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

  it('the runner applies 0309 and only it', async () => {
    expect(await present()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(ADDED.length);
  }, 120_000);

  it('rollback: the revert drops 0309`s functions and takes it off the ledger; a roll forward applies it again', async () => {
    expect(await ledger()).toBe(1);
    await sql.begin(async (tx) => {
      for (const st of revertStatements()) await tx.unsafe(st);
    });
    expect(await present()).toBe(0);
    expect(await ledger()).toBe(0);
    expect(await apply()).toBe(1);
    expect(await present()).toBe(ADDED.length);
  }, 120_000);
});
