/**
 * The runtime role reads the four workspace tables and never writes them
 * (plan v3.2 S2c; access-matrix.ts `runtime: 'read'`), on a database of its
 * own that the workspaces switch made live, with a connection logged in as
 * mantle_runtime:
 *
 *  - the live grants equal the matrix: SELECT on workspaces, workspace_users,
 *    workspace_events and workspace_resources, and no INSERT, UPDATE,
 *    DELETE or TRUNCATE, for the runtime role and for every role it may
 *    SET ROLE to;
 *  - a raw INSERT, UPDATE and DELETE into each, and a row lock on each
 *    (FOR UPDATE and FOR SHARE need UPDATE), are refused (42501); a SELECT
 *    reads;
 *  - every workspace definer still writes when the runtime role calls it:
 *    for an Admin user and for a Moderator (their scope set as the app
 *    sets it), and as the SQL allowlist's system work (the boot attach,
 *    the clear-ticks command); the onboarding attach in the login's scope;
 *  - the live catalog (the fnscan of eslint-rules/rights-counts.mjs on
 *    pg_proc, not on migration text): no function the runtime role or any
 *    other app role may EXECUTE, and no trigger function on any table,
 *    writes or row-locks the four tables unless it is SECURITY DEFINER,
 *    directly or through an invoker function it calls.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/ws-runtime-read.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedScratchDatabase,
  ensureTestAnchor,
  runWorkspacesSwitch,
} from './test-support';
import {
  OWNER_ROLE,
  RUNTIME_ROLE,
  ensureRuntimeRoles,
  runtimeDatabaseUrl,
  runtimeReadOnlyTables,
  runtimeRolePassword,
} from './runtime-role';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const DENIED = '42501';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TABLES = [
  'public.workspaces',
  'public.workspace_users',
  'public.workspace_events',
  'public.workspace_resources',
];

/** A row lock on one of the four tables in a function body. */
const ROW_LOCK =
  /\bfrom\s+(?:"?public"?\s*\.\s*)?"?(?:workspaces|workspace_users|workspace_events|workspace_resources)"?[\s\S]{0,400}?\bfor\s+(?:update|share|no\s+key\s+update|key\s+share)\b/i;

class Rollback extends Error {}
type Out = { ok: true; v: unknown } | { ok: false; state: string; msg: string };

