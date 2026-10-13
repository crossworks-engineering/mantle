/**
 * The write grid at SQL level (workspaces arch plan v2, section 12 A3a, the
 * exit): for every workspace kind and write, as each actor kind, the
 * database refuses what the oracle refuses and allows what it allows
 * (./oracle.ts expectedWrite, written from docs/workspaces.md, docs/actors.md
 * and the owner's decisions D4 to D6).
 *
 * The box runs both checks on (mantle_set_edit_check('on') on this scratch
 * database, the actor check raised to on in each transaction): the test
 * needs no switch in production code. A login's write runs as the app's
 * login write gateway runs it: on a login of the write role
 * (mantle_write_user), with its scope, its actor and its write mode set in
 * the transaction, the heads taken first. A read-only actor (a read key, an
 * assistant with no user, a public link, a peer, a contact share without
 * Can write) runs the same way with write mode ro. System work runs on the
 * system pool (the superuser), as system(test).
 *
 * Each cell is ONE transaction, rolled back. A cell passes only on the
 * right row effect: allowed is exactly one row changed; refused is 42501
 * (or, for a row the scope cannot read, no row changed: "not found"). Any
 * other error is a failure, never a deny. Cells the oracle does not cover
 * are counted ('n/a').
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/db/src/matrix/write-grid.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { createMigratedScratchDatabase } from '../test-support';
import { viewerDatabaseUrl, viewerRolePassword } from '../viewer';
import {
  ORACLE_ACTORS,
  ORACLE_WRITE_ACTIONS,
  ORACLE_WRITE_ROLES,
  expectedRefusalDetail,
  expectedWrite,
  guideWorkspaceKinds,
  type OracleActor,
  type OraclePlacement,
  type OracleWriteAction,
  type OracleWriteRole,
} from './oracle';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

/** An embedding: a value only the brain sets. */
const VECTOR = `[${Array.from({ length: 768 }, () => '0.01').join(',')}]`;

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

type Scope = { ws: string; mod: string; login: string };

/** The mantle.actor value of a read-only actor kind (0275's format). */
function roActor(actor: OracleActor, login: string): string {
  switch (actor) {
    case 'login-ro':
      return `login:ro:${login}`;
    case 'assistant':
      return 'assistant:none';
    case 'link':
      return 'link';
    case 'peer':
      return 'peer:none';
    case 'contact-ro':
      return 'contact:ro';
    default:
      throw new Error(`not a read-only actor: ${actor}`);
  }
}

