/**
 * The runtime role is not the owner (workspaces arch A9, plan v2 4.2), on a
 * real, migrated Postgres. The exit: logged in as mantle_runtime, the app
 * cannot disable a trigger, cannot alter a table, cannot set
 * session_replication_role and cannot change mantle.actor_check (not the
 * database setting, not through the switch functions, and a session that
 * sets its own value lower does not lower the box). Also: it cannot read
 * the heads key or sign a held list, cannot make anything in public, cannot
 * act as mantle_owner nor touch the marker mantle_owner_role() reads, runs
 * only the functions of its allowlist (no workspaces switch), and still
 * does what the system pool does (reads and writes past the row rules, the
 * derivation guards' owner test, SET ROLE to the write role for the checked
 * rerun). The viewer roles cannot run the setter functions. Every table of
 * public and auth is mantle_owner's, the migrator's steps are idempotent,
 * and migrate makes a missing or changed marker again.
 *
 * A database of its own (createMigratedScratchDatabase, which runs the
 * migrator's steps as migrate.ts does): it changes the box modes.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/runtime-role.db.test.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createMigratedScratchDatabase, ensureTestAnchor } from './test-support';
import { afterMigrations } from './migrator-steps';
import {
  ACL_MARKER_FUNCTION,
  APP_SCHEMAS,
  DB_ROLE_SQL,
  NARROW_DENIED_FUNCTIONS,
  NARROW_ROLE,
  OWNER_ROLE,
  OWNER_ROLE_FUNCTION,
  RUNTIME_DENIED_FUNCTIONS,
  RUNTIME_LOCK_SQL,
  RUNTIME_ROLE,
  RUNTIME_SYSTEM_FUNCTIONS,
  SYSTEM_ROLE,
  dbRoleMode,
  ensureRuntimeRoles,
  ownTables,
  runtimeDatabaseUrl,
  runtimeDeniedTables,
  runtimeRolePassword,
  takeBackMemberships,
  type DbRoleRow,
} from './runtime-role';
import { viewerDatabaseUrl, viewerRoleName, viewerRolePassword } from './viewer';
import { POOL_ROLES } from './viewer-roles';
import { ACCESS_MATRIX, GAP_WRITER_ROLE, narrowFor } from './access-matrix';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const KEY = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
const DENIED = '42501';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

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

  /** A statement (or several, split on "; ") as the runtime role in a
   *  transaction of its own, rolled back: what the last answers, or the
   *  first error. */
  const asRuntime = async (stmt: string) =>
    rt
      .begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                      set_config('mantle.write_mode', 'rw', true)`;
        let rows: unknown[] = [];
        for (const part of stmt.split('; ')) rows = [...(await tx.unsafe(part))];
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
    expect(await ensureRuntimeRoles(admin, KEY, { login: true })).toBe('ok');
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
    const [attrs] = await admin<{ cr: boolean; cd: boolean; repl: boolean; inh: boolean }[]>`
      select rolcreaterole as cr, rolcreatedb as cd, rolreplication as repl, rolinherit as inh
        from pg_roles where rolname = ${RUNTIME_ROLE}`;
    // NOINHERIT: a hand GRANT without options does not default to INHERIT.
    expect(attrs).toEqual({ cr: false, cd: false, repl: false, inh: false });
    // The owner bypasses the row rules (a cascade runs as it); it never logs in.
    const [owner] = await admin<{ login: boolean; bypass: boolean; su: boolean }[]>`
      select rolcanlogin as login, rolbypassrls as bypass, rolsuper as su
        from pg_roles where rolname = ${OWNER_ROLE}`;
    expect(owner).toEqual({ login: false, bypass: true, su: false });
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
    const [db] = await admin<{ name: string }[]>`select current_database() as name`;
    const name = db!.name;
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
      await admin`select mantle_set_actor_check('off', 50, 'test')`;
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

  it('cannot drop or change the marker mantle_owner_role() reads, nor act as its owner', async () => {
    for (const stmt of [
      `DROP FUNCTION ${ACL_MARKER_FUNCTION}`,
      `ALTER FUNCTION ${ACL_MARKER_FUNCTION} VOLATILE`,
      `ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO ${RUNTIME_ROLE}`,
      `ALTER FUNCTION ${ACL_MARKER_FUNCTION} SET search_path = pg_temp`,
      `DROP OWNED BY ${SYSTEM_ROLE}`,
      `DROP OWNED BY ${OWNER_ROLE}`,
      `REASSIGN OWNED BY ${OWNER_ROLE} TO ${RUNTIME_ROLE}`,
      `SET ROLE ${OWNER_ROLE}`,
      // mantle_system, which it may become, owns nothing.
      `SET LOCAL ROLE ${SYSTEM_ROLE}; DROP FUNCTION ${ACL_MARKER_FUNCTION}`,
      `SET LOCAL ROLE ${SYSTEM_ROLE}; DROP OWNED BY ${OWNER_ROLE}`,
      `SET LOCAL ROLE ${SYSTEM_ROLE}; SET LOCAL ROLE ${OWNER_ROLE}`,
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
    const [opts] = await admin<{ usage: boolean; set: boolean; member: boolean }[]>`
      select pg_has_role(${RUNTIME_ROLE}, ${OWNER_ROLE}, 'USAGE') as usage,
             pg_has_role(${RUNTIME_ROLE}, ${OWNER_ROLE}, 'SET') as set,
             pg_has_role(${RUNTIME_ROLE}, ${OWNER_ROLE}, 'MEMBER') as member`;
    expect(opts).toEqual({ usage: false, set: false, member: true });
    const [own] = await admin<{ owner: string }[]>`
      select pg_get_userbyid(proowner) as owner from pg_proc
       where oid = ${ACL_MARKER_FUNCTION}::regprocedure`;
    expect(own?.owner).toBe(OWNER_ROLE);
  });

  it('cannot run the workspaces switch or its steps (the audit probes)', async () => {
    for (const stmt of [
      'select * from mantle_ws_migrate()',
      'select * from mantle_ws_migrate_bridged()',
      'select * from mantle_ws_migrate_locked()',
      'select mantle_ws_bridge_off()',
      'select mantle_ws_spaces_fold()',
      'select mantle_ws_review_off()',
      'select mantle_ws_team_normal(false)',
      'select mantle_ws_switch_off()',
      `select mantle_ws_ddl_retry(ARRAY['select 1'], 'a9 probe')`,
    ]) {
      await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
    }
  });

  it('runs only its allowlist: PUBLIC-revoked functions are exactly RUNTIME_SYSTEM_FUNCTIONS', async () => {
    const viewers = [...POOL_ROLES.map((r) => viewerRoleName(r)), GAP_WRITER_ROLE];
    const extra = await admin<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = any(${[...APP_SCHEMAS]}::text[])
         and has_function_privilege(${RUNTIME_ROLE}, p.oid, 'EXECUTE')
         and not has_function_privilege('public', p.oid, 'EXECUTE')
         and not exists (select 1 from unnest(${viewers}::text[]) v
                          where has_function_privilege(v, p.oid, 'EXECUTE'))
       order by 1`;
    const listed = await admin<{ fn: string }[]>`
      select to_regprocedure(x)::regprocedure::text as fn
        from unnest(${Object.keys(RUNTIME_SYSTEM_FUNCTIONS)}::text[]) x order by 1`;
    // Every entry names a function this database has.
    expect(listed.every((r) => r.fn !== null)).toBe(true);
    expect(extra.map((r) => r.fn)).toEqual(listed.map((r) => r.fn));
    // And none of the denied ones, whoever else may run them.
    const denied = await admin<{ fn: string }[]>`
      select x as fn from unnest(${Object.keys(RUNTIME_DENIED_FUNCTIONS)}::text[]) x
       where to_regprocedure(x) is not null
         and has_function_privilege(${RUNTIME_ROLE}, to_regprocedure(x), 'EXECUTE')`;
    expect(denied).toEqual([]);
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

  it('the narrow system role: no login, BYPASSRLS, owns nothing, a member of nothing', async () => {
    const [r] = await admin<
      {
        login: boolean;
        su: boolean;
        bypass: boolean;
        inh: boolean;
        cr: boolean;
        cd: boolean;
        repl: boolean;
        pw: boolean;
      }[]
    >`
      select rolcanlogin as login, rolsuper as su, rolbypassrls as bypass, rolinherit as inh,
             rolcreaterole as cr, rolcreatedb as cd, rolreplication as repl,
             rolpassword is not null as pw
        from pg_authid where rolname = ${NARROW_ROLE}`;
    expect(r).toEqual({
      login: false,
      su: false,
      bypass: true,
      inh: false,
      cr: false,
      cd: false,
      repl: false,
      pw: false,
    });
    const [owns] = await admin<{ n: number }[]>`
      select (select count(*)::int from pg_class where relowner = to_regrole(${NARROW_ROLE}))
           + (select count(*)::int from pg_proc where proowner = to_regrole(${NARROW_ROLE})) as n`;
    expect(owns?.n).toBe(0);
    // Its memberships both ways: only the runtime role in it, SET only.
    const ms = await admin<{ role: string; member: string; inherit: boolean; set: boolean }[]>`
      select r.rolname as role, u.rolname as member, m.inherit_option as inherit, m.set_option as set
        from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where r.rolname = ${NARROW_ROLE} or u.rolname = ${NARROW_ROLE}`;
    expect(ms).toEqual([{ role: NARROW_ROLE, member: RUNTIME_ROLE, inherit: false, set: true }]);
    // The runtime role holds none of its rights (no INHERIT): a write the
    // narrow role may make is the runtime role's own right, not through it.
    const [use] = await admin<{ usage: boolean; set: boolean }[]>`
      select pg_has_role(${RUNTIME_ROLE}, ${NARROW_ROLE}, 'USAGE') as usage,
             pg_has_role(${RUNTIME_ROLE}, ${NARROW_ROLE}, 'SET') as set`;
    expect(use).toEqual({ usage: false, set: true });
    // No default privileges name it: a table a later migration makes is
    // closed to it until migrate grants what the matrix says.
    const [def] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_default_acl d, aclexplode(d.defaclacl) a
       where a.grantee = to_regrole(${NARROW_ROLE})`;
    expect(def?.n).toBe(0);
  });

  it('the narrow role holds exactly what the access matrix says, table by table', async () => {
    const live = await admin<{ t: string; privs: string[] }[]>`
      select n.nspname || '.' || c.relname as t,
             array(select distinct a.privilege_type::text from aclexplode(c.relacl) a
                    where a.grantee = to_regrole(${NARROW_ROLE}) order by 1) as privs
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${[...APP_SCHEMAS]}::text[]) and c.relkind in ('r', 'p')
       order by 1`;
    const byTable = new Map(ACCESS_MATRIX.map((t) => [t.table, t]));
    const want = (table: string): string[] => {
      const t = byTable.get(table);
      const n = t ? narrowFor(t) : 'none';
      if (n === 'all') return ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
      if (n === 'read') return ['SELECT'];
      return [];
    };
    expect(live.length).toBeGreaterThan(100);
    const wrong = live.filter((r) => r.privs.join() !== want(r.t).join());
    expect(wrong).toEqual([]);
    // Every matrix table is in this database.
    const tables = new Set(live.map((r) => r.t));
    expect(ACCESS_MATRIX.filter((t) => !tables.has(t.table)).map((t) => t.table)).toEqual([]);
    // No column grant anywhere.
    const [cols] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_attribute att, aclexplode(att.attacl) a
       where a.grantee = to_regrole(${NARROW_ROLE})`;
    expect(cols?.n).toBe(0);
    // Sequences: only those its write tables draw from, never UPDATE (setval).
    const seqs = await admin<{ s: string; privs: string[] }[]>`
      select c.oid::regclass::text as s,
             array(select distinct a.privilege_type::text from aclexplode(c.relacl) a
                    where a.grantee = to_regrole(${NARROW_ROLE}) order by 1) as privs
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${[...APP_SCHEMAS]}::text[]) and c.relkind = 'S'`;
    for (const q of seqs) {
      expect(['', 'SELECT,USAGE'], q.s).toContain(q.privs.join());
    }
    // Schemas: USAGE on public, auth and pgboss, CREATE on none (the a1
    // audit's pin gap).
    const schemas = await admin<{ s: string; usage: boolean; create: boolean }[]>`
      select n.nspname as s,
             has_schema_privilege(${NARROW_ROLE}, n.oid, 'USAGE') as usage,
             has_schema_privilege(${NARROW_ROLE}, n.oid, 'CREATE') as create
        from pg_namespace n where n.nspname in ('public', 'auth', 'pgboss') order by 1`;
    expect(schemas).toEqual([
      { s: 'auth', usage: true, create: false },
      { s: 'pgboss', usage: true, create: false },
      { s: 'public', usage: true, create: false },
    ]);
    // pg-boss's tables: SELECT only, every one.
    const boss = await admin<{ t: string; privs: string[] }[]>`
      select c.oid::regclass::text as t,
             array(select distinct a.privilege_type::text from aclexplode(c.relacl) a
                    where a.grantee = to_regrole(${NARROW_ROLE}) order by 1) as privs
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'pgboss' and c.relkind in ('r', 'p')`;
    for (const b of boss) expect(b.privs, b.t).toEqual(['SELECT']);
  });

  it('the narrow role runs the runtime allowlist less NARROW_DENIED_FUNCTIONS', async () => {
    const may = async (role: string) =>
      (
        await admin<{ fn: string }[]>`
          select p.oid::regprocedure::text as fn
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = any(${[...APP_SCHEMAS]}::text[])
             and not has_function_privilege('public', p.oid, 'EXECUTE')
             and has_function_privilege(${role}, p.oid, 'EXECUTE')
           order by 1`
      ).map((r) => r.fn);
    const denied = (
      await admin<{ fn: string }[]>`
        select to_regprocedure(x)::text as fn
          from unnest(${Object.keys(NARROW_DENIED_FUNCTIONS)}::text[]) x`
    ).map((r) => r.fn);
    // Every entry names a function this database has.
    expect(denied.every((f) => f !== null)).toBe(true);
    const runtime = await may(RUNTIME_ROLE);
    expect(await may(NARROW_ROLE)).toEqual(runtime.filter((f) => !denied.includes(f)));
    for (const f of denied) expect(runtime, f).toContain(f);
  });

  it('as the narrow role (from the runtime role and from the superuser): reads past the rules, writes only where the matrix says', async () => {
    /** Statements in one transaction as the narrow role, taken the way the
     *  narrow route takes it (set_config('role', ..., true)); rolled back. */
    const asNarrow = (conn: ReturnType<typeof postgres>, stmt: string) =>
      conn
        .begin(async (tx) => {
          await tx`select set_config('mantle.actor', 'system:test', true),
                          set_config('mantle.write_mode', 'rw', true),
                          set_config('role', ${NARROW_ROLE}, true)`;
          let rows: unknown[] = [];
          for (const part of stmt.split('; ')) rows = [...(await tx.unsafe(part))];
          throw Object.assign(new Error('rollback'), { rows });
        })
        .catch((err: { code?: string; rows?: unknown[] }) => {
          if (err.rows) return err.rows;
          throw err;
        });
    const [all] = await admin<{ n: number; w: number }[]>`
      select (select count(*)::int from public.nodes) as n,
             (select count(*)::int from public.workspaces) as w`;
    for (const conn of [rt, admin]) {
      const who = conn === rt ? 'runtime' : 'superuser';
      const [me] = (await asNarrow(
        conn,
        `select current_user as u, (select count(*)::int from public.nodes) as n,
                (select count(*)::int from public.workspaces) as w`,
      )) as { u: string; n: number; w: number }[];
      expect(me, who).toEqual({ u: NARROW_ROLE, n: all!.n, w: all!.w });
      // A system table: written.
      expect(await asNarrow(conn, 'delete from public.audit_log where false'), who).toEqual([]);
      for (const stmt of [
        // A content table: read only.
        'insert into public.nodes (id) select id from public.nodes where false',
        'update public.nodes set title = title where false',
        'delete from public.facts where false',
        // A table the runtime role only reads, and one it cannot touch.
        'delete from public.workspaces where false',
        'select count(*) from public.mantle_heads_key',
        // What the runtime role may not do, nor may it.
        'truncate public.audit_log',
        'ALTER TABLE public.nodes DISABLE TRIGGER mantle_actor_check',
        `select mantle_set_actor_check('off', 1, 'probe')`,
        // A body with no Admin check, and the box count.
        `select mantle_entity_merge_rows('${randomUUID()}', '${randomUUID()}', '${randomUUID()}')`,
        'select mantle_role_drift()',
      ]) {
        await expect(asNarrow(conn, stmt), `${who}: ${stmt}`).rejects.toMatchObject({
          code: DENIED,
        });
      }
      // The derivation guards count it as a limited role, not the owner.
      const [g] = (await asNarrow(conn, 'select mantle_owner_role() as ok')) as { ok: boolean }[];
      expect(g?.ok, who).toBe(false);
    }
    // SET ROLE asks the session's login, not the current role: from the
    // runtime role's session the owner stays out of reach. The narrow role
    // contains the app's own statements; a statement that sets the role
    // back leaves it (the session's own rights), which is why it is taken
    // per transaction and never as a session SET.
    await expect(asNarrow(rt, `SET LOCAL ROLE ${OWNER_ROLE}`)).rejects.toMatchObject({
      code: DENIED,
    });
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

  it('no SECURITY DEFINER function the runtime role may run reaches DDL, through any call', async () => {
    // Each definer it may run, and every function of the app's schemas its
    // body names, and theirs, and so on (a name in the body counts as a
    // call: an over-count only, never a miss of a plain call). A call built
    // with EXECUTE format(...) is not followed: the allowlist pin above is
    // what keeps those (the workspaces switch's steps) from the runtime role.
    type Fn = { fn: string; name: string; src: string; root: boolean };
    const fns: Fn[] = await admin<Fn[]>`
      select p.oid::regprocedure::text as fn, p.proname as name, p.prosrc as src,
             p.prosecdef and has_function_privilege(${RUNTIME_ROLE}, p.oid, 'EXECUTE') as root
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = any(${[...APP_SCHEMAS]}::text[]) and p.prokind = 'f'`;
    const roots = fns.filter((f) => f.root);
    expect(roots.length).toBeGreaterThan(20);
    const byName = new Map<string, Fn[]>();
    for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
    const word = /\b[a-z_][a-z0-9_]*\b/gi;
    const reached = (root: Fn) => {
      const seen = new Set<string>([root.fn]);
      const queue = [root];
      while (queue.length > 0) {
        const f = queue.shift()!;
        for (const w of new Set(f.src.match(word) ?? [])) {
          for (const g of byName.get(w.toLowerCase()) ?? []) {
            if (seen.has(g.fn)) continue;
            seen.add(g.fn);
            queue.push(g);
          }
        }
      }
      return fns.filter((f) => seen.has(f.fn));
    };
    const ddl = roots.flatMap((r) =>
      reached(r)
        .filter((f) => DDL_IN_BODY.test(f.src))
        .map((f) => `${r.fn} -> ${f.fn}`),
    );
    expect(ddl).toEqual([]);
  });

  it('every table of public and auth is mantle_owner’s, and the marker', async () => {
    const stray = await admin<{ rel: string; owner: string }[]>`
      select c.oid::regclass::text as rel, pg_get_userbyid(c.relowner) as owner
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = any(${[...APP_SCHEMAS]}::text[]) and c.relkind in ('r', 'p', 'S')
         and pg_get_userbyid(c.relowner) <> ${OWNER_ROLE}`;
    expect(stray).toEqual([]);
    const [marker] = await admin<{ owner: string }[]>`
      select pg_get_userbyid(proowner) as owner from pg_proc
       where oid = ${ACL_MARKER_FUNCTION}::regprocedure`;
    expect(marker?.owner).toBe(OWNER_ROLE);
    // The integrity row runtime_role_lock: nothing to say.
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
  });

  it('the migrator steps are idempotent, and a hand grant is taken back', async () => {
    await admin.unsafe(`GRANT ${OWNER_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE, SET TRUE`);
    await admin.unsafe(`GRANT ${SYSTEM_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE`);
    await admin.unsafe(`GRANT ${NARROW_ROLE} TO ${RUNTIME_ROLE} WITH INHERIT TRUE`);
    await admin.unsafe(`GRANT TRUNCATE ON public.nodes TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`GRANT INSERT ON public.nodes TO ${NARROW_ROLE}`);
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION mantle_role_drift() TO ${NARROW_ROLE}`);
    await admin.unsafe(`GRANT EXECUTE ON FUNCTION mantle_ws_migrate() TO ${RUNTIME_ROLE}`);
    await admin.unsafe(`ALTER TABLE public.actor_check_misses OWNER TO postgres`);
    // A function the runtime role owns: the integrity row says so.
    await admin.unsafe(`ALTER FUNCTION ${ACL_MARKER_FUNCTION} OWNER TO ${RUNTIME_ROLE}`);
    const broken = (await admin.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
    expect(broken[0]?.detail).toMatch(/owns functions/);
    expect(broken[0]?.detail).toMatch(/holds the rights of/);
    expect(broken[0]?.detail).toMatch(/may become mantle_owner/);
    const [mode] = (await rt.unsafe(DB_ROLE_SQL)) as unknown as DbRoleRow[];
    expect(dbRoleMode(mode!)).toBe('other');
    expect(await ensureRuntimeRoles(admin, KEY, { login: true })).toBe('ok');
    await afterMigrations(admin, 'ok', { info: () => {}, warn: () => {} });
    const ms = await admin<{ role: string; inherit: boolean; set: boolean }[]>`
      select r.rolname as role, m.inherit_option as inherit, m.set_option as set
        from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where u.rolname = ${RUNTIME_ROLE} order by 1`;
    expect(ms).toEqual([
      { role: OWNER_ROLE, inherit: false, set: false },
      { role: SYSTEM_ROLE, inherit: false, set: true },
      { role: NARROW_ROLE, inherit: false, set: true },
    ]);
    const [t] = await admin<{ ok: boolean; ws: boolean; ni: boolean; nd: boolean }[]>`
      select has_table_privilege(${RUNTIME_ROLE}, 'public.nodes', 'TRUNCATE') as ok,
             has_function_privilege(${RUNTIME_ROLE}, 'mantle_ws_migrate()', 'EXECUTE') as ws,
             has_table_privilege(${NARROW_ROLE}, 'public.nodes', 'INSERT') as ni,
             has_function_privilege(${NARROW_ROLE}, 'mantle_role_drift()', 'EXECUTE') as nd`;
    expect(t).toEqual({ ok: false, ws: false, ni: false, nd: false });
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
    expect((await ownTables(admin)).owned).toEqual([]);
  });

  it('a busy table never holds up the ownership change: it is left for the next run', async () => {
    await admin.unsafe(`ALTER TABLE public.actor_check_misses OWNER TO postgres`);
    await admin.unsafe(`ALTER TABLE public.heads_check_misses OWNER TO postgres`);
    // Another session reads one of them for the whole run (the old app,
    // still serving while compose's migrate runs).
    const reader = postgres(scratch.url, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const tx = reader.begin(async (t) => {
      await t`lock table public.actor_check_misses in access share mode`;
      locked();
      await held;
    });
    try {
      await isLocked;
      const started = Date.now();
      const out = await ownTables(admin);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(out.owned).toEqual(['heads_check_misses']);
      expect(out.failed.map((f) => [f.rel, f.busy])).toEqual([['actor_check_misses', true]]);
    } finally {
      release();
      await tx;
      await reader.end();
    }
    expect((await ownTables(admin)).owned).toEqual(['actor_check_misses']);
  });

  it('takes back every membership held in the runtime roles, and the integrity row names one', async () => {
    // A role of its own (cluster-wide, so never a pool role another file
    // logs in as), a member of mantle_runtime with neither INHERIT nor SET:
    // through it a member of mantle_owner, and mantle_owner_role() (0290,
    // MEMBER) said yes to it.
    const probe = `a9_probe_${randomBytes(4).toString('hex')}`;
    const held = `${probe}_held`;
    await admin.unsafe(`CREATE ROLE "${probe}" NOLOGIN`);
    await admin.unsafe(`CREATE ROLE "${held}" NOLOGIN`);
    try {
      const warned: string[] = [];
      // The grants, the checks and the take-back in one transaction: the
      // roles are cluster-wide, and every other file's scratch migrate
      // (ensureRuntimeRoles) would take a committed grant back under this
      // test. Uncommitted, no other session sees them.
      await admin.begin(async (tx) => {
        await tx.unsafe(`GRANT ${RUNTIME_ROLE} TO "${probe}" WITH INHERIT FALSE, SET FALSE`);
        await tx.unsafe(`GRANT ${SYSTEM_ROLE} TO "${probe}" WITH INHERIT FALSE, SET TRUE`);
        // The narrow role both ways: another role that may become it, and
        // it a member of another role.
        await tx.unsafe(`GRANT ${NARROW_ROLE} TO "${probe}" WITH INHERIT FALSE, SET TRUE`);
        await tx.unsafe(`GRANT "${held}" TO ${NARROW_ROLE}`);
        // And a hand GRANT to the runtime role without options: NOINHERIT
        // makes it INHERIT FALSE.
        await tx.unsafe(`GRANT "${held}" TO ${RUNTIME_ROLE}`);
        const asProbe = async () => {
          await tx.unsafe(`set local role "${probe}"`);
          const [r] = await tx<{ ok: boolean }[]>`select mantle_owner_role() as ok`;
          await tx.unsafe('reset role');
          return r?.ok;
        };
        expect(await asProbe()).toBe(true);
        const [inh] = await tx<{ inherit: boolean }[]>`
          select m.inherit_option as inherit from pg_auth_members m
           where m.roleid = to_regrole(${held}) and m.member = to_regrole(${RUNTIME_ROLE})`;
        expect(inh?.inherit).toBe(false);
        const broken = (await tx.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
        expect(broken[0]?.detail).toContain(`other members of ${OWNER_ROLE}: ${probe}`);
        // migrate (beforeMigrations, ensureRuntimeRoles) takes them back,
        // both ways.
        await takeBackMemberships(tx, (l) => warned.push(l));
        const left = await tx<{ role: string; member: string }[]>`
          select r.rolname as role, u.rolname as member from pg_auth_members m
            join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
           where r.rolname = any(${[probe, held]}::text[])
              or u.rolname = any(${[probe, held]}::text[])`;
        expect(left).toEqual([]);
        expect(await asProbe()).toBe(false);
        expect(await tx.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
      });
      // One warning each, naming role, member and grantor.
      const mine = warned.filter((l) => l.includes(probe)).sort();
      expect(mine).toHaveLength(5);
      for (const [role, member] of [
        [held, RUNTIME_ROLE],
        [held, NARROW_ROLE],
        [RUNTIME_ROLE, probe],
        [SYSTEM_ROLE, probe],
        [NARROW_ROLE, probe],
      ]) {
        expect(
          mine.some((l) =>
            l.startsWith(`  WARNING membership taken back: ${role} from ${member} (granted by `),
          ),
        ).toBe(true);
      }
      expect(await ensureRuntimeRoles(admin, KEY, { login: true, warn: () => {} })).toBe('ok');
      // Who is a member of mantle_owner now: the runtime role, and no other
      // role that is not a superuser.
      const members = await admin<{ name: string }[]>`
        select rolname as name from pg_roles
         where not rolsuper and rolname <> ${OWNER_ROLE}
           and pg_has_role(oid, to_regrole(${OWNER_ROLE}), 'MEMBER') order by 1`;
      expect(members.map((m) => m.name)).toEqual([RUNTIME_ROLE]);
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS "${probe}", "${held}"`);
    }
  });

  it('an operator grant WITH ADMIN OPTION passed on goes too: a warning each, never a failed migrate', async () => {
    // GRANT mantle_system TO ops_a WITH ADMIN OPTION, and ops_a's own grant
    // on to ops_b: a plain REVOKE of ops_a's is refused (2BP01, dependent
    // privileges exist), and migrate exited 1 with web and workers waiting
    // on it. And a plain operator membership in mantle_owner.
    const tag = randomBytes(4).toString('hex');
    const [a, b, c] = ['a', 'b', 'c'].map((x) => `a9_ops_${x}_${tag}`) as [string, string, string];
    for (const r of [a, b, c]) await admin.unsafe(`CREATE ROLE "${r}" NOLOGIN`);
    try {
      const warned: string[] = [];
      const failed: string[] = [];
      // In one transaction, as above: no other file's migrate sees them.
      await admin.begin(async (tx) => {
        await tx.unsafe(`GRANT ${SYSTEM_ROLE} TO "${a}" WITH ADMIN OPTION`);
        await tx.unsafe(`SET LOCAL ROLE "${a}"`);
        await tx.unsafe(`GRANT ${SYSTEM_ROLE} TO "${b}"`);
        await tx.unsafe('RESET ROLE');
        await tx.unsafe(`GRANT ${OWNER_ROLE} TO "${c}"`);
        await expect(
          tx.savepoint((sp) => sp.unsafe(`REVOKE ${SYSTEM_ROLE} FROM "${a}"`)),
        ).rejects.toMatchObject({ code: '2BP01' });
        const broken = (await tx.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
        expect(broken[0]?.detail).toContain(`other members of ${OWNER_ROLE}: ${c}`);
        // A revoke that fails for any other reason is a warning, not a
        // failed run: nothing is taken back, and the run goes on.
        const failing = {
          unsafe: (q: string, p?: never[]) =>
            q.startsWith('REVOKE')
              ? Promise.reject(Object.assign(new Error('refused for the test'), { code: 'XX999' }))
              : tx.unsafe(q, p),
        } as unknown as Parameters<typeof takeBackMemberships>[0];
        await takeBackMemberships(failing, (l) => failed.push(l));
        // The real one: the far end of the chain first, each with CASCADE.
        await takeBackMemberships(tx, (l) => warned.push(l));
        const left = await tx<{ n: number }[]>`
          select count(*)::int as n from pg_auth_members m join pg_roles u on u.oid = m.member
           where u.rolname = any(${[a, b, c]}::text[])`;
        expect(left[0]?.n).toBe(0);
        expect(await tx.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
      });
      expect(failed.filter((l) => l.includes(tag))).toHaveLength(3);
      for (const l of failed.filter((x) => x.includes(tag))) {
        expect(l).toMatch(
          /^ {2}WARNING could not take back .*refused for the test; the integrity row/,
        );
      }
      const mine = warned.filter((l) => l.includes(tag));
      expect(mine).toHaveLength(3);
      expect(mine[0]).toBe(
        `  WARNING membership taken back: ${SYSTEM_ROLE} from ${b} (granted by ${a})`,
      );
      expect(mine.some((l) => l.includes(`${SYSTEM_ROLE} from ${a} (granted by `))).toBe(true);
      expect(mine.some((l) => l.includes(`${OWNER_ROLE} from ${c} (granted by `))).toBe(true);
      expect(warned.filter((l) => /could not take back/.test(l))).toEqual([]);
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS "${b}", "${a}", "${c}"`);
    }
  });

  it('a mantle_owner_role() from before 0290 shows: the integrity row and a migrate warning', async () => {
    const restore = readFileSync(join(MIGRATIONS, '0290_owner_role_member.sql'), 'utf8');
    // 0241's version: USAGE, which the runtime role (no INHERIT) never passes.
    await admin.unsafe(`
      CREATE OR REPLACE FUNCTION ${OWNER_ROLE_FUNCTION}
        RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT pg_has_role(current_user,
                           (SELECT p.proowner FROM pg_proc p
                             WHERE p.oid = 'public.mantle_acl_internal()'::regprocedure),
                           'USAGE')
      $$`);
    try {
      const [ok] = (await asRuntime('select mantle_owner_role() as ok')) as { ok: boolean }[];
      expect(ok?.ok).toBe(false);
      const broken = (await admin.unsafe(RUNTIME_LOCK_SQL)) as unknown as { detail: string }[];
      expect(broken).toHaveLength(1);
      expect(broken[0]?.detail).toMatch(/not the MEMBER version \(migration 0290 not applied\)/);
      const warned: string[] = [];
      await afterMigrations(admin, 'ok', { info: () => {}, warn: (l) => warned.push(l) });
      expect(warned.filter((l) => /0290 not applied/.test(l))).toHaveLength(1);
    } finally {
      await admin.unsafe(restore);
    }
    const [ok] = (await asRuntime('select mantle_owner_role() as ok')) as { ok: boolean }[];
    expect(ok?.ok).toBe(true);
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
  });

  it('a table left with its old owner: a cascade as mantle_owner still reads past the row rules', async () => {
    // What a busy table left behind (ownTables) meets: the triggers a
    // cascade fires run as mantle_owner, which does not own this table.
    // BYPASSRLS on the owner: it reads what it read as the superuser.
    const [before] = await admin<{ n: number; rls: boolean }[]>`
      select (select count(*)::int from public.spaces) as n,
             (select relrowsecurity from pg_class where oid = 'public.spaces'::regclass) as rls`;
    expect(before?.rls).toBe(true);
    expect(before?.n).toBeGreaterThan(0);
    await admin.unsafe(`ALTER TABLE public.spaces OWNER TO postgres`);
    try {
      await admin.unsafe(`GRANT ALL ON public.spaces TO ${OWNER_ROLE}`);
      const seen = await admin.begin(async (tx) => {
        await tx.unsafe(`set local role ${OWNER_ROLE}`);
        const [r] = await tx<{ n: number }[]>`select count(*)::int as n from public.spaces`;
        return r?.n;
      });
      expect(seen).toBe(before?.n);
      // The runtime role, logged in as itself, gains nothing by it: it
      // cannot become the owner, holds none of its rights (the heads key,
      // which the owner may read), and BYPASSRLS is never inherited.
      for (const stmt of [
        `SET ROLE ${OWNER_ROLE}`,
        'select * from public.mantle_heads_key',
        `SET LOCAL ROLE ${SYSTEM_ROLE}; SET LOCAL ROLE ${OWNER_ROLE}`,
        `SET LOCAL ROLE ${SYSTEM_ROLE}; select count(*) from public.spaces`,
      ]) {
        await expect(asRuntime(stmt), stmt).rejects.toMatchObject({ code: DENIED });
      }
      const [rights] = await admin<{ usage: boolean; set: boolean; key: boolean }[]>`
        select pg_has_role(${RUNTIME_ROLE}, ${OWNER_ROLE}, 'USAGE') as usage,
               pg_has_role(${RUNTIME_ROLE}, ${OWNER_ROLE}, 'SET') as set,
               has_table_privilege(${RUNTIME_ROLE}, 'public.mantle_heads_key', 'SELECT') as key`;
      expect(rights).toEqual({ usage: false, set: false, key: false });
    } finally {
      expect((await ownTables(admin)).owned).toEqual(['spaces']);
    }
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
  });

  it('migrate makes a missing or changed marker again, and the write guards work', async () => {
    const guard = async () => {
      const [r] = (await asRuntime('select mantle_owner_role() as ok')) as { ok: boolean }[];
      return r?.ok;
    };
    for (const breakIt of [
      `DROP FUNCTION ${ACL_MARKER_FUNCTION}`,
      `ALTER FUNCTION ${ACL_MARKER_FUNCTION} VOLATILE`,
      `CREATE OR REPLACE FUNCTION ${ACL_MARKER_FUNCTION} RETURNS boolean LANGUAGE sql STABLE AS 'select true'`,
    ]) {
      await admin.unsafe(breakIt);
      if (breakIt.startsWith('DROP')) {
        await expect(guard(), breakIt).rejects.toBeTruthy();
        expect(await admin.unsafe(RUNTIME_LOCK_SQL), breakIt).toHaveLength(1);
      }
      await afterMigrations(admin, 'ok', { info: () => {}, warn: () => {} });
      const [m] = await admin<{ owner: string; vol: string; src: string }[]>`
        select pg_get_userbyid(proowner) as owner, provolatile::text as vol, btrim(prosrc, E' \n\t\r') as src
          from pg_proc where oid = ${ACL_MARKER_FUNCTION}::regprocedure`;
      expect(m, breakIt).toEqual({
        owner: OWNER_ROLE,
        vol: 's',
        src: "SELECT coalesce(current_setting('mantle.acl_internal', true), '') = 'on'",
      });
      expect(await guard(), breakIt).toBe(true);
    }
    expect(await admin.unsafe(RUNTIME_LOCK_SQL)).toEqual([]);
  });
});