describe.skipIf(!URL)(
  'the runtime role reads the workspace tables, never writes them (S2c)',
  () => {
    let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
    let admin: ReturnType<typeof postgres>;
    let rt: ReturnType<typeof postgres>;
    let m: typeof import('./index');
    let brain = '';
    let adminWs = '';
    const tag = `wrr${randomUUID().slice(0, 8)}`;
    const W = randomUUID(); // a normal workspace: mod and mem its Moderators
    const L = { adm: randomUUID(), mod: randomUUID(), mem: randomUUID(), target: randomUUID() };
    const CONN = `${tag}-conn`;
    const AG = randomUUID(); // a chat assistant of no workspace
    const PERSONA = randomUUID(); // an admin responder: what the attach puts on Admin

    /** `q` as the runtime role in a transaction rolled back after it, with
     *  `settings` set transaction-local first: its result, or its error. */
    const asRt = async (
      settings: Record<string, string>,
      q: (tx: postgres.TransactionSql) => Promise<unknown>,
    ): Promise<Out> => {
      let out: Out = { ok: false, state: 'none', msg: 'not run' };
      await rt
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
    /** The settings the app sets for `login`'s scope (writeRoleSettingsSql). */
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
    const asActor = (actor: string): Record<string, string> => ({
      'mantle.actor': actor,
      'mantle.write_mode': 'rw',
    });
    const ok = (out: Out) => {
      expect(out.ok, JSON.stringify(out)).toBe(true);
      return out.ok ? out.v : undefined;
    };
    /** The actions of the events `q` wrote in `ws`, sorted. */
    const eventsOf =
      (ws: string, q: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      async (tx: postgres.TransactionSql) => {
        const before = (
          await tx<
            { id: string }[]
          >`select id::text from workspace_events where workspace_id = ${ws}`
        ).map((r) => r.id);
        await q(tx);
        return (
          await tx<{ action: string }[]>`
          select action from workspace_events
           where workspace_id = ${ws} and id::text <> all (${before}::text[])
           order by action`
        ).map((r) => r.action);
      };

    beforeAll(async () => {
      scratch = await createMigratedScratchDatabase(URL!);
      admin = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
      // The cluster roles with a login, then the one runtime connection at
      // once (another file's migrate may set NOLOGIN again; a connection
      // made stays).
      expect(await ensureRuntimeRoles(admin, KEY, { login: true })).toBe('ok');
      rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      const [me] = await rt<{ u: string }[]>`select current_user::text as u`;
      expect(me!.u).toBe(RUNTIME_ROLE);
      brain = await ensureTestAnchor(admin);
      process.env.DATABASE_URL = scratch.url;
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      const email = (k: string) => `${tag}-${k}@example.invalid`;
      for (const [k, id] of Object.entries(L)) {
        await admin`insert into auth.users (id, email, password_hash, role, display_name)
                  values (${id}, ${email(k)}, 'x', ${k === 'adm' ? 'admin' : 'member'}, ${k})`;
      }
      await admin`insert into spaces (id, kind, login_id) values (${brain}, 'brain', ${brain})
                on conflict (id) do nothing`;
      await runWorkspacesSwitch(scratch.url);
      m = await import('./index');
      const [a] = await admin<{ id: string }[]>`
      select id::text from workspaces where owner_id = ${brain} and is_admin`;
      adminWs = a!.id;
      // The fixtures write the four tables as the superuser.
      await admin`insert into tool_groups (owner_id, slug, name, tool_slugs, audience, enabled, integration)
      values (${brain}, ${CONN}, 'Connector', ARRAY['c_do']::text[], 'admin', true,
              ${admin.json({ service: CONN, mcp: { url: 'https://mcp.example.invalid/mcp' } })})`;
      await admin`insert into agents (id, owner_id, slug, name, model, system_prompt, role, audience, priority)
      values (${AG}, ${brain}, ${`${tag}-a`}, 'A', 'm', 'p', 'responder', 'team', 0),
             (${PERSONA}, ${brain}, ${`${tag}-p`}, 'P', 'm', 'p', 'responder', 'admin', 100)`;
      await admin`insert into workspaces (id, owner_id, name) values (${W}, ${brain}, ${`${tag} W`})`;
      await admin`insert into workspace_users (workspace_id, login_id, moderator) values
      (${W}, ${L.mod}, true), (${W}, ${L.mem}, true)`;
      // Admin with no assistant and no removal event: what the attach fills.
      await admin`delete from workspace_resources where workspace_id = ${adminWs} and type = 'assistant'`;
      await admin`delete from workspace_events where workspace_id = ${adminWs}
                 and action = 'resource.remove' and subject ->> 'kind' = 'assistant'`;
    }, 300_000);

    afterAll(async () => {
      await m?.closeDb();
      await rt?.end();
      await admin?.end();
      await scratch?.drop();
    });

    it('the matrix marks exactly the four workspace tables runtime read', () => {
      expect(runtimeReadOnlyTables().sort()).toEqual([...TABLES].sort());
    });

    it('live grants: SELECT and no write on the four, for the runtime role and every role it may become', async () => {
      const roles = (
        await admin<{ r: string }[]>`
        select r.rolname::text as r from pg_roles r
         where r.rolname = ${RUNTIME_ROLE}
            or (pg_has_role(${RUNTIME_ROLE}, r.oid, 'SET') and r.rolname <> ${OWNER_ROLE})
         order by 1`
      ).map((x) => x.r);
      expect(roles).toContain(RUNTIME_ROLE);
      for (const t of TABLES) {
        for (const role of roles) {
          const [g] = await admin<
            { sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]
          >`
          select has_table_privilege(${role}, ${t}, 'SELECT') as sel,
                 has_table_privilege(${role}, ${t}, 'INSERT') as ins,
                 has_table_privilege(${role}, ${t}, 'UPDATE') as upd,
                 has_table_privilege(${role}, ${t}, 'DELETE') as del,
                 has_table_privilege(${role}, ${t}, 'TRUNCATE') as trunc`;
          expect(
            { ins: g!.ins, upd: g!.upd, del: g!.del, trunc: g!.trunc },
            `${role} on ${t}`,
          ).toEqual({ ins: false, upd: false, del: false, trunc: false });
          if (role === RUNTIME_ROLE) expect(g!.sel, t).toBe(true);
        }
      }
    });

    it('a raw INSERT, UPDATE, DELETE or row lock on each is refused (42501); a SELECT reads', async () => {
      const sys = asActor('system:test');
      const writes: Record<string, string[]> = {
        'public.workspaces': [
          `insert into workspaces (owner_id, name) values ('${brain}', 's2c probe')`,
          `update workspaces set name = name where id = '${W}'`,
          `delete from workspaces where id = '${W}'`,
          `select id from workspaces where id = '${W}' for update`,
        ],
        'public.workspace_users': [
          `insert into workspace_users (workspace_id, login_id, moderator) values ('${W}', '${L.target}', false)`,
          `update workspace_users set moderator = false where workspace_id = '${W}'`,
          `delete from workspace_users where workspace_id = '${W}'`,
          `select login_id from workspace_users where workspace_id = '${W}' for share`,
        ],
        'public.workspace_events': [
          `insert into workspace_events (workspace_id, action, subject) values ('${W}', 'user.add', '{}')`,
          `update workspace_events set action = action where workspace_id = '${W}'`,
          `delete from workspace_events where workspace_id = '${W}'`,
          `select id from workspace_events where workspace_id = '${W}' for update`,
        ],
        'public.workspace_resources': [
          `insert into workspace_resources (workspace_id, type, ref_id) values ('${W}', 'connector', '${CONN}')`,
          `update workspace_resources set write = false where workspace_id = '${W}'`,
          `delete from workspace_resources where workspace_id = '${W}'`,
          `select id from workspace_resources where workspace_id = '${W}' for update`,
        ],
      };
      for (const [t, stmts] of Object.entries(writes)) {
        for (const stmt of stmts) {
          const out = await asRt(sys, (tx) => tx.unsafe(stmt));
          expect(out.ok, stmt).toBe(false);
          if (!out.ok) expect(out.state, `${stmt}: ${out.msg}`).toBe(DENIED);
        }
        const read = await asRt(sys, (tx) => tx.unsafe(`select count(*)::int as n from ${t}`));
        expect(read.ok, t).toBe(true);
      }
      // Every role the runtime role may SET ROLE to is refused too.
      const become = (
        await admin<{ r: string }[]>`
        select r.rolname::text as r from pg_roles r
         where pg_has_role(${RUNTIME_ROLE}, r.oid, 'SET') and r.rolname <> ${RUNTIME_ROLE}
           and r.rolname <> ${OWNER_ROLE} order by 1`
      ).map((x) => x.r);
      for (const role of become) {
        const out = await asRt(sys, async (tx) => {
          await tx.unsafe(`set local role "${role}"`);
          return tx.unsafe(writes['public.workspace_users']![0]!);
        });
        expect(out.ok, role).toBe(false);
        if (!out.ok) expect(out.state, `${role}: ${out.msg}`).toBe(DENIED);
      }
    });

    it('every workspace definer writes when the runtime role calls it: an Admin user, a Moderator, system work', async () => {
      // An Admin user: create, about, contact and landing (cleared: a contact or
      // an app node is S2b's fixture), users, resources, an event, archive.
      const made = ok(
        await asRt(await asLogin(L.adm), async (tx) => {
          const [c] = await tx<{ id: string }[]>`
          select mantle_ws_create(${brain}::uuid, ${L.adm}::uuid, ${`${tag} new`}, 'd')::text as id`;
          const ws = c!.id;
          const ev = await eventsOf(ws, async (t) => {
            await t`select mantle_ws_update_about(${brain}::uuid, ${ws}::uuid, ${t.json({ name: `${tag} renamed` })})`;
            await t`select mantle_ws_set_contact(${brain}::uuid, ${ws}::uuid, null)`;
            await t`select mantle_ws_set_landing(${brain}::uuid, ${ws}::uuid, null)`;
            await t`select mantle_ws_add_user(${brain}::uuid, ${ws}::uuid, ${L.target}::uuid, false)`;
            await t`select mantle_ws_set_moderator(${brain}::uuid, ${ws}::uuid, ${L.target}::uuid, true, null)`;
            await t`select mantle_ws_set_moderator(${brain}::uuid, ${ws}::uuid, ${L.target}::uuid, false, null)`;
            await t`select mantle_ws_resource_add(${brain}::uuid, ${ws}::uuid, 'connector', ${CONN}, false)`;
            await t`select mantle_ws_resource_set_write(${brain}::uuid, ${ws}::uuid, 'connector', ${CONN}, true)`;
            await t`select mantle_ws_resource_add(${brain}::uuid, ${ws}::uuid, 'assistant', ${AG}, false)`;
            await t`select mantle_ws_set_assistant(${brain}::uuid, ${ws}::uuid, null)`;
            await t`select mantle_ws_resource_remove(${brain}::uuid, ${ws}::uuid, 'connector', ${CONN})`;
            await t`select mantle_ws_remove_user(${brain}::uuid, ${ws}::uuid, ${L.target}::uuid)`;
            await t`select mantle_workspace_event(${adminWs}::uuid, ${L.adm}::uuid, 'grant.add', '{}'::jsonb)`;
            await t`select mantle_ws_archive(${brain}::uuid, ${ws}::uuid)`;
          })(tx);
          const [row] = await tx<{ name: string; archived: boolean; users: number }[]>`
          select w.name, w.archived_at is not null as archived,
                 (select count(*)::int from workspace_users u where u.workspace_id = w.id) as users
            from workspaces w where w.id = ${ws}`;
          return { row, ev };
        }),
      ) as { row: { name: string; archived: boolean; users: number }; ev: string[] };
      expect({ row: made.row, ev: made.ev }).toEqual({
        // Sorted. The cleared contact and landing were already clear: no event.
        ev: [
          'resource.add',
          'resource.add',
          'resource.remove',
          'resource.remove',
          'resource.update',
          'user.add',
          'user.moderator',
          'user.moderator',
          'user.remove',
          'workspace.archive',
          'workspace.update',
        ],
        row: { name: `${tag} renamed`, archived: true, users: 1 },
      });
      // A Moderator (a member): a user added and removed.
      expect(
        ok(
          await asRt(
            await asLogin(L.mod),
            eventsOf(W, async (t) => {
              await t`select mantle_ws_add_user(${brain}::uuid, ${W}::uuid, ${L.target}::uuid, false)`;
              await t`select mantle_ws_remove_user(${brain}::uuid, ${W}::uuid, ${L.target}::uuid)`;
            }),
          ),
        ),
      ).toEqual(['user.add', 'user.remove']);
      // A login's own private workspace.
      const priv = ok(
        await asRt(await asLogin(L.target), async (tx) => {
          const [p] = await tx<{ id: string | null }[]>`
          select mantle_ws_private_workspace(${L.target}::uuid)::text as id`;
          return p!.id;
        }),
      );
      expect(priv).toMatch(/^[0-9a-f-]{36}$/);
      // System work: the clear-ticks command clears a member tick.
      expect(
        ok(
          await asRt(asActor('system:ws-clear-ticks'), async (tx) => {
            await tx`select mantle_ws_set_moderator(${brain}::uuid, ${W}::uuid, ${L.mem}::uuid, false, 'ws:clear-member-ticks')`;
            const [r] = await tx<{ moderator: boolean }[]>`
            select moderator from workspace_users where workspace_id = ${W} and login_id = ${L.mem}`;
            return r!.moderator;
          }),
        ),
      ).toBe(false);
    });

    it('the boot attach (system work) and the onboarding attach (the login`s scope) put the persona on Admin', async () => {
      const assistantOfAdmin = async (tx: postgres.TransactionSql) =>
        (
          await tx<{ ref: string }[]>`
          select ref_id::text as ref from workspace_resources
           where workspace_id = ${adminWs} and type = 'assistant'`
        ).map((r) => r.ref);
      for (const settings of [asActor('system:boot:migrate-workspaces'), await asLogin(L.adm)]) {
        expect(
          ok(
            await asRt(settings, async (tx) => {
              const [r] = await tx<{ n: number }[]>`select mantle_ws_attach_assistants() as n`;
              return { n: r!.n, on: await assistantOfAdmin(tx) };
            }),
          ),
          settings['mantle.actor'],
        ).toEqual({ n: 1, on: [PERSONA] });
      }
    });

    it('catalog: no function an app role may run, and no trigger function, writes or locks the four tables unless SECURITY DEFINER', async () => {
      // The scoreboard's own test of a body (rights-catalog.db.test.ts proves
      // it agrees with the migrations), on the live catalog.
      const counts = (await import(join(ROOT, 'eslint-rules/rights-counts.mjs'))) as {
        writesWorkspaceTable(body: string): boolean;
      };
      const fns = await admin<
        { oid: number; sig: string; name: string; src: string; definer: boolean }[]
      >`
      select p.oid::int as oid, p.oid::regprocedure::text as sig, p.proname::text as name,
             coalesce(p.prosrc, '') as src, p.prosecdef as definer
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname not in ('pg_catalog', 'information_schema')
         and n.nspname not like 'pg\\_%'
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                            and d.deptype = 'e')`;
      // A write, or a row lock (FOR UPDATE or FOR SHARE needs UPDATE too).
      const touches = (src: string) => counts.writesWorkspaceTable(src) || ROW_LOCK.test(src);
      // Invoker writers, and every invoker function that calls one (by name):
      // a call runs as its caller, so the caller's rights decide the write.
      const invoker = new Set(fns.filter((f) => !f.definer && touches(f.src)).map((f) => f.oid));
      for (let grew = true; grew;) {
        grew = false;
        const names = fns.filter((f) => invoker.has(f.oid)).map((f) => f.name);
        for (const f of fns) {
          if (f.definer || invoker.has(f.oid)) continue;
          if (names.some((n) => new RegExp(`\\b${n}"?\\s*\\(`, 'i').test(f.src))) {
            invoker.add(f.oid);
            grew = true;
          }
        }
      }
      const reach = fns.filter((f) => invoker.has(f.oid));
      // Today: two private helpers that only definers call (the body that
      // puts an assistant on a workspace, and the one that locks the
      // workspace row and reads the acting login's seat). A new one passes
      // only if no app role may run it.
      expect(reach.map((f) => f.name).sort()).toEqual([
        'mantle_ws_put_assistant',
        'mantle_ws_user_seat',
      ]);
      for (const f of reach) {
        const runners = await admin<{ r: string }[]>`
        select r.rolname::text as r from pg_roles r
         where not r.rolsuper and r.rolname <> ${OWNER_ROLE} and r.rolname not like 'pg\\_%'
           and has_function_privilege(r.oid, ${f.oid}::oid, 'EXECUTE')`;
        expect(
          runners.map((x) => x.r),
          `${f.sig}: an invoker that writes or locks a workspace table`,
        ).toEqual([]);
        const [trg] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_trigger where tgfoid = ${f.oid}::oid`;
        expect(trg!.n, `${f.sig}: a trigger runs it`).toBe(0);
      }
      // No trigger on any table runs an invoker function that writes or
      // locks them.
      const trgs = await admin<{ fn: string; definer: boolean; src: string }[]>`
      select distinct p.oid::regprocedure::text as fn, p.prosecdef as definer,
             coalesce(p.prosrc, '') as src
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal`;
      const bad = trgs.filter((t) => !t.definer && touches(t.src)).map((t) => t.fn);
      expect(bad).toEqual([]);
    });
  },
);