describe.skipIf(!URL)('A3a write grid: every workspace kind and write, as each actor kind', () => {
  let scratch: Awaited<ReturnType<typeof createMigratedScratchDatabase>> | undefined;
  let sql: ReturnType<typeof postgres>;
  let w: ReturnType<typeof postgres>;
  const testKey = process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key';
  const tag = `a3${randomUUID().slice(0, 6)}`;
  const login: Record<OracleWriteRole, string> = {
    owner: randomUUID(),
    admin: randomUUID(),
    homeModerator: randomUUID(),
    writeGrant: randomUUID(),
    readGrant: randomUUID(),
    outsider: randomUUID(),
    adminWriteGrant: randomUUID(),
    adminReadGrant: randomUUID(),
  };
  const ws = { H: '', W: '', R: '', O: '', admin: '' };
  const scope = {} as Record<OracleWriteRole, Scope>;
  /** Edit check misses (warn) and actor misses the triggers reported. */
  const misses: string[] = [];
  type Item = { id: string; path: string; folder: string | null; info?: string; bare?: string };
  const fx: Record<string, Record<OraclePlacement, Item>> = {};

  const kinds = ITEM_KIND_NAMES.filter((t) => ITEM_KINDS[t].class === 'workspace');
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

  /** One item of `kind` at `path` (the heads of `parent` taken), with the
   *  rows each write changes. */
  const makeItem = async (
    kind: string,
    parent: string,
    path: string,
    title: string,
    opts: { informational?: boolean; ownGrants?: boolean; bare?: boolean } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const O = login.owner;
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${parent}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${O}, ${kind}, ${title}, ${path}::ltree, '{"rank":"a0"}'::jsonb)`;
    });
    if (opts.ownGrants) await sql.begin((tx) => grant(tx, id));
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      if (kind === 'page') await tx`insert into pages (node_id) values (${id})`;
      if (kind === 'draw') await tx`insert into draws (node_id) values (${id})`;
      if (kind === 'table') await tx`insert into tables (node_id) values (${id})`;
      if (kind === 'app' && !opts.bare) {
        await tx`insert into apps (node_id, data_read_only) values (${id}, ${!!opts.informational})`;
        await tx`insert into app_databases (owner_id, app_node_id, storage_path)
                 values (${O}, ${id}, ${`/tmp/${id}.db`})`;
      }
      if (kind === 'app' || kind === 'table') {
        await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor)
                 values (${O}, ${id}, ${kind}, 1, 'manual', 'owner')`;
      }
      if (kind === 'recall') {
        await tx`insert into recall_maps (id, owner_id, slug, title, node_id)
                 values (${id}, ${O}, ${`${tag}-${id.slice(0, 8)}`}, ${title}, ${id})`;
        await tx`insert into recall_nodes (owner_id, map_id, slug, kind, title)
                 values (${O}, ${id}, 'card', 'card', 'A card')`;
      }
      await tx`insert into shares (token, owner_id, node_id, node_type)
               values (${`${tag}-${randomUUID()}`}, ${O}, ${id}, ${kind})`;
    });
    return id;
  };

  beforeAll(async () => {
    scratch = await createMigratedScratchDatabase(URL!);
    const onnotice = (n: { message?: string }) => {
      if (String(n.message ?? '').startsWith('mantle actor miss: ')) misses.push(String(n.message));
    };
    sql = postgres(scratch.url, { max: 2, prepare: false, onnotice });
    w = postgres(viewerDatabaseUrl(scratch.url, 'write', viewerRolePassword(testKey, 'write')), {
      max: 1,
      prepare: false,
      onnotice,
    });
    const L = login;
    await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name) values
      (${L.owner}, ${`${tag}-o@example.invalid`}, 'x', true, 'admin', 'Owner'),
      (${L.admin}, ${`${tag}-a@example.invalid`}, 'x', false, 'admin', 'Admin user'),
      (${L.adminWriteGrant}, ${`${tag}-aw@example.invalid`}, 'x', false, 'admin', 'Admin writer'),
      (${L.adminReadGrant}, ${`${tag}-ar@example.invalid`}, 'x', false, 'admin', 'Admin reader'),
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
    for (const [key, seats] of [
      ['H', [[L.homeModerator, true]]],
      [
        'W',
        [
          [L.writeGrant, false],
          [L.adminWriteGrant, false],
        ],
      ],
      [
        'R',
        [
          [L.readGrant, false],
          [L.adminReadGrant, false],
        ],
      ],
      ['O', [[L.outsider, true]]],
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
    // As the read grid: the members' Team seats would change no cell.
    await sql`delete from workspace_users u using workspaces w
               where w.id = u.workspace_id and w.name = 'Team' and not w.is_admin
                 and u.login_id in (${L.homeModerator}, ${L.writeGrant}, ${L.readGrant}, ${L.outsider})`;
    for (const who of [L.admin, L.adminWriteGrant, L.adminReadGrant]) {
      const seat = await sql`select 1 from workspace_users
        where workspace_id = ${ws.admin} and login_id = ${who}`;
      expect(seat.length, 'an Admin user sits in Admin').toBe(1);
    }
    for (const role of ORACLE_WRITE_ROLES) {
      const id = L[role];
      const [s] = await sql<{ ws: string[]; mod: string[] }[]>`
        select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
               coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                        filter (where u.moderator), '{}') as mod
          from workspace_users u join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${id}`;
      scope[role] = { ws: `{${s!.ws.join(',')}}`, mod: `{${s!.mod.join(',')}}`, login: id };
    }
    for (const kind of kinds) {
      const root = rootOf(kind);
      await sql`insert into nodes (owner_id, type, title, path)
                select ${L.owner}, 'branch', ${root}, ${root}::ltree
                 where not exists (select 1 from nodes where owner_id = ${L.owner}
                                     and type = 'branch' and path = ${root}::ltree)`;
      const [rootRow] = await sql<{ id: string }[]>`
        select id::text as id from nodes
         where owner_id = ${L.owner} and type = 'branch' and path = ${root}::ltree`;
      const label = `${tag}${kind.replace(/_/g, '')}`;
      const folderPath = `${root}.${label}f`;
      const folder = randomUUID();
      await sql.begin(async (tx) => {
        await tx`select mantle_lock_heads(array[${rootRow!.id}]::uuid[], 'share')`;
        await tx`insert into nodes (id, owner_id, type, title, path)
                 values (${folder}, ${L.owner}, 'branch', ${`${tag} F ${kind}`}, ${folderPath}::ltree)`;
      });
      await sql.begin((tx) => grant(tx, folder));
      const at = (placement: OraclePlacement, n: number) =>
        kind === 'branch'
          ? `${placement === 'folder' ? folderPath : root}.${label}${placement[0]}${n}`
          : placement === 'folder'
            ? folderPath
            : root;
      const item = async (
        placement: OraclePlacement,
        n: number,
        informational = false,
        bare = false,
      ) =>
        makeItem(
          kind,
          placement === 'folder' ? folder : rootRow!.id,
          at(placement, n),
          `${tag} ${placement} ${kind} ${n}`,
          { informational, ownGrants: placement === 'root', bare },
        );
      fx[kind] = {
        root: { id: await item('root', 1), path: at('root', 1), folder: null },
        folder: { id: await item('folder', 1), path: at('folder', 1), folder },
      };
      if (kind === 'app') {
        fx[kind]!.root.info = await item('root', 2, true);
        fx[kind]!.folder.info = await item('folder', 2, true);
        // An app node with no code row yet (a new app's code: appCreate).
        fx[kind]!.root.bare = await item('root', 3, false, true);
        fx[kind]!.folder.bare = await item('folder', 3, false, true);
      }
    }
    // Both checks on, as a box that runs them (the test's own scratch
    // database; no switch in production code).
    await sql`select mantle_set_edit_check('on')`;
    misses.length = 0;
  }, 300_000);

  afterAll(async () => {
    await w?.end();
    await sql?.end();
    await scratch?.drop();
  });

  it("the registry's workspace class is the guide's list", () => {
    expect([...kinds].sort()).toEqual(guideWorkspaceKinds().sort());
  });

  it('the fixture: each item is homed in H and read by H, W and R, never Admin', async () => {
    for (const kind of kinds) {
      for (const placement of ['root', 'folder'] as const) {
        const [r] = await sql<{ home: string; read: string[] }[]>`
          select home_ws::text as home, read_ws::text[] as read from nodes
           where id = ${fx[kind]![placement].id}`;
        expect(r!.home, kind).toBe(ws.H);
        expect([...r!.read].sort(), kind).toEqual([ws.H, ws.W, ws.R].sort());
      }
    }
  });

  let k = 0;
  /** The write a cell makes, on `tx`, for `item`; its rows changed. */
  async function write(
    tx: postgres.TransactionSql,
    kind: string,
    action: OracleWriteAction,
    item: Item,
    actor: OracleActor,
  ): Promise<number> {
    const id = action === 'appDataInformational' ? item.info! : item.id;
    const count = (r: { count: number }) => r.count;
    switch (action) {
      case 'create': {
        // A new item of the kind beside the fixture's (a folder: inside F
        // or at the kind's root).
        const [row] = await tx<
          { path: string }[]
        >`select path::text as path from nodes where id = ${id}`;
        const path =
          kind === 'branch'
            ? `${row!.path.split('.').slice(0, -1).join('.')}.${tag}n${k++}`
            : row!.path;
        return count(
          await tx`insert into nodes (owner_id, type, title, path)
                              values (${login.owner}, ${kind}, ${`${tag} new ${kind}`}, ${path}::ltree)`,
        );
      }
      case 'edit':
        return count(await tx`update nodes set title = title || ' (edited)' where id = ${id}`);
      case 'rank':
        return count(
          await tx`update nodes set data = data || '{"rank":"b1"}'::jsonb where id = ${id}`,
        );
      case 'derived':
        return count(
          await tx`update nodes set data = data || '{"summary":"a forged summary"}'::jsonb where id = ${id}`,
        );
      case 'delete':
        return count(await tx`delete from nodes where id = ${id}`);
      case 'deleteContent': {
        const table = kind === 'page' ? 'pages' : kind === 'draw' ? 'draws' : 'tables';
        return count(await tx.unsafe(`delete from ${table} where node_id = $1`, [id]));
      }
      case 'openLink':
        // As the app opens a new link (content shares.ts createShare): the
        // old open link is retired first (closing it asks no more than
        // opening one), then the new one is made.
        return count(
          await tx`
          with retired as (
            update shares set revoked_at = now()
             where node_id = ${id} and revoked_at is null and contact_id is null returning 1)
          insert into shares (token, owner_id, node_id, node_type)
          select ${`${tag}-${randomUUID()}`}, ${login.owner}, ${id}, ${kind}
            from (select count(*) from retired) r`,
        );
      case 'closeLink':
        return count(await tx`update shares set revoked_at = now() where node_id = ${id}`);
      case 'appCode':
        return count(
          await tx`update apps set draft_source = '{"files":{}}'::jsonb where node_id = ${id}`,
        );
      case 'appSwitch':
        return count(await tx`update apps set mcp_access = true where node_id = ${id}`);
      case 'appData':
      case 'appDataInformational':
        return count(
          await tx`update app_databases set size_bytes = size_bytes + 1 where app_node_id = ${id}`,
        );
      case 'recallCard':
        return count(await tx`update recall_nodes set body_md = 'changed' where map_id = ${id}`);
      case 'history':
        return count(await tx`update node_snapshots set note = 'changed' where node_id = ${id}`);
      case 'historyNew':
        return count(
          await tx`insert into node_snapshots (owner_id, node_id, node_kind, seq, trigger, actor)
                              values (${login.owner}, ${id}, ${kind}, 2, 'manual', 'owner')`,
        );
      case 'historyDelete':
        return count(await tx`delete from node_snapshots where node_id = ${id}`);
      case 'recallCardNew':
        return count(
          await tx`insert into recall_nodes (owner_id, map_id, slug, kind, title)
                              values (${login.owner}, ${id}, 'card2', 'card', 'Another card')`,
        );
      case 'recallCardDelete':
        return count(await tx`delete from recall_nodes where map_id = ${id}`);
      case 'deleteLink':
        return count(await tx`delete from shares where node_id = ${id}`);
      case 'appDataDelete':
        return count(await tx`delete from app_databases where app_node_id = ${id}`);
      case 'appCreate':
        return count(
          await tx`insert into apps (node_id, author_level) values (${item.bare!}, 'team')`,
        );
      case 'appLower':
        return count(await tx`update apps set author_level = 'team' where node_id = ${id}`);
      case 'createDerived': {
        // A new node in the folder carrying a summary, the extractor's mark
        // and an embedding (fix round 1, M1): a login's lands without them
        // (the extractor writes them again), the brain's keeps them. The
        // path from the fixture: a login may not read the item.
        const path =
          kind === 'branch'
            ? `${item.path.split('.').slice(0, -1).join('.')}.${tag}d${k++}`
            : item.path;
        const [made] = await tx<{ forged: boolean }[]>`
          insert into nodes (owner_id, type, title, path, data, embedding)
          values (${login.owner}, ${kind}, ${`${tag} forged ${kind}`}, ${path}::ltree,
                  '{"summary":"forged","extract_completed_at":"2026-01-01"}'::jsonb,
                  ${VECTOR}::vector)
          returning (data ? 'summary' or data ? 'extract_completed_at' or embedding is not null) as forged`;
        const keeps = actor === 'system';
        return made!.forged === keeps ? 1 : keeps ? 98 : 99;
      }
    }
  }

  type Got = { rows: number } | { refused: string; detail: string | null } | { failure: string };

  /** Run one cell; null when it matches the oracle, else why not. */
  async function cell(
    actor: OracleActor,
    role: OracleWriteRole,
    kind: string,
    placement: OraclePlacement,
    action: OracleWriteAction,
  ): Promise<string | null | 'na'> {
    const want = expectedWrite({ surface: 'sql', placement, actor }, role, kind, action);
    if ('na' in want) return 'na';
    const item = fx[kind]![placement];
    const heads = [
      item.id,
      ...(action === 'appDataInformational' ? [item.info!] : []),
      ...(action === 'appCreate' ? [item.bare!] : []),
    ].concat(item.folder ? [item.folder] : []);
    let got: Got | null = null;
    // The brain's work and a contact's app data (named system work) run on
    // the system pool.
    const onSystemPool = actor === 'system' || actor === 'contact-rw';
    const pool = onSystemPool ? sql : w;
    try {
      await pool.begin(async (tx) => {
        if (onSystemPool) {
          await tx`select set_config('mantle.actor', ${actor === 'system' ? 'system:test' : 'contact:rw'}, true),
                          set_config('mantle.write_mode', 'rw', true),
                          set_config('mantle.actor_check', 'on', true)`;
        } else {
          const s = scope[role];
          const who =
            actor === 'login'
              ? `login:${role === 'owner' ? 'owner' : 'rw'}:${s.login}`
              : roActor(actor, s.login);
          await tx`select set_config('mantle.ws', ${s.ws}, true),
                          set_config('mantle.mod_ws', ${s.mod}, true),
                          set_config('mantle.login_id', ${s.login}, true),
                          set_config('mantle.actor', ${who}, true),
                          set_config('mantle.write_mode', ${actor === 'login' ? 'rw' : 'ro'}, true),
                          set_config('mantle.actor_check', 'on', true)`;
        }
        await tx`select mantle_lock_heads(${heads}::uuid[], 'update')`;
        try {
          await tx`savepoint cell`;
          got = { rows: await write(tx, kind, action, item, actor) };
        } catch (err) {
          const e = err as { code?: string; detail?: string; message?: string };
          if (e.code === '42501') {
            await tx`rollback to savepoint cell`;
            got = { refused: e.detail ?? e.message ?? '', detail: e.detail ?? null };
          } else {
            got = { failure: `error ${e.code ?? '?'}: ${(e.message ?? '').slice(0, 160)}` };
          }
        }
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) return `error: ${(err as Error).message.slice(0, 160)}`;
    }
    const g = got as Got | null;
    if (!g) return 'no result';
    if ('failure' in g) return g.failure;
    if (want.allow) {
      if ('refused' in g) return `refused (${g.refused}), the oracle allows`;
      return g.rows === 1 ? null : `${g.rows} rows changed, the oracle allows one`;
    }
    if ('rows' in g && g.rows !== 0) return `${g.rows} rows changed, the oracle denies`;
    // The detail the guide decides (a read-only actor: ro_actor; an
    // Informational app's data: read_only); any edit check detail is one of
    // the plan's four.
    const detail = 'refused' in g ? g.detail : null;
    const must = expectedRefusalDetail(actor, role, action);
    if (must && detail !== must)
      return `refused with ${detail ?? 'no detail'}, the oracle says ${must}`;
    if (detail !== null && !['no_read', 'no_edit', 'read_only', 'ro_actor'].includes(detail)) {
      return `an unknown refusal detail ${detail}`;
    }
    return null;
  }

  it('every cell matches the oracle (row effects; a 500 or a generic error fails)', async () => {
    const failures: string[] = [];
    const tally = { cells: 0, na: 0, allowed: 0, denied: 0 };
    const run = async (
      actor: OracleActor,
      role: OracleWriteRole,
      kind: string,
      placement: OraclePlacement,
      action: OracleWriteAction,
    ) => {
      tally.cells++;
      const r = await cell(actor, role, kind, placement, action);
      if (r === 'na') tally.na++;
      else if (r) failures.push(`${actor} ${role} ${action} ${kind} @${placement}: ${r}`);
      else {
        const want = expectedWrite({ surface: 'sql', placement, actor }, role, kind, action);
        if ('allow' in want && want.allow) tally.allowed++;
        else tally.denied++;
      }
    };
    for (const kind of kinds) {
      for (const placement of ['root', 'folder'] as const) {
        for (const action of ORACLE_WRITE_ACTIONS) {
          // Every login, as itself.
          for (const role of ORACLE_WRITE_ROLES) await run('login', role, kind, placement, action);
          // Every other actor kind, in the scope of a login that may write
          // (the Write grant): the actor alone decides.
          for (const actor of ORACLE_ACTORS.filter((a) => a !== 'login')) {
            await run(actor, 'writeGrant', kind, placement, action);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Every write ran with its actor and both checks on: no miss.
    expect(misses).toEqual([]);
    const perKind = ORACLE_WRITE_ROLES.length + ORACLE_ACTORS.length - 1;
    expect(tally.cells).toBe(kinds.length * 2 * ORACLE_WRITE_ACTIONS.length * perKind);
    // Both answers exercised, and every applicable cell counted.
    // 11 kinds x 2 placements x 23 writes x 15 actors and logins: 7590
    // cells, 2976 the oracle covers (4614 not applicable: a write a kind
    // has no row for, a login's create, a contact's write that is not app
    // data, a create with forged values at the root).
    expect(tally.allowed).toBe(730);
    expect(tally.denied).toBe(2246);
    expect(tally.na + tally.allowed + tally.denied).toBe(tally.cells);
  }, 600_000);
});
