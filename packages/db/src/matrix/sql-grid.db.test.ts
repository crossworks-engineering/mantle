/**
 * The access grid at SQL level (workspaces arch plan v2, section 12 A8; the
 * first slice, A1): read and create, for six logins (the owner, an Admin
 * user, the home Moderator, a Write-grant user, a read-grant user, an
 * outsider) × every workspace kind × in a folder or not, against the oracle
 * (./oracle.ts, written from docs/workspaces.md alone).
 *
 * Each cell runs in ONE transaction that is rolled back, so no cell sees
 * another's effect. A cell passes only on the right row effect:
 *  - read: the item's row is visible on the workspace role
 *    (mantle_view_user) in the login's scope, or it is not;
 *  - create: the row is made with the home the oracle names (and, in a
 *    folder, the folder's grants), or the insert is refused with 42501.
 * Any other error is a failure, never a deny. Cells the oracle does not
 * cover are counted ('n/a').
 *
 * The create runs as the app's system transactions run it (client.ts,
 * withSystemTx): the heads lock, the login's write scope (mantle.ws,
 * mantle.mod_ws) and its create home (mantle.private_ws for a login outside
 * Admin), no current workspace named.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/matrix/sql-grid.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { createMigratedScratchDatabase } from '../test-support';
import {
  ORACLE_ROLES,
  expectedAccess,
  guideWorkspaceKinds,
  type OracleAction,
  type OraclePlacement,
  type OracleRole,
} from './oracle';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

type Scope = { ws: string; mod: string; login: string; priv: string };

describe.skipIf(!URL)('A8 SQL grid: read and create (A1 slice)', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  const tag = `a8${randomUUID().slice(0, 6)}`;
  const login: Record<OracleRole, string> = {
    owner: randomUUID(),
    admin: randomUUID(),
    homeModerator: randomUUID(),
    writeGrant: randomUUID(),
    readGrant: randomUUID(),
    outsider: randomUUID(),
  };
  const ws = { H: '', W: '', R: '', O: '', admin: '' };
  const scope = {} as Record<OracleRole, Scope>;
  /** Actor misses the item tables' write triggers reported (arch A2a). */
  const misses: string[] = [];
  /** Per kind: its root path, its folder F, the item at the root and the
   *  item in F (for branch: a top-level folder and a subfolder of F). */
  const fx: Record<
    string,
    {
      root: string;
      rootId: string;
      folder: string;
      folderPath: string;
      atRoot: string;
      inFolder: string;
    }
  > = {};

  /** The kinds the grid covers: the registry's workspace class, which the
   *  first test pins to the oracle's (the guide's) list. */
  const kinds = ITEM_KIND_NAMES.filter((t) => ITEM_KINDS[t].class === 'workspace');
  /** Where a kind's items sit. Folders (branch) live in the notes tree. */
  const rootOf = (kind: string): string => {
    if (kind === 'branch') return 'notes';
    const tree = (ITEM_KINDS as Record<string, { tree: { root: string } | null }>)[kind]!.tree;
    if (!tree) throw new Error(`no tree root for ${kind}`);
    return tree.root;
  };

  const grant = async (tx: postgres.TransactionSql, id: string) => {
    await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
    await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
    await tx`insert into item_grants (node_id, workspace_id, is_home, write) values
      (${id}, ${ws.H}, true, false), (${id}, ${ws.W}, false, true), (${id}, ${ws.R}, false, false)`;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    sql = postgres(scratch.url, {
      max: 2,
      prepare: false,
      onnotice: (n) => {
        if (String(n.message ?? '').startsWith('mantle actor miss: '))
          misses.push(String(n.message));
      },
    });
    const L = login;
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${L.owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${L.admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${L.homeModerator}, ${`${tag}-h@example.invalid`}, 'x', false, 'member', 'Home mod'),
      (${L.writeGrant}, ${`${tag}-w@example.invalid`}, 'x', false, 'member', 'Writer'),
      (${L.readGrant}, ${`${tag}-r@example.invalid`}, 'x', false, 'member', 'Reader'),
      (${L.outsider}, ${`${tag}-x@example.invalid`}, 'x', false, 'member', 'Outsider')`;
    await sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
      on conflict (id) do nothing`;
    await sql`select * from mantle_ws_migrate()`;
    ws.admin = (
      await sql<{ id: string }[]>`
      select id::text as id from workspaces where owner_id = ${L.owner} and is_admin`
    )[0]!.id;
    // The fixture's workspaces: H (the home), W (Write on), R (Write off), O.
    for (const [key, who, mod] of [
      ['H', L.homeModerator, true],
      ['W', L.writeGrant, false],
      ['R', L.readGrant, false],
      ['O', L.outsider, true],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        insert into workspaces (owner_id, name) values (${L.owner}, ${`${tag} ${key}`})
        returning id::text as id`;
      ws[key] = row!.id;
      await sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${row!.id}, ${who}, ${mod})`;
    }
    // The members' Team seats would not change a cell (nothing is granted to
    // Team); they are taken out so each scope is exactly the fixture's.
    await sql`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin
                 and u.login_id in (${L.homeModerator}, ${L.writeGrant}, ${L.readGrant}, ${L.outsider})`;
    // The admin user must be an Admin user: the switch seats admin rows.
    const adminSeat = await sql`select 1 from workspace_users
      where workspace_id = ${ws.admin} and login_id = ${L.admin}`;
    expect(adminSeat.length, 'the Admin user sits in Admin').toBe(1);
    for (const role of ORACLE_ROLES) {
      const id = L[role];
      const [s] = await sql<{ ws: string[]; mod: string[] }[]>`
        select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
               coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                        filter (where u.moderator), '{}') as mod
          from workspace_users u join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${id}`;
      const admin = s!.ws.includes(ws.admin);
      // A login outside Admin creates with its private workspace as the
      // fallback (resolveCreateHome); made now, as its first create would.
      const priv = admin
        ? ''
        : (
            await sql<{ ws: string }[]>`select mantle_ws_private_workspace(${id}::uuid)::text as ws`
          )[0]!.ws;
      scope[role] = {
        ws: `{${s!.ws.join(',')}}`,
        mod: `{${s!.mod.join(',')}}`,
        login: id,
        priv,
      };
    }
    // Per kind: its root folder, a folder F (home H, Write to W, read to R),
    // an item at the root with the same grants by hand, an item in F that
    // takes F's grants.
    for (const kind of kinds) {
      const root = rootOf(kind);
      if (!Object.values(fx).some((f) => f.root === root)) {
        await sql`insert into nodes (owner_id, type, title, path)
                  select ${L.owner}, 'branch', ${root}, ${root}::ltree
                   where not exists (select 1 from nodes where owner_id = ${L.owner}
                                       and type = 'branch' and path = ${root}::ltree)`;
      }
      const [rootRow] = await sql<{ id: string }[]>`
        select id::text as id from nodes
         where owner_id = ${L.owner} and type = 'branch' and path = ${root}::ltree`;
      const label = `${tag}${kind.replace(/_/g, '')}`;
      const folderPath = `${root}.${label}f`;
      const folder = randomUUID();
      const atRoot = randomUUID();
      const inFolder = randomUUID();
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${rootRow!.id}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${folder}, ${L.owner}, 'branch', ${`${tag} F ${kind}`}, ${folderPath}::ltree)`;
      });
      await sql.begin((tx) => grant(tx, folder));
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${rootRow!.id}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${atRoot}, ${L.owner}, ${kind}, ${`${tag} root ${kind}`},
                         ${kind === 'branch' ? `${root}.${label}top` : root}::ltree)`;
      });
      await sql.begin((tx) => grant(tx, atRoot));
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${folder}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${inFolder}, ${L.owner}, ${kind}, ${`${tag} in F ${kind}`},
                         ${kind === 'branch' ? `${folderPath}.${label}sub` : folderPath}::ltree)`;
      });
      fx[kind] = { root, rootId: rootRow!.id, folder, folderPath, atRoot, inFolder };
    }
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await scratch?.drop();
  });

  it("the registry's workspace class is the guide's list", () => {
    expect([...kinds].sort()).toEqual(guideWorkspaceKinds().sort());
  });

  it('the fixture: each item is homed in H and read by H, W and R, never Admin', async () => {
    for (const kind of kinds) {
      for (const id of [fx[kind]!.atRoot, fx[kind]!.inFolder]) {
        const [r] = await sql<{ home: string; read: string[]; write: string[] }[]>`
          select home_ws::text as home, read_ws::text[] as read, write_ws::text[] as write
            from nodes where id = ${id}`;
        expect(r!.home, kind).toBe(ws.H);
        expect([...r!.read].sort(), kind).toEqual([ws.H, ws.W, ws.R].sort());
        expect(r!.write, kind).toContain(ws.W);
        expect(r!.read, kind).not.toContain(ws.admin);
      }
    }
  });

  /** Run one cell; null when it matches the oracle, else why not. */
  async function cell(
    role: OracleRole,
    kind: string,
    placement: OraclePlacement,
    action: OracleAction,
  ): Promise<string | null | 'na'> {
    const want = expectedAccess({ surface: 'sql', placement }, role, kind, action);
    if ('na' in want) return 'na';
    const s = scope[role];
    const f = fx[kind]!;
    let got: { allow: boolean; home?: string; read?: string[] } | null = null;
    let failure: string | null = null;
    try {
      await sql.begin(async (tx) => {
        if (action === 'read') {
          await tx`set local role mantle_view_user`;
          await tx`select set_config('mantle.ws', ${s.ws}, true),
                          set_config('mantle.mod_ws', ${s.mod}, true),
                          set_config('mantle.login_id', ${s.login}, true)`;
          const id = placement === 'folder' ? f.inFolder : f.atRoot;
          const rows = await tx`select id from nodes where id = ${id}`;
          got = { allow: rows.length === 1 };
        } else {
          const parent = placement === 'folder' ? f.folder : f.rootId;
          const path =
            kind === 'branch'
              ? `${placement === 'folder' ? f.folderPath : f.root}.${tag}new`
              : placement === 'folder'
                ? f.folderPath
                : f.root;
          // The login's actor first, as the app's pool sets it (arch A2a:
          // with the transaction's first statement; it takes no transaction
          // id, so the heads below stay the first lock), with the actor
          // check in warn for this transaction.
          await tx`select mantle_set_actor(${`login:rw:${s.login}`}, 'rw', 'warn')`;
          await tx`select mantle_lock_heads(array[${parent}]::uuid[], 'share')`;
          await tx`select set_config('mantle.ws', ${s.ws}, true),
                          set_config('mantle.mod_ws', ${s.mod}, true),
                          set_config('mantle.create_ws', '', true),
                          set_config('mantle.private_ws', ${s.priv}, true)`;
          try {
            await tx`savepoint cell`;
            const [row] = await tx<{ home: string; read: string[] }[]>`
              insert into nodes (owner_id, type, title, path)
              values (${login.owner}, ${kind}, ${`${tag} new ${kind}`}, ${path}::ltree)
              returning home_ws::text as home, read_ws::text[] as read`;
            got = { allow: true, home: row!.home, read: row!.read };
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== '42501') {
              failure = `error ${code ?? '?'}: ${(err as Error).message.slice(0, 160)}`;
            } else {
              await tx`rollback to savepoint cell`;
              got = { allow: false };
            }
          }
        }
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) failure = `error: ${(err as Error).message.slice(0, 160)}`;
    }
    if (failure) return failure;
    const g = got as { allow: boolean; home?: string; read?: string[] } | null;
    if (!g) return 'no result';
    if (!want.allow) return g.allow ? 'allowed, the oracle denies' : null;
    if (!g.allow) return 'refused, the oracle allows';
    if (action === 'create') {
      const lands = want.lands === 'home' ? ws.H : want.lands === 'admin' ? ws.admin : s.priv;
      if (g.home !== lands) return `landed in ${g.home}, the oracle says ${want.lands} (${lands})`;
      // In a folder: the folder's grants pass on.
      if (placement === 'folder') {
        const read = [...(g.read ?? [])].sort();
        if (JSON.stringify(read) !== JSON.stringify([ws.H, ws.W, ws.R].sort())) {
          return `read by ${read.join(',')}, not the folder's H, W and R`;
        }
      }
    }
    return null;
  }

  it('every cell matches the oracle (row effects; a 500 or a generic error fails)', async () => {
    const failures: string[] = [];
    let cells = 0;
    let na = 0;
    let allowed = 0;
    let denied = 0;
    // The box in warn, as dev is: the actor check's triggers run only when
    // the box mode is not off (0277, A2b1 fix round 2 M1). The scratch
    // database is dropped after the file.
    await sql`select mantle_set_actor_check('warn')`;
    // The fixture's own writes (beforeAll, as an operator's psql would) are
    // not cells; the cells start with no miss.
    misses.length = 0;
    for (const role of ORACLE_ROLES) {
      for (const kind of kinds) {
        for (const placement of ['root', 'folder'] as const) {
          for (const action of ['read', 'create'] as const) {
            cells++;
            const r = await cell(role, kind, placement, action);
            if (r === 'na') na++;
            else if (r) failures.push(`${role} ${action} ${kind} @${placement}: ${r}`);
            else {
              const want = expectedAccess({ surface: 'sql', placement }, role, kind, action);
              if ('allow' in want && want.allow) allowed++;
              else denied++;
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Every create ran with its actor, in warn: zero misses (arch A2a).
    expect(misses).toEqual([]);
    // The control: the same write with no actor is a miss the grid sees.
    await sql
      .begin(async (tx) => {
        await tx`select set_config('mantle.actor_check', 'warn', true)`;
        await tx`update nodes set title = title where id = ${login.owner}`;
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    expect(misses).toEqual(['mantle actor miss: UPDATE on nodes']);
    // 6 logins × 11 kinds × 2 placements × 2 actions.
    expect(cells).toBe(6 * kinds.length * 2 * 2);
    expect(na, 'not-applicable cells').toBe(0);
    // Both answers are exercised: per kind and placement, read allows 3 of
    // 6 logins; a create at the root allows all 6, in a folder 2.
    expect(allowed).toBe(kinds.length * (3 * 2 + 6 + 2));
    expect(denied).toBe(kinds.length * (3 * 2 + 4));
  }, 240_000);
});
