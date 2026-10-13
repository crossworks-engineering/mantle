/**
 * The write role (mantle_write_user, workspaces arch A2b2a, plan v2 20.1):
 * its row rules, the trigger functions its writes fire, and what it may and
 * may not do, on a real login of the role (session_user is the write role,
 * as the 0277 gate needs).
 *
 *  - Policies: every read rule of the workspace role names the write role;
 *    each write table (WRITE_ROLE_TABLES, from the access matrix) has exactly
 *    its three write rules, each the table's read rule; no other table has
 *    a write rule for the role.
 *  - Triggers: every trigger function on a content table runs as its owner
 *    (SECURITY DEFINER, with a search_path), or is on CALLER_RIGHTS with its
 *    reason; such a function reads no table, takes no heads lock, and the
 *    write role may run everything it calls.
 *  - Cells, per actor kind: a readable row is written, an unreadable one
 *    matches no row (RETURNING too), a row cannot be moved out of what the
 *    scope reads, the guards refuse, a delete reaps what the login cannot
 *    read.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/write-role.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCESS_MATRIX,
  WRITE_ROLE_FUNCTIONS,
  WRITE_ROLE_SYSTEM_ONLY,
  WRITE_ROLE_TABLES,
  gapWriterRoleStatement,
  syncGapWriterRights,
  syncWriteRoleRules,
  writeCheckArgs,
  writeRoleWrites,
} from './access-matrix';
import { createMigratedScratchDatabase } from './test-support';
import { withRoleRetry } from './viewer-roles';
import { viewerDatabaseUrl, viewerRolePassword } from './viewer';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const WRITER = 'mantle_write_user';
const VIEWER = 'mantle_view_user';

/** Trigger functions on a content table that run with the caller's rights,
 *  and why that is right. Every other one is SECURITY DEFINER. */
const GUARD =
  'must run as the caller: mantle_owner_role() reads current_user, so as a definer it would always pass';
const CALLER_RIGHTS: Readonly<Record<string, string>> = {
  mantle_actor_check_stmt:
    'reads only settings and mantle_actor_check_mode (a definer); refuses or notes a write with no actor',
  apps_author_ceiling_seen: 'sets a column of NEW; reads nothing',
  mantle_nodes_create_stamp_trg: 'stamps NEW from a setting; reads nothing',
  touch_updated_at: 'sets NEW.updated_at; reads nothing',
  mantle_nodes_acl_guard_trg: GUARD,
  mantle_follow_guard_trg: GUARD,
  mantle_nodes_login_guard_trg: GUARD,
  notify_node_ingested:
    'pg_notify; mantle_is_brain_space is a definer the write role may run (0278)',
  notify_tasks_changed: 'pg_notify only',
  mantle_notify_needs_you_request: 'pg_notify only',
  mantle_notify_login_comment: 'pg_notify only (node_comments: system only)',
  mantle_notify_login_review: 'pg_notify only (space_items: system only)',
};

/** The tables a function body names after FROM, JOIN, INTO, UPDATE or
 *  TABLE; never a call (`from f(`), `is distinct from`, or a system catalog
 *  (pg_*: every role reads those). `body` as code() returns it. */
function tablesIn(body: string): string[] {
  const TABLE =
    /\b(?:from|join|into|update|table)\s+(?:only\s+)?(?:"?(?:public|auth)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![.a-z0-9_"]|\s*\()/g;
  return [...body.replace(/\bis\s+(?:not\s+)?distinct\s+from\b/g, ' ').matchAll(TABLE)]
    .map((m) => m[1]!)
    .filter((t) => !t.startsWith('pg_'));
}

it('the table finder finds tables and nothing else', () => {
  expect(
    tablesIn(code(`delete from public.facts where x; select 1 from "public"."nodes" n`)),
  ).toEqual(['facts', 'nodes']);
  expect(
    tablesIn(code(`insert into item_grants values (1); update only spaces set a = 1`)),
  ).toEqual(['item_grants', 'spaces']);
  expect(
    tablesIn(
      code(`if new.a is distinct from old.a then perform x from "public"."f"(1);
            select p.proowner from pg_proc p; -- from nodes
            raise exception 'cannot update from nodes'`),
    ),
  ).toEqual([]);
});

/** Every SECURITY DEFINER function the write role may run (its own rights,
 *  the workspace role's and PUBLIC's), and why that is safe. */
const DEFINERS_THE_WRITE_ROLE_RUNS: Readonly<Record<string, string>> = {
  'mantle_actor_check_mode()': 'reads only the box setting (pg_db_role_setting); open to PUBLIC',
  'mantle_brain_id()': "the workspace role's policy helper: the brain's own id",
  'mantle_brain_team_ws()': "the workspace role's policy helper: the Team workspace id",
  'mantle_scope_has_area(text)': "the workspace role's policy helper: reads the scope",
  'mantle_scope_has_connector(uuid,text)': "the workspace role's policy helper: reads the scope",
  'mantle_scope_is_admin()': "the workspace role's policy helper: reads the scope",
  'mantle_page_folder_id(uuid,ltree,text)':
    'the workspace role reads it (pages/read.ts): a folder id only, the tree answers 404',
  'mantle_is_brain_space(uuid)': WRITE_ROLE_FUNCTIONS['public.mantle_is_brain_space(uuid)']!,
  'mantle_lock_heads(uuid[],text)': WRITE_ROLE_FUNCTIONS['public.mantle_lock_heads(uuid[],text)']!,
  'mantle_lock_heads_more(uuid[])': WRITE_ROLE_FUNCTIONS['public.mantle_lock_heads_more(uuid[])']!,
  'mantle_lock_heads_nested(uuid[],text)':
    WRITE_ROLE_FUNCTIONS['public.mantle_lock_heads_nested(uuid[],text)']!,
  'mantle_lock_subtree_heads(uuid,uuid[])':
    WRITE_ROLE_FUNCTIONS['public.mantle_lock_subtree_heads(uuid,uuid[])']!,
  'mantle_grant_change(text,uuid,uuid,boolean,uuid)':
    WRITE_ROLE_FUNCTIONS['public.mantle_grant_change(text,uuid,uuid,boolean,uuid)']!,
  'mantle_grant_move_home(uuid,uuid,boolean,uuid)':
    WRITE_ROLE_FUNCTIONS['public.mantle_grant_move_home(uuid,uuid,boolean,uuid)']!,
  'mantle_workspace_event(uuid,uuid,text,jsonb)':
    WRITE_ROLE_FUNCTIONS['public.mantle_workspace_event(uuid,uuid,text,jsonb)']!,
  'mantle_recall_retarget(uuid,text,text)':
    WRITE_ROLE_FUNCTIONS['public.mantle_recall_retarget(uuid,text,text)']!,
  'mantle_secret_put(uuid,bytea,integer)':
    WRITE_ROLE_FUNCTIONS['public.mantle_secret_put(uuid,bytea,integer)']!,
  'mantle_subtree_rewrite(uuid,ltree,ltree)':
    WRITE_ROLE_FUNCTIONS['public.mantle_subtree_rewrite(uuid,ltree,ltree)']!,
  'mantle_subtree_refuse_hidden(uuid,ltree)':
    WRITE_ROLE_FUNCTIONS['public.mantle_subtree_refuse_hidden(uuid,ltree)']!,
  // The visibility confirm's workspace reads (0279, A2b2b fix round 1 M3):
  // the workspace role's, so the write role's too.
  'mantle_folder_grant_rows(uuid)':
    'a folder’s grant rows not excluded, only for a folder the scope reads: the confirm',
  'mantle_ws_admin_id(uuid)': 'the brain’s Admin workspace id (an id, no name): the confirm',
  'mantle_ws_live(uuid,uuid)':
    'a workspace is live, only one the scope may see named through `via`: the confirm',
  'mantle_ws_names(uuid[],uuid)':
    'workspace names, only those the scope may see named through `via`: the confirm',
  // A workspace's kind for its default icon (0285): a kind only, and only
  // for a workspace the scope may name.
  'mantle_ws_kind(uuid)':
    'a workspace’s kind (admin, team, private, other), only one the scope names',
  // 0286 fix round 1: the one meaning of a shared workspace, a yes or no.
  'mantle_ws_any_shared(uuid[])':
    'whether any of the workspaces is shared (not Admin, private or Former user), only one the scope names',
};

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

