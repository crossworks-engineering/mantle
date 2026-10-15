/**
 * The runtime role is not the owner (workspaces arch A9, plan v2 4.2), on a
 * real, migrated Postgres. The exit: logged in as mantle_runtime, the app
 * cannot disable a trigger, cannot alter a table, cannot set
 * session_replication_role and cannot change mantle.actor_check (not the
 * database setting, not through the switch functions, and a session that
 * sets its own value lower does not lower the box). Also: it cannot read
 * the heads key or sign a held list, cannot make anything in public, cannot
 * act as mantle_owner, and still does what the system pool does (reads and
 * writes past the row rules, the derivation guards' owner test, SET ROLE to
 * the write role for the checked rerun). The viewer roles cannot run the
 * setter functions. Every table of public and auth is mantle_owner's, and
 * the migrator's steps are idempotent.
 *
 * A database of its own (createMigratedScratchDatabase, which runs the
 * migrator's steps as migrate.ts does): it changes the box modes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/runtime-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';
import { afterMigrations } from './migrator-steps';
import {
  DB_ROLE_SQL,
  OWNER_ROLE,
  RUNTIME_DENIED_FUNCTIONS,
  RUNTIME_ROLE,
  SYSTEM_ROLE,
  dbRoleMode,
  ensureRuntimeRoles,
  ownTables,
  runtimeDatabaseUrl,
  runtimeDeniedTables,
  runtimeRolePassword,
  type DbRoleRow,
} from './runtime-role';
import { viewerDatabaseUrl, viewerRolePassword } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const DENIED = '42501';

/** DDL in a function body: what a SECURITY DEFINER function the runtime
 *  role may run must not do on its behalf. */
const DDL_IN_BODY =
  /\b(alter\s+(table|database|policy|role|function|system|default)|(create|drop)\s+(or\s+replace\s+)?(trigger|policy|table|index|function|role|schema|view)|(disable|enable)\s+trigger|session_replication_role|set\s+(local\s+)?role|(grant|revoke)\s+(select|insert|update|delete|all|execute|usage|connect|create|truncate|references|trigger)\b[^;]*\bon)\b/i;