/** A function body with comments and string literals taken out. */
function code(src: string): string {
  return src
    .replace(/--[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .toLowerCase();
}

describe.skipIf(!URL)('the write role (arch A2b2a)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const tag = `wr${randomUUID().slice(0, 6)}`;
  const L = { owner: randomUUID(), mod: randomUUID(), mem: randomUUID(), out: randomUUID() };
  const ws = { admin: '', H: '', E: '', O: '', M: '', P: '' };
  const n = { root: '', n1: '', n2: '', n3: '', f: '', n5: '' };

  const contentTables = ACCESS_MATRIX.filter((t) => t.writer === 'content').map((t) => t.table);

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice: () => {} });
    w = postgres(viewerDatabaseUrl(scratch.url, 'write', viewerRolePassword(testKey, 'write')), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
        (${L.owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
        (${L.mod}, ${`${tag}-m@example.invalid`}, 'x', false, 'member', 'Moderator'),
        (${L.mem}, ${`${tag}-u@example.invalid`}, 'x', false, 'member', 'Member'),
        (${L.out}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`;
      await tx`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
        on conflict (id) do nothing`;
    });
    await sql`select * from mantle_ws_migrate()`;
    ws.admin = (
      await sql<{ id: string }[]>`
        select id::text as id from workspaces where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    // H: the home (mod moderates it, mem sits in it); E: mem, with Write on
    // the items; O: the outsider's; P: mem's own (a private workspace: its
    // login moderates it).
    for (const [key, seats] of [
      [
        'H',
        [
          [L.mod, true],
          [L.mem, false],
        ],
      ],
      ['E', [[L.mem, false]]],
      ['O', [[L.out, true]]],
      ['M', [[L.mod, true]]],
      ['P', [[L.mem, true]]],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        insert into workspaces (owner_id, name) values (${L.owner}, ${`${tag} ${key}`})
        returning id::text as id`;
      ws[key] = row!.id;
      for (const [who, mod] of seats) {
        await sql`insert into workspace_users (workspace_id, login_id, moderator)
                  values (${row!.id}, ${who}, ${mod})`;
      }
    }
    await sql`insert into nodes (owner_id, type, title, path)
              select ${L.owner}, 'branch', 'notes', 'notes'::ltree
               where not exists (select 1 from nodes where owner_id = ${L.owner}
                                   and type = 'branch' and path = 'notes'::ltree)`;
    n.root = (
      await sql<{ id: string }[]>`select id::text as id from nodes
        where owner_id = ${L.owner} and type = 'branch' and path = 'notes'::ltree`
    )[0]!.id;
    // n1 and n3: home H, Write to E. n2: home O.
    for (const [key, grants] of [
      [
        'n1',
        [
          [() => ws.H, true, false],
          [() => ws.E, false, true],
        ],
      ],
      ['n2', [[() => ws.O, true, false]]],
      [
        'n3',
        [
          [() => ws.H, true, false],
          [() => ws.E, false, true],
        ],
      ],
    ] as const) {
      const id = randomUUID();
      n[key] = id;
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${n.root}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${id}, ${L.owner}, 'note', ${`${tag} ${key}`}, 'notes'::ltree)`;
        await tx`insert into pages (node_id) values (${id}) on conflict do nothing`;
      });
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
        await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
        for (const [wsOf, home, write] of grants) {
          await tx`insert into item_grants (node_id, workspace_id, is_home, write)
                   values (${id}, ${wsOf()}, ${home}, ${write})`;
        }
      });
    }
    // F: a folder (home H, Write to E); n5 in F with E excluded and a read
    // grant to M: a scope of E and M reads n5 and edits F, not n5 (the
    // rank rule).
    n.f = randomUUID();
    n.n5 = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${n.root}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${n.f}, ${L.owner}, 'branch', ${`${tag} F`}, ${`notes.${tag}f`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${n.f}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${n.f} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${n.f}, ${ws.H}, true, false), (${n.f}, ${ws.E}, false, true)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${n.f}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${n.n5}, ${L.owner}, 'note', ${`${tag} n5`}, ${`notes.${tag}f`}::ltree)`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n5}]::uuid[], 'update')`;
      await tx`update item_grants set excluded = true where node_id = ${n.n5} and workspace_id = ${ws.E}`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write)
               values (${n.n5}, ${ws.M}, false, false) on conflict do nothing`;
    });
  }, 240_000);

  afterAll(async () => {
    await w?.end();
    await sql?.end();
    await scratch?.drop();
  });

  // ── Policies ──────────────────────────────────────────────────────────────

  it('the gap writer (A2b2b round 3, D): its lock attributes are set again on every pass', async () => {
    const stmt = gapWriterRoleStatement(true);
    for (const attr of ['NOLOGIN', 'NOSUPERUSER', 'NOBYPASSRLS', 'NOINHERIT', 'NOCREATEROLE']) {
      expect(stmt).toContain(attr);
    }
    expect(stmt.startsWith('ALTER ROLE "mantle_gap_writer" WITH')).toBe(true);
    // Changed by hand: the next pass takes it back. A cluster role: other
    // test files migrate at once ("tuple concurrently updated"), so retried.
    await withRoleRetry(() => sql.unsafe('ALTER ROLE "mantle_gap_writer" WITH BYPASSRLS INHERIT'));
    try {
      await syncGapWriterRights(sql);
    } finally {
      const [r] = await sql<{ bypass: boolean; inherit: boolean; login: boolean }[]>`
        select rolbypassrls as bypass, rolinherit as inherit, rolcanlogin as login
          from pg_roles where rolname = 'mantle_gap_writer'`;
      if (r?.bypass || r?.inherit) {
        await withRoleRetry(() =>
          sql.unsafe('ALTER ROLE "mantle_gap_writer" WITH NOBYPASSRLS NOINHERIT'),
        );
      }
      expect(r).toEqual({ bypass: false, inherit: false, login: false });
    }
  });

  it('every read rule of the workspace role names the write role, and only SELECT rules do', async () => {
    const rows = await sql<{ t: string; cmd: string; both: boolean }[]>`
      select schemaname || '.' || tablename || '.' || policyname as t, cmd,
             ${WRITER}::name = any(roles) as both
        from pg_policies where ${VIEWER}::name = any(roles) order by 1`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.both).map((r) => r.t)).toEqual([]);
    expect(rows.filter((r) => r.cmd !== 'SELECT').map((r) => r.t)).toEqual([]);
  });

  it('each write table has exactly its three write rules, each the read rule; no other table has one', async () => {
    const rows = await sql<
      {
        t: string;
        name: string;
        cmd: string;
        roles: string[];
        same_qual: boolean;
        same_check: boolean;
      }[]
    >`
      select p.schemaname || '.' || p.tablename as t, p.policyname as name, p.cmd,
             p.roles::text[] as roles,
             p.qual is not distinct from r.qual as same_qual,
             p.with_check is not distinct from r.qual as same_check
        from pg_policies p
        left join pg_policies r on r.schemaname = p.schemaname and r.tablename = p.tablename
             and r.cmd = 'SELECT' and ${VIEWER}::name = any(r.roles)
       where ${WRITER}::name = any(p.roles) and p.cmd <> 'SELECT'
       order by 1, 2`;
    const want = WRITE_ROLE_TABLES.flatMap((t) =>
      ['delete', 'insert', 'update'].map((op) => `${t}.${t.split('.')[1]}_write_${op}`),
    ).sort();
    expect(rows.map((r) => `${r.t}.${r.name}`)).toEqual(want);
    for (const r of rows) {
      expect(r.roles, r.name).toEqual([WRITER]);
      if (r.cmd === 'INSERT') expect([r.same_check, r.name]).toEqual([true, r.name]);
      if (r.cmd === 'UPDATE')
        expect([r.same_qual, r.same_check, r.name]).toEqual([true, true, r.name]);
      if (r.cmd === 'DELETE') expect([r.same_qual, r.name]).toEqual([true, r.name]);
    }
    // The tables with no read rule: no rule for the write role at all.
    const none = await sql<{ t: string }[]>`
      select schemaname || '.' || tablename || '.' || policyname as t from pg_policies
       where ${WRITER}::name = any(roles)
         and schemaname || '.' || tablename = any(${WRITE_ROLE_SYSTEM_ONLY as string[]}::text[])`;
    expect(none.map((r) => r.t)).toEqual([]);
  });

  it('the matrix splits the content tables in two: 17 write tables, 9 system only', () => {
    expect([...WRITE_ROLE_TABLES, ...WRITE_ROLE_SYSTEM_ONLY].sort()).toEqual(
      [...contentTables].sort(),
    );
    // 12 since A2b2a; A3a moved the Recall tables, shares and node_snapshots.
    expect(WRITE_ROLE_TABLES).toHaveLength(17);
    expect(WRITE_ROLE_SYSTEM_ONLY).toHaveLength(9);
  });

  it('a second sync changes nothing (no policy rewritten, so no table lock)', async () => {
    const before = await sql<{ oid: number }[]>`
      select oid::int as oid from pg_policy order by 1`;
    await syncWriteRoleRules(sql);
    const after = await sql<{ oid: number }[]>`select oid::int as oid from pg_policy order by 1`;
    expect(after).toEqual(before);
  });

  // ── Trigger functions ─────────────────────────────────────────────────────

  it('every trigger function on a content table is a definer, or runs as the caller for a reviewed reason', async () => {
    const rows = await sql<
      { fn: string; secdef: boolean; config: string[] | null; owner: string; src: string }[]
    >`
      select distinct p.proname as fn, p.prosecdef as secdef, p.proconfig as config,
             pg_get_userbyid(p.proowner) as owner, p.prosrc as src
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace s on s.oid = c.relnamespace
        join pg_proc p on p.oid = t.tgfoid
       where not t.tgisinternal
         and s.nspname || '.' || c.relname = any(${contentTables}::text[])
       order by 1`;
    const problems: string[] = [];
    const callerRights = new Set<string>();
    for (const r of rows) {
      if (r.secdef) {
        if (!(r.config ?? []).some((c) => c.startsWith('search_path='))) {
          problems.push(`${r.fn}: a definer with no search_path`);
        }
        if ([WRITER, VIEWER].includes(r.owner)) problems.push(`${r.fn}: owned by ${r.owner}`);
        if (r.fn in CALLER_RIGHTS) problems.push(`${r.fn}: on CALLER_RIGHTS but a definer`);
        continue;
      }
      callerRights.add(r.fn);
      if (!(r.fn in CALLER_RIGHTS)) problems.push(`${r.fn}: runs as the caller, not reviewed`);
    }
    // No stale entry.
    for (const fn of Object.keys(CALLER_RIGHTS)) {
      if (!callerRights.has(fn))
        problems.push(`${fn}: on CALLER_RIGHTS, not a caller-rights trigger`);
    }
    expect(problems).toEqual([]);
    for (const reason of Object.values(CALLER_RIGHTS)) expect(reason.length).toBeGreaterThan(10);
  });

  it('a caller-rights trigger function reads no table, takes no heads lock, and the write role may run what it calls', async () => {
    const procs = await sql<
      { fn: string; oid: number; secdef: boolean; src: string; ok: boolean }[]
    >`
      select p.proname as fn, p.oid::int as oid, p.prosecdef as secdef, p.prosrc as src,
             has_function_privilege(${WRITER}, p.oid, 'EXECUTE') as ok
        from pg_proc p where p.pronamespace = 'public'::regnamespace`;
    type Proc = (typeof procs)[number];
    const byName = new Map<string, Proc[]>();
    for (const p of procs) byName.set(p.fn, [...(byName.get(p.fn) ?? []), p]);
    const problems: string[] = [];
    const CALL = /(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/g;
    for (const root of Object.keys(CALLER_RIGHTS)) {
      // The function and every caller-rights function it reaches.
      const seen = new Set<string>();
      const queue = [root];
      while (queue.length > 0) {
        const fn = queue.shift()!;
        if (seen.has(fn)) continue;
        seen.add(fn);
        for (const p of byName.get(fn) ?? []) {
          const body = code(p.src);
          for (const t of tablesIn(body)) {
            problems.push(`${root} -> ${fn}: touches a table (${t})`);
          }
          if (/mantle_lock_heads|heads_held/.test(body)) {
            problems.push(`${root} -> ${fn}: takes or reads the heads`);
          }
          for (const m of body.matchAll(CALL)) {
            const callee = m[1]!;
            const defs = byName.get(callee);
            if (!defs || callee === fn) continue;
            if (!defs.some((d) => d.ok))
              problems.push(`${root} -> ${callee}: no EXECUTE for ${WRITER}`);
            if (defs.some((d) => !d.secdef)) queue.push(callee);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every definer function the write role may run is reviewed; none is a heads signer', async () => {
    const rows = await sql<{ fn: string }[]>`
      select p.oid::regprocedure::text as fn from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prosecdef
         and has_function_privilege(${WRITER}, p.oid, 'EXECUTE')
       order by 1`;
    expect(rows.map((r) => r.fn).sort()).toEqual(Object.keys(DEFINERS_THE_WRITE_ROLE_RUNS).sort());
    // Every extra right of the write role is on the reviewed list.
    for (const fn of Object.keys(WRITE_ROLE_FUNCTIONS)) {
      expect(Object.keys(DEFINERS_THE_WRITE_ROLE_RUNS), fn).toContain(fn.replace(/^public\./, ''));
    }
  });

  it('no rule on a write table is open to PUBLIC', async () => {
    const rows = await sql<{ t: string }[]>`
      select schemaname || '.' || tablename || '.' || policyname as t from pg_policies
       where 'public' = any(roles)
         and schemaname || '.' || tablename = any(${WRITE_ROLE_TABLES as string[]}::text[])`;
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it('the write checks on the live tables are the matrix', async () => {
    const rows = await sql<{ t: string; args: string }[]>`
      select n.nspname || '.' || c.relname as t,
             array_to_string(array_remove(string_to_array(encode(tg.tgargs, 'escape'), '\\000'), ''), ',') as args
        from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where tg.tgname = 'mantle_write_check' order by 1`;
    const want = ACCESS_MATRIX.filter((t) => writeCheckArgs(t))
      .map((t) => ({ t: t.table, args: writeCheckArgs(t)!.join(',') }))
      .sort((a, b) => a.t.localeCompare(b.t));
    expect(rows.map((r) => ({ t: r.t, args: r.args }))).toEqual(want);
    // Every item column is a foreign key to the items.
    for (const t of ACCESS_MATRIX) {
      if (!t.writeCheck || t.writeCheck.kind === 'self') continue;
      const [fk] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
         where c.contype = 'f' and c.conrelid = ${t.table}::regclass
           and c.confrelid = 'public.nodes'::regclass and a.attname = ${t.writeCheck.item}`;
      expect(fk!.n, `${t.table}.${t.writeCheck.item}`).toBe(1);
    }
    // A write table with no check (neither the write check nor A3a's) is
    // read in an Admin scope only.
    for (const t of ACCESS_MATRIX.filter(
      (x) => writeRoleWrites(x) && !x.writeCheck && !x.editCheck,
    )) {
      const [rule] = await sql<{ qual: string }[]>`
        select qual from pg_policies where schemaname || '.' || tablename = ${t.table}
           and cmd = 'SELECT' and 'mantle_view_user' = any(roles)`;
      expect(rule!.qual, t.table).toBe(
        '( SELECT mantle_scope_is_admin() AS mantle_scope_is_admin)',
      );
    }
  });

  // ── Cells, as a login of the write role ───────────────────────────────────

  type Kind = {
    name: string;
    actor: string;
    ws: () => string[];
    mod: () => string[];
    login: string;
  };
  const kinds: Kind[] = [
    {
      name: 'login(rw)',
      actor: `login:rw:${L.mem}`,
      ws: () => [ws.H, ws.E],
      mod: () => [],
      login: L.mem,
    },
    {
      name: 'login(owner)',
      actor: `login:owner:${L.owner}`,
      ws: () => [ws.admin],
      mod: () => [ws.admin],
      login: L.owner,
    },
    {
      name: 'assistant',
      actor: 'assistant:none',
      ws: () => [ws.H],
      mod: () => [],
      login: '',
    },
    { name: 'link', actor: 'link', ws: () => [ws.H], mod: () => [], login: '' },
    { name: 'contact', actor: 'contact:rw', ws: () => [ws.H], mod: () => [], login: '' },
    {
      name: 'login(rw) outsider',
      actor: `login:rw:${L.out}`,
      ws: () => [ws.O],
      mod: () => [ws.O],
      login: L.out,
    },
  ];

  /** Run `fn` in a transaction on the write role as `k`, the actor check
   *  on, then roll back. Returns fn's value, or the error's code. */
  async function asKind<T>(
    k: Kind,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    createWs = '',
    privateWs = '',
  ): Promise<{ value?: T; code?: string; message?: string }> {
    let out: { value?: T; code?: string; message?: string } = {};
    try {
      await w.begin(async (tx) => {
        await tx`select set_config('mantle.actor', ${k.actor}, true),
                        set_config('mantle.write_mode', 'rw', true),
                        set_config('mantle.actor_check', 'on', true),
                        set_config('mantle.ws', ${`{${k.ws().join(',')}}`}, true),
                        set_config('mantle.mod_ws', ${`{${k.mod().join(',')}}`}, true),
                        set_config('mantle.login_id', ${k.login}, true),
                        set_config('mantle.create_ws', ${createWs}, true),
                        set_config('mantle.private_ws', ${privateWs}, true)`;
        try {
          out = { value: await fn(tx) };
        } catch (err) {
          const e = err as { code?: string; message?: string };
          out = { code: e.code ?? '?', message: e.message };
        }
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return out;
  }

  const reads = (k: Kind, id: string) =>
    id === n.n2 ? k.ws().includes(ws.O) : k.ws().some((x) => x === ws.H || x === ws.E);
  /** n1: home H, Write to E. n2: home O. Edit = a Moderator of the home or
   *  a workspace with Write in the scope. */
  const edits = (k: Kind, id: string) =>
    id === n.n2 ? k.mod().includes(ws.O) : k.mod().includes(ws.H) || k.ws().includes(ws.E);

  it('the role is a real login: session_user is the write role, it cannot bypass row rules', async () => {
    const [who] = await w<{ s: string; c: string; bypass: boolean }[]>`
      select session_user as s, current_user as c,
             (select rolbypassrls from pg_roles where rolname = session_user) as bypass`;
    expect(who).toEqual({ s: WRITER, c: WRITER, bypass: false });
  });

  it('no role holds an INHERIT membership in the write role (fix round 2, L4)', async () => {
    // The write check fires WHEN current_user is the write role: a role that
    // inherited its rights would write as itself, past the check. The pool's
    // per-database login is SET only (viewer-roles.ts). Cluster wide: roles
    // are cluster objects.
    const [v] = await sql<{ n: number }[]>`
      select current_setting('server_version_num')::int as n`;
    const rows =
      v!.n >= 160000
        ? await sql<{ r: string }[]>`
            select u.rolname as r from pg_auth_members m join pg_roles u on u.oid = m.member
             where m.roleid = ${WRITER}::regrole and m.inherit_option order by 1`
        : await sql<{ r: string }[]>`
            select u.rolname as r from pg_auth_members m join pg_roles u on u.oid = m.member
             where m.roleid = ${WRITER}::regrole and u.rolinherit order by 1`;
    expect(rows.map((r) => r.r)).toEqual([]);
  });

  it.each(kinds.map((k) => [k.name, k] as const))(
    '%s: UPDATE writes a row it may edit; a row it only reads is refused; an unreadable row matches nothing, RETURNING too',
    async (_name, k) => {
      for (const id of [n.n1, n.n2]) {
        const r = await asKind(k, async (tx) => {
          await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
          return tx<{ title: string }[]>`
            update nodes set title = title || '.' where id = ${id} returning title`;
        });
        const label = `${k.name} ${id === n.n1 ? 'n1' : 'n2'}: ${r.message}`;
        if (reads(k, id) && !edits(k, id)) {
          expect(r.code, label).toBe('42501');
          expect(r.message).toMatch(/not allowed to edit this item/);
        } else {
          expect(r.code, label).toBeUndefined();
          expect(r.value!.length).toBe(reads(k, id) ? 1 : 0);
        }
      }
    },
  );

  it.each(kinds.map((k) => [k.name, k] as const))(
    '%s: DELETE of an unreadable row matches nothing',
    async (_name, k) => {
      const target = k.ws().includes(ws.O) ? n.n1 : n.n2;
      const r = await asKind(k, async (tx) => {
        await tx`select mantle_lock_heads(array[${target}]::uuid[], 'update')`;
        return tx`delete from nodes where id = ${target} returning id`;
      });
      expect(r.code, r.message).toBeUndefined();
      expect(r.value!.length).toBe(0);
    },
  );

  it.each(kinds.map((k) => [k.name, k] as const))(
    '%s: a row cannot be moved to an item the scope cannot read',
    async (_name, k) => {
      const [from, to] = k.ws().includes(ws.O) ? [n.n2, n.n1] : [n.n1, n.n2];
      const r = await asKind(k, async (tx) => {
        await tx`select mantle_lock_heads(array[${from}, ${to}]::uuid[], 'update')`;
        return tx`update pages set node_id = ${to} where node_id = ${from} returning node_id`;
      });
      if (reads(k, from)) {
        expect([r.code, k.name]).toEqual(['42501', k.name]);
        // The write check (no edit) or the row rule (the target unreadable).
        expect(r.message).toMatch(/row-level security|not allowed to change this item/);
      } else {
        expect(r.code, r.message).toBeUndefined();
        expect(r.value!.length).toBe(0);
      }
    },
  );

  it.each(kinds.map((k) => [k.name, k] as const))(
    '%s: a fact or a page for an item the scope cannot read is refused',
    async (_name, k) => {
      const other = k.ws().includes(ws.O) ? n.n1 : n.n2;
      const fact = await asKind(
        k,
        (tx) =>
          tx`insert into facts (owner_id, kind, content, source_node_id)
           values (${L.owner}, 'factual', 'x', ${other})`,
      );
      expect([fact.code, k.name]).toEqual(['42501', k.name]);
      const page = await asKind(k, async (tx) => {
        await tx`select mantle_lock_heads(array[${other}]::uuid[], 'update')`;
        return tx`update pages set doc_text = 'x' where node_id = ${other} returning node_id`;
      });
      expect(page.value?.length ?? -1, `${k.name}: ${page.message}`).toBe(0);
    },
  );

  it('a grant cannot be moved to a workspace the scope cannot read', async () => {
    const r = await asKind(kinds[0]!, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update item_grants set workspace_id = ${ws.O}
                 where node_id = ${n.n1} and workspace_id = ${ws.E} returning node_id`;
    });
    expect(r.code, r.message).toBe('42501');
  });

  /** A new note in `path` (its folder's head shared first). */
  const newNote =
    (path: string, folder: () => string) =>
    async (tx: postgres.TransactionSql): Promise<{ home: string }[]> => {
      await tx`select mantle_lock_heads(array[${folder()}]::uuid[], 'share')`;
      return tx<{ home: string }[]>`
        insert into nodes (owner_id, type, title, path)
        values (${L.owner}, 'note', ${`${tag} new`}, ${path}::ltree)
        returning home_ws::text as home`;
    };

  it.each(kinds.filter((k) => k.ws().length > 0).map((k) => [k.name, k] as const))(
    '%s: a new item lands in a workspace it moderates; one it only reads, or one outside its scope, is refused (fix round 2, M-a)',
    async (_name, k) => {
      const insert = newNote('notes', () => n.root);
      const home = k.ws()[0]!;
      const r = await asKind(k, insert, home);
      if (k.mod().includes(home)) {
        expect(r.code, `${k.name}: ${r.message}`).toBeUndefined();
        expect(r.value![0]!.home).toBe(home);
      } else {
        expect([r.code, k.name]).toEqual(['42501', k.name]);
        expect(r.message).toMatch(/not allowed to create an item in that workspace/);
      }
      const outside = k.ws().includes(ws.O) ? ws.H : ws.O;
      const out = await asKind(k, insert, outside);
      expect([out.code, k.name]).toEqual(['42501', k.name]);
    },
  );

  it("a new item in a folder the scope may edit takes the folder's home; a reader of the folder is refused", async () => {
    const insert = newNote(`notes.${tag}f`, () => n.f);
    // E has Write on F (home H): the item lands in H, no Moderator seat.
    const editor = await asKind(member(), insert);
    expect(editor.code, editor.message).toBeUndefined();
    expect(editor.value![0]!.home).toBe(ws.H);
    // Naming F's home as the create home is the same.
    const named = await asKind(member(), insert, ws.H);
    expect(named.code, named.message).toBeUndefined();
    expect(named.value![0]!.home).toBe(ws.H);
    // H only reads F.
    const reader = await asKind({ ...member(), name: 'H only', ws: () => [ws.H] }, insert);
    expect(reader.code, reader.message).toBe('42501');
  });

  it("a login's own private workspace takes its creates (it moderates it)", async () => {
    // The root folder's home is Admin, which the member may not edit: the
    // item lands in its private workspace.
    const own: Kind = { ...member(), ws: () => [ws.H, ws.E, ws.P], mod: () => [ws.P] };
    const r = await asKind(
      own,
      newNote('notes', () => n.root),
      '',
      ws.P,
    );
    expect(r.code, r.message).toBeUndefined();
    expect(r.value![0]!.home).toBe(ws.P);
    // Another login's private workspace as its own: no Moderator seat.
    const other = await asKind(
      member(),
      newNote('notes', () => n.root),
      '',
      ws.P,
    );
    expect(other.code, other.message).toBe('42501');
  });

  // ── The guards, on the write role ─────────────────────────────────────────

  it('the ACL guard refuses a derived column, even with a bare SET mantle.acl_internal', async () => {
    const r = await asKind(kinds[0]!, async (tx) => {
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update nodes set read_ws = read_ws || ${ws.O}::uuid where id = ${n.n1}`;
    });
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/derived from item_grants/);
  });

  it("the login guard refuses an item's login set to another login", async () => {
    const r = await asKind(kinds[0]!, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update nodes set login_id = ${L.out} where id = ${n.n1}`;
    });
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/login can only be your own/);
  });

  it("the follow guard refuses a fact's read_ws, even with a bare SET mantle.acl_internal", async () => {
    const [f] = await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      return tx<{ id: string }[]>`
        insert into facts (owner_id, kind, content, source_node_id)
        values (${L.owner}, 'factual', ${`${tag} follow`}, ${n.n1}) returning id::text as id`;
    });
    const r = await asKind(kinds[0]!, async (tx) => {
      await tx`select set_config('mantle.acl_internal', 'on', true)`;
      return tx`update facts set read_ws = '{}' where id = ${f!.id}`;
    });
    expect(r.code).toBe('42501');
    expect(r.message).toMatch(/follow their node/);
  });

  // ── Delete: manage of the home, and the reap as the owner ─────────────────

  it('a delete needs manage of the home (0266, on); a Moderator deletes and the reap takes what it cannot read', async () => {
    const member = kinds[0]!;
    const refused = await asKind(member, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n3}]::uuid[], 'update')`;
      return tx`delete from nodes where id = ${n.n3}`;
    });
    expect(refused.code, refused.message).toBe('42501');

    // A fact and an edge of n3 the Moderator's scope cannot read (entity
    // edges: an Admin scope only).
    const entity = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:test', true)`;
      await tx`insert into facts (owner_id, kind, content, source_node_id)
               values (${L.owner}, 'episodic', ${`${tag} reap`}, ${n.n3})`;
      await tx`insert into entity_edges (owner_id, source_kind, source_id, target_kind, target_id, relation)
               values (${L.owner}, 'node', ${n.n3}, 'entity', ${entity}, 'mentions')`;
    });
    const moderator: Kind = {
      name: 'login(rw) moderator',
      actor: `login:rw:${L.mod}`,
      ws: () => [ws.H],
      mod: () => [ws.H],
      login: L.mod,
    };
    // Committed: the reap is checked from outside the role.
    await w.begin(async (tx) => {
      await tx`select set_config('mantle.actor', ${moderator.actor}, true),
                      set_config('mantle.write_mode', 'rw', true),
                      set_config('mantle.actor_check', 'on', true),
                      set_config('mantle.ws', ${`{${ws.H}}`}, true),
                      set_config('mantle.mod_ws', ${`{${ws.H}}`}, true),
                      set_config('mantle.login_id', ${L.mod}, true)`;
      const [edges] = await tx<{ n: number }[]>`
        select count(*)::int as n from entity_edges where source_id = ${n.n3}`;
      expect(edges!.n, 'the Moderator cannot read the edge').toBe(0);
      await tx`select mantle_lock_heads(array[${n.n3}]::uuid[], 'update')`;
      const gone = await tx`delete from nodes where id = ${n.n3} returning id`;
      expect(gone.length).toBe(1);
    });
    const [left] = await sql<{ facts: number; edges: number }[]>`
      select (select count(*)::int from facts where source_node_id = ${n.n3}) as facts,
             (select count(*)::int from entity_edges where source_id = ${n.n3}) as edges`;
    expect(left).toEqual({ facts: 0, edges: 0 });
  });

  // ── Edit and manage on the write role (audit H1, M1) ──────────────────────

  const member = () => kinds[0]!;
  const moderator = (): Kind => ({
    name: 'login(rw) moderator',
    actor: `login:rw:${L.mod}`,
    ws: () => [ws.H, ws.M],
    mod: () => [ws.H, ws.M],
    login: L.mod,
  });

  it('the fixture: n5 is read through M, its folder is edited through E, n5 is not', async () => {
    const [r] = await sql<{ read: string[]; write: string[]; fwrite: string[] }[]>`
      select n5.read_ws::text[] as read, n5.write_ws::text[] as write, f.write_ws::text[] as fwrite
        from nodes n5, nodes f where n5.id = ${n.n5} and f.id = ${n.f}`;
    expect(r!.read).toContain(ws.M);
    expect(r!.read).not.toContain(ws.E);
    expect(r!.write).toEqual([]);
    expect(r!.fwrite).toContain(ws.E);
  });

  it('a rank change needs edit of the item or of its folder; any other change edit of the item', async () => {
    const reader: Kind = { ...member(), name: 'E and M', ws: () => [ws.E, ws.M] };
    const rank = await asKind(reader, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n5}]::uuid[], 'update')`;
      return tx`update nodes set data = coalesce(data, '{}'::jsonb) || '{"rank":"a0"}'::jsonb
                 where id = ${n.n5} returning id`;
    });
    expect(rank.code, rank.message).toBeUndefined();
    expect(rank.value!.length).toBe(1);
    const title = await asKind(reader, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n5}]::uuid[], 'update')`;
      return tx`update nodes set title = 'x' where id = ${n.n5}`;
    });
    expect(title.code).toBe('42501');
    const both = await asKind(reader, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n5}]::uuid[], 'update')`;
      return tx`update nodes set title = 'x', data = coalesce(data, '{}'::jsonb) || '{"rank":"a1"}'::jsonb
                 where id = ${n.n5}`;
    });
    expect(both.code).toBe('42501');
  });

  it('a page of an item the scope only reads cannot be written', async () => {
    const reader: Kind = { ...member(), name: 'H only', ws: () => [ws.H] };
    const r = await asKind(reader, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update pages set doc_text = 'x' where node_id = ${n.n1}`;
    });
    expect(r.code, r.message).toBe('42501');
    const ok = await asKind(member(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update pages set doc_text = 'x' where node_id = ${n.n1} returning node_id`;
    });
    expect(ok.code, ok.message).toBeUndefined();
    expect(ok.value!.length).toBe(1);
  });

  it('a grant needs manage of the home: a member cannot give itself Write (H1 B)', async () => {
    const flip = async (k: Kind) =>
      asKind(k, async (tx) => {
        await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
        return tx`update item_grants set write = true
                   where node_id = ${n.n1} and workspace_id = ${ws.H} returning node_id`;
      });
    const mem = await flip(member());
    expect(mem.code, mem.message).toBe('42501');
    const mod = await flip(moderator());
    expect(mod.code, mod.message).toBeUndefined();
  });

  it('a new grant needs a Moderator of its workspace too', async () => {
    const add = async (target: () => string) =>
      asKind(moderator(), async (tx) => {
        await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
        return tx`insert into item_grants (node_id, workspace_id, is_home, write)
                  values (${n.n1}, ${target()}, false, false) returning node_id`;
      });
    const toO = await add(() => ws.O);
    expect(toO.code, toO.message).toBe('42501');
    const toM = await add(() => ws.M);
    expect(toM.code, toM.message).toBeUndefined();
    expect(toM.value!.length).toBe(1);
  });

  it('a home moves only to a workspace the caller moderates (fix round 2, M-b)', async () => {
    // The audit's case: a Moderator of H who sits in E (so it reads E's
    // row: a grant row is read through its workspace) makes E's row the
    // home in one statement. Refused whichever row the update meets first.
    const inE: Kind = { ...moderator(), ws: () => [ws.H, ws.E, ws.M] };
    const swap = await asKind(inE, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update item_grants set is_home = (workspace_id = ${ws.E})
                 where node_id = ${n.n1} and workspace_id in (${ws.H}, ${ws.E})`;
    });
    expect(swap.code, swap.message).toBe('42501');
    expect(swap.message).toMatch(/not allowed to grant to that workspace/);
    // The flip alone, in an Admin scope (so the item with no home between
    // the two statements may still be managed) that reads E's row: refused
    // without a Moderator seat in E, allowed with one.
    const flip = (mod: () => string[]) =>
      asKind({ ...moderator(), ws: () => [ws.admin, ws.H, ws.E], mod }, async (tx) => {
        await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
        await tx`update item_grants set is_home = false
                    where node_id = ${n.n1} and workspace_id = ${ws.H}`;
        return tx`update item_grants set is_home = true
                     where node_id = ${n.n1} and workspace_id = ${ws.E} returning node_id`;
      });
    const notE = await flip(() => [ws.H]);
    expect(notE.code, notE.message).toBe('42501');
    expect(notE.message).toMatch(/not allowed to grant to that workspace/);
    const modE = await flip(() => [ws.H, ws.E]);
    expect(modE.code, modE.message).toBeUndefined();
    expect(modE.value!.length).toBe(1);
  });

  it("a grant's folder (via_folder_id) is not the role's to write (fix round 2, M-b)", async () => {
    const upd = await asKind(moderator(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update item_grants set via_folder_id = ${n.f}
                 where node_id = ${n.n1} and workspace_id = ${ws.E}`;
    });
    expect(upd.code, upd.message).toBe('42501');
    expect(upd.message).toMatch(/permission denied/);
    const ins = await asKind(moderator(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`insert into item_grants (node_id, workspace_id, is_home, write, via_folder_id)
                values (${n.n1}, ${ws.M}, false, false, ${n.f})`;
    });
    expect(ins.code, ins.message).toBe('42501');
    expect(ins.message).toMatch(/permission denied/);
  });

  it('the kind of an item does not change on the role, even with edit (fix round 2, L2)', async () => {
    const r = await asKind(member(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update nodes set type = 'page' where id = ${n.n1}`;
    });
    expect(r.code, r.message).toBe('42501');
    expect(r.message).toMatch(/not allowed to change the kind of this item/);
    // The same member edits n1 otherwise.
    const title = await asKind(member(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return tx`update nodes set title = title where id = ${n.n1} returning id`;
    });
    expect(title.code, title.message).toBeUndefined();
    expect(title.value!.length).toBe(1);
  });

  it('the move check refuses on the role in warn too, as on the system pool (A2b2b, 0279; was staged in A2b2a)', async () => {
    const move = async (tx: postgres.TransactionSql) => {
      await tx`select mantle_lock_heads(array[${n.n1}, ${n.f}]::uuid[], 'update')`;
      return tx`update nodes set path = ${`notes.${tag}f`}::ltree where id = ${n.n1} returning id`;
    };
    // The member edits n1 (Write through E) and F, but does not manage n1.
    const on = await asKind(member(), move);
    expect(on.code, on.message).toBe('42501');
    expect(on.message).toMatch(/not allowed to move this item/);
    // In warn the role refuses it as well: the app holds no move check of
    // its own for every case (W6a M1), so the database's stays.
    const notices: string[] = [];
    const wn = postgres(
      viewerDatabaseUrl(scratch!.url, 'write', viewerRolePassword(testKey, 'write')),
      { max: 1, prepare: false, onnotice: (m) => notices.push(String(m.message ?? '')) },
    );
    try {
      await expect(
        wn.begin(async (tx) => {
          await tx`select set_config('mantle.actor', ${`login:rw:${L.mem}`}, true),
                          set_config('mantle.actor_check', 'warn', true),
                          set_config('mantle.ws', ${`{${ws.H},${ws.E}}`}, true),
                          set_config('mantle.mod_ws', '{}', true),
                          set_config('mantle.login_id', ${L.mem}, true)`;
          return move(tx);
        }),
      ).rejects.toMatchObject({ code: '42501', message: 'not allowed to move this item' });
    } finally {
      await wn.end();
    }
    expect(
      notices.filter((m) => m.startsWith('mantle actor miss: UPDATE on nodes: a move')),
    ).toEqual([]);
    // The system pool with a scope (an Admin user's request): refused.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                        set_config('mantle.ws', ${`{${ws.H},${ws.E}}`}, true),
                        set_config('mantle.mod_ws', '{}', true)`;
        return move(tx);
      }),
    ).rejects.toMatchObject({ code: '42501', message: 'not allowed to move this item' });
  });

  it('the home grant: a member cannot delete it; with no home, only an Admin scope deletes the item (H1 C)', async () => {
    const dropHome = (tx: postgres.TransactionSql) =>
      tx`delete from item_grants where node_id = ${n.n1} and is_home returning node_id`;
    const mem = await asKind(member(), async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      return dropHome(tx);
    });
    expect(mem.code, mem.message).toBe('42501');
    // A Moderator of H who also reads n1 through E: it still reads n1 when
    // the home is gone.
    const modE: Kind = { ...moderator(), ws: () => [ws.H, ws.E, ws.M] };
    let homeAfter: string | null | undefined;
    const mod = await asKind(modE, async (tx) => {
      await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
      const gone = await dropHome(tx);
      expect(gone.length).toBe(1);
      const [home] = await tx<{ home: string | null }[]>`
        select home_ws::text as home from nodes where id = ${n.n1}`;
      homeAfter = home?.home;
      return tx`delete from nodes where id = ${n.n1} returning id`;
    });
    expect(homeAfter).toBeNull();
    expect(mod.code, mod.message).toBe('42501');
    expect(mod.message).toMatch(/not allowed to delete this item/);
  });

  it("a fact with no item stays inside the scope and is the caller's own (M1; fix round 2, L5)", async () => {
    const add = (read: () => string[], login: string | null) =>
      asKind(
        member(),
        (tx) =>
          tx`insert into facts (owner_id, kind, content, read_ws, login_id)
           values (${L.owner}, 'factual', ${`${tag} free`}, ${`{${read().join(',')}}`}::uuid[], ${login})
           returning id`,
      );
    // No login: the system's (the extractor writes those on the system pool).
    const noLogin = await add(() => [ws.H], null);
    expect(noLogin.code, noLogin.message).toBe('42501');
    const own = await add(() => [ws.H], L.mem);
    expect(own.code, own.message).toBeUndefined();
    const planted = await add(() => [ws.H, ws.O], null);
    expect(planted.code, planted.message).toBe('42501');
    const someoneElse = await add(() => [ws.H], L.out);
    expect(someoneElse.code, someoneElse.message).toBe('42501');
  });

  it('off and warn report a refusal and let the write run; the system pool is never checked (fix round 2, L1)', async () => {
    // Off: no write runs on the role while the box is off (the write pool is
    // A2b2b's, used only in warn and on), so one that does is stray and
    // shows as a miss. The scratch database's box mode is off.
    for (const mode of ['off', 'warn'] as const) {
      const notices: string[] = [];
      const wn = postgres(
        viewerDatabaseUrl(scratch!.url, 'write', viewerRolePassword(testKey, 'write')),
        {
          max: 1,
          prepare: false,
          onnotice: (m) => notices.push(String(m.message ?? '')),
        },
      );
      try {
        await wn
          .begin(async (tx) => {
            await tx`select set_config('mantle.actor', 'assistant:none', true),
                            set_config('mantle.actor_check', ${mode}, true),
                            set_config('mantle.ws', ${`{${ws.H}}`}, true),
                            set_config('mantle.mod_ws', '{}', true)`;
            const [m] = await tx<{ m: string }[]>`select mantle_actor_check_mode() as m`;
            expect(m!.m).toBe(mode);
            await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
            const done = await tx`update nodes set title = title where id = ${n.n1} returning id`;
            expect(done.length).toBe(1);
            throw new Rollback();
          })
          .catch((err: unknown) => {
            if (!(err instanceof Rollback)) throw err;
          });
      } finally {
        await wn.end();
      }
      expect(
        notices.some((m) => /mantle actor miss: UPDATE on nodes: no edit of the item/.test(m)),
        mode,
      ).toBe(true);
    }
    // The system pool with the same scope: no check, no notice.
    await sql
      .begin(async (tx) => {
        await tx`select set_config('mantle.actor', 'system:test', true),
                        set_config('mantle.actor_check', 'on', true),
                        set_config('mantle.ws', ${`{${ws.H}}`}, true),
                        set_config('mantle.mod_ws', '{}', true)`;
        await tx`select mantle_lock_heads(array[${n.n1}]::uuid[], 'update')`;
        const done = await tx`update nodes set title = title where id = ${n.n1} returning id`;
        expect(done.length).toBe(1);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  });
});