describe.skipIf(!URL)('the runtime role is not the owner (arch A9)', () => {
  type Scratch = Awaited<ReturnType<typeof createMigratedScratchDatabase>>;
  let scratch: Scratch;
  let admin: ReturnType<typeof postgres>;
  let rt: ReturnType<typeof postgres>;
  let brain: string;

  /** A statement as the runtime role in a transaction of its own, rolled
   *  back: what it answers, or its error. */
  const asRuntime = async (stmt: string) =>
    rt
      .begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
        const rows = await tx.unsafe(stmt);
        throw Object.assign(new Error('rollback'), { rows });
      })
      .catch((err: { code?: string; rows?: unknown[] }) => {
        if (err.rows) return err.rows;
        throw err;
      });

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    admin = postgres(scratch.url, { max: 1, onnotice: () => {} });
    // The cluster roles with a login (the global setup makes them too).
    expect(await ensureRuntimeRoles(admin, KEY)).toBe('ok');
    rt = postgres(runtimeDatabaseUrl(scratch.url, runtimeRolePassword(KEY)), {
      max: 1,
      onnotice: () => {},
    });
    brain = await ensureTestAnchor(admin);
  }, 180_000);

  afterAll(async () => {
    await rt?.end();
    await admin?.end();
    await scratch?.drop();
  }, 60_000);

  it('logs in as mantle_runtime: no superuser, BYPASSRLS, owns nothing', async () => {
    const [row] = (await rt.unsafe(DB_ROLE_SQL)) as unknown as DbRoleRow[];
    expect(row).toEqual({ user: RUNTIME_ROLE, superuser: false, bypassrls: true, owns: 0 });
    expect(dbRoleMode(row!)).toBe('runtime');
    const [attrs] = await admin<{ cr: boolean; cd: boolean; repl: boolean }[]>`
      select rolcreaterole as cr, rolcreatedb as cd, rolreplication as repl
        from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(attrs).toEqual({ cr: false, cd: false, repl: false });
  });

  it('cannot disable a trigger or a row rule', async () => {
    for (const stmt of [
      'ALTER TABLE public.nodes DISABLE TRIGGER mantle_actor_check',
      'ALTER TABLE public.nodes DISABLE TRIGGER ALL',
      'ALTER TABLE public.nodes DISABLE TRIGGER USER',
      'ALTER TABLE public.nodes DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.nodes NO FORCE ROW LEVEL SECURITY',
      'DROP POLICY nodes_user_read ON public.nodes',
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
  });

  it('cannot alter, drop or truncate a table', async () => {
    for (const stmt of [
      'ALTER TABLE public.nodes ADD COLUMN a9_probe int',
      'ALTER TABLE auth.users ALTER COLUMN role DROP NOT NULL',
      'ALTER TABLE public.nodes OWNER TO mantle_runtime',
      'DROP TABLE public.actor_check_misses',
      'TRUNCATE public.actor_check_misses',
      'CREATE INDEX a9_probe ON public.nodes (title)',
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
  });

  it('cannot set session_replication_role (which skips every trigger)', async () => {
    await expect(asRuntime(`SET session_replication_role = replica`)).rejects.toMatchObject({
      code: DENIED,
    });
    await expect(
      asRuntime(`select set_config('session_replication_role', 'replica', true)`),
    ).rejects.toMatchObject({ code: DENIED });
  });

  it('cannot change mantle.actor_check, nor the edit check', async () => {
    const [{ name }] = await admin<{ name: string }[]>`select current_database() as name`;
    for (const stmt of [
      `ALTER DATABASE "${name}" SET mantle.actor_check = 'off'`,
      `ALTER DATABASE "${name}" RESET mantle.actor_check`,
      `ALTER ROLE mantle_runtime SET mantle.actor_check = 'off'`,
      `select mantle_set_actor_check('off')`,
      `select mantle_set_edit_check('off')`,
      `select mantle_set_check('actor_check', 'off', 1)`,
      `select mantle_actor_check_triggers(false, 1)`,
      `select mantle_edit_check_triggers(false, 1)`,
      `select mantle_switch_triggers(ARRAY['mantle_actor_check'], false, 1)`,
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
    // The box is warn (the superuser's switch): a session that sets its own
    // value to off reads warn all the same.
    await admin`select mantle_set_actor_check('warn')`;
    try {
      const rows = await asRuntime(
        `select set_config('mantle.actor_check', 'off', true), mantle_actor_check_mode() as m`,
      );
      expect((rows[0] as { m: string }).m).toBe('warn');
    } finally {
      await admin`select mantle_set_actor_check('off')`;
    }
  });

  it('cannot read the heads key, sign a held list or bypass the heads check', async () => {
    for (const stmt of [
      'select * from public.mantle_heads_key',
      `select mantle_heads_mac('held:x')`,
      `select mantle_heads_sig('{}', '{}')`,
      `select mantle_heads_set(ARRAY[]::uuid[], ARRAY[]::uuid[])`,
      `select mantle_heads_bypass('a9-probe')`,
      'select * from public.mantle_moved_nodes',
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
    for (const t of runtimeDeniedTables()) {
      const [r] = await admin<{ any: boolean }[]>`
        select has_table_privilege(${RUNTIME_ROLE}, ${t}, 'SELECT')
            or has_table_privilege(${RUNTIME_ROLE}, ${t}, 'INSERT')
            or has_table_privilege(${RUNTIME_ROLE}, ${t}, 'UPDATE')
            or has_table_privilege(${RUNTIME_ROLE}, ${t}, 'DELETE') as any`;
      expect(r?.any, t).toBe(false);
    }
  });

  it('cannot make anything in public, mark a function LEAKPROOF or act as the owner', async () => {
    for (const stmt of [
      'CREATE TABLE public.a9_probe (i int)',
      `CREATE FUNCTION public.mantle_acl_internal() RETURNS boolean LANGUAGE sql AS 'select true'`,
      `CREATE OR REPLACE FUNCTION public.mantle_acl_internal() RETURNS boolean LANGUAGE sql AS 'select true'`,
      'ALTER FUNCTION pg_catalog.ts_match_vq(tsvector, tsquery) NOT LEAKPROOF',
      'CREATE SCHEMA a9_probe',
      `SET ROLE ${OWNER_ROLE}`,
      'SET ROLE postgres',
      'CREATE ROLE a9_probe',
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
  });

  it('still does what the system pool does', async () => {
    // Reads past the row rules, and writes (with an actor), as the
    // superuser did.
    const id = randomUUID();
    await rt.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await tx`insert into nodes (id, owner_id, type, title, path, data, tags)
                values (${id}, ${brain}, 'note', 'a9 probe', 'notes'::ltree, '{}'::jsonb, '{}')`;
      await tx`update nodes set title = 'a9 probe 2' where id = ${id}`;
      const [n] = await tx<{ n: number }[]>`select count(*)::int as n from nodes where id = ${id}`;
      expect(n?.n).toBe(1);
      await tx`delete from nodes where id = ${id}`;
    });
    // The derivation guards' owner test (0241) says yes, as for the
    // superuser; the write role, once SET, says no.
    const owner = await asRuntime('select mantle_owner_role() as ok');
    expect((owner[0] as { ok: boolean }).ok).toBe(true);
    const writer = await rt.begin(async (tx) => {
      await tx.unsafe('set local role mantle_write_user');
      const [r] = await tx<{ u: string; ok: boolean }[]>`
        select current_user as u, mantle_owner_role() as ok`;
      await tx.unsafe('set local role mantle_gap_writer');
      const [g] = await tx<{ u: string }[]>`select current_user as u`;
      return [r?.u, r?.ok, g?.u];
    });
    expect(writer).toEqual(['mantle_write_user', false, 'mantle_gap_writer']);
    // Not a direct member of the write role: 0277 and 0278 count only that,
    // so the system pool is still not "the write role's login".
    const [direct] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where r.rolname = 'mantle_write_user' and u.rolname = ${RUNTIME_ROLE}`;
    expect(direct?.n).toBe(0);
  });

  it('the viewer roles cannot run the setter functions', async () => {
    for (const role of ['mantle_view_user', 'mantle_write_user', 'mantle_gap_writer', 'public']) {
      for (const fn of Object.keys(RUNTIME_DENIED_FUNCTIONS)) {
        const [r] = await admin<{ ok: boolean | null }[]>`
          select case when to_regprocedure(${fn}) is null then null
                      else has_function_privilege(${role}, to_regprocedure(${fn}), 'EXECUTE') end as ok`;
        expect(r?.ok, `${role} ${fn}`).not.toBe(true);
      }
    }
    const viewer = postgres(
      viewerDatabaseUrl(scratch.url, 'user', viewerRolePassword(KEY, 'user')),
      {
        max: 1,
        onnotice: () => {},
      },
    );
    try {
      for (const stmt of [
        `select mantle_set_actor('system:x', 'rw')`,
        `select mantle_operator_actor('probe')`,
        `select mantle_set_actor_check('off')`,
      ]) {
        await expect(viewer.unsafe(stmt), stmt).rejects.toMatchObject({ code: DENIED });
      }
    } finally {
      await viewer.end();
    }
  });

  it('no SECURITY DEFINER function the runtime role may run has DDL in its body', async () => {
    const fns = await admin<{ fn: string; src: string }[]>`
      select p.oid::regprocedure::text as fn, p.prosrc as src
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'auth') and p.prosecdef
         and has_function_privilege(${RUNTIME_ROLE}, p.oid, 'EXECUTE')`;
    expect(fns.length).toBeGreaterThan(20);
    const ddl = fns.filter((f) => DDL_IN_BODY.test(f.src)).map((f) => f.fn);
    expect(ddl).toEqual([]);
  });

  it('every table of public and auth is mantle_owner’s, the marker mantle_system’s', async () => {
    const stray = await admin<{ rel: string; owner: string }[]>`
      select c.oid::regclass::text as rel, pg_get_userbyid(c.relowner) as owner
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p', 'S')
         and pg_get_userbyid(c.relowner) <> ${OWNER_ROLE}`;
    expect(stray).toEqual([]);
    const [marker] = await admin<{ owner: string }[]>`
      select pg_get_userbyid(proowner) as owner from pg_proc
       where oid = 'public.mantle_acl_internal()'::regprocedure`;
    expect(marker?.owner).toBe(SYSTEM_ROLE);
  });

  it('the migrator steps are idempotent, and a hand grant is taken back', async () => {
    await admin.unsafe(`GRANT ${OWNER_ROLE} TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`GRANT TRUNCATE ON public.nodes TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`ALTER TABLE public.actor_check_misses OWNER TO postgres`);
    expect(await ensureRuntimeRoles(admin, KEY)).toBe('ok');
    await afterMigrations(admin, 'ok', { info: () => {}, warn: () => {} });
    const [m] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where r.rolname = ${OWNER_ROLE} and u.rolname = ${RUNTIME_ROLE}`;
    expect(m?.n).toBe(0);
    const [t] = await admin<{ ok: boolean }[]>`
      select has_table_privilege(${RUNTIME_ROLE}, 'public.nodes', 'TRUNCATE') as ok`;
    expect(t?.ok).toBe(false);
    expect((await ownTables(admin)).owned).toEqual([]);
  });
});
