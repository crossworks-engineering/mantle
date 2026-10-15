/**
 * The A8 grid at SQL level (workspaces arch plan v2, section 12 A8): the
 * fixture the oracle (./guide-oracle.ts) speaks of, the cells, and one cell's
 * run. The test is a8-grid.db.test.ts; `pnpm test:matrix` runs it with the
 * surface cells.
 *
 * Each cell is ONE transaction, rolled back at its end. It runs the way the
 * product's statements run at the database:
 *  - a read (read, list, search) on the workspace role (mantle_view_user)
 *    with the caller's scope (mantle.ws, mantle.mod_ws, mantle.login_id), as
 *    a request or turn scope reads; system work on the system pool;
 *  - a login's, a turn's, an assistant's, a link's, a peer's and a contact
 *    share's write on a login of the write role (mantle_write_user), its
 *    scope, actor, write mode and create home set in the transaction, the
 *    heads taken first, as the login write gateway sends a scoped write
 *    (docs/actors.md, "The login write gateway"). An Admin user's write
 *    request still goes to the system pool today (W6a M1, until A4 puts its
 *    reads in the scope): the grid sends it on the write role, where the
 *    database's own checks decide;
 *  - grants and a home move through the definers the write role calls
 *    (mantle_grant_change, mantle_grant_move_home: 0279). The grants panel
 *    calls the same definers on the system pool with no scope today, its
 *    rights checked in TypeScript (server/web/lib/grants.ts); the grid checks
 *    the database's rule, the surface cells the panel's;
 *  - system work, and a contact share's app data (named system work after
 *    the share's own check), on the system pool.
 *
 * A cell passes only on the right row effect, read back through a probe
 * (a8_probe, a definer this scratch database gets): allowed is the change
 * made; refused is no change, with 42501 or no row matched (a row the scope
 * cannot read: "not found"). Any other error fails the cell, never a deny.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  ASSISTANT_WORKSPACE,
  GUIDE_ACTIONS,
  GUIDE_LOGIN_ACTORS,
  GUIDE_OTHER_ACTORS,
  GUIDE_PLACEMENTS,
  GUIDE_ROLES,
  GUIDE_SNAPSHOT_KINDS,
  TURN_WORKSPACE,
  expectedAccess,
  type GuideAction,
  type GuideActor,
  type GuideAnswer,
  type GuidePlacement,
  type GuideRole,
  type GuideWorkspace,
} from './guide-oracle';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

/** Rolls a cell's transaction back after its checks. */
class Rollback extends Error {}

/** The content table of a kind, where it has one (its list joins it). */
const CONTENT_TABLE: Readonly<Record<string, string>> = {
  page: 'pages',
  draw: 'draws',
  table: 'tables',
  app: 'apps',
  recall: 'recall_maps',
};

/** The draft column of a kind (editDraft). */
const DRAFT: Readonly<Record<string, { table: string; column: string }>> = {
  page: { table: 'pages', column: 'draft_doc' },
  draw: { table: 'draws', column: 'draft_scene' },
  table: { table: 'tables', column: 'draft_data' },
  app: { table: 'apps', column: 'draft_source' },
};

/** The content a kind's edit changes: its content row's, else its title. */
const CONTENT: Readonly<Record<string, { table: string; column: string }>> = {
  page: { table: 'pages', column: 'doc' },
  draw: { table: 'draws', column: 'scene' },
  table: { table: 'tables', column: 'data' },
};

export type A8Item = {
  id: string;
  /** Its folder (placement folder), else null. */
  folder: string | null;
  /** Where a new item of the kind is made beside it (create). */
  parent: string;
  parentPath: string;
  /** A word only this item's passage holds (search). */
  token: string;
};

export type A8Fixture = {
  tag: string;
  owner: string;
  logins: Record<GuideRole, string>;
  ws: Record<Exclude<GuideWorkspace, 'private'>, string>;
  /** Each login's private workspace (none for an Admin user). */
  privateWs: Partial<Record<GuideRole, string>>;
  /** Each login's whole scope. */
  scope: Record<GuideRole, { ws: string[]; mod: string[] }>;
  items: Record<string, Partial<Record<GuidePlacement, A8Item>>>;
  kindRoot: Record<string, string>;
  kindRootPath: Record<string, string>;
};

const arr = (ids: readonly string[]) => `{${ids.join(',')}}`;

/** The probe a cell reads its row effect with: a definer, so it sees the
 *  row whoever the cell ran as. Made in the scratch database only. */
export async function installProbe(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create or replace function a8_probe(i uuid) returns text
      language sql stable security definer set search_path = public, pg_temp as $$
      select coalesce((
        select jsonb_build_object(
          'title', n.title,
          'home', n.home_ws,
          'read', (select coalesce(array_agg(x order by x), '{}') from unnest(n.read_ws) x),
          'write', (select coalesce(array_agg(x order by x), '{}') from unnest(n.write_ws) x),
          'doc', coalesce(p.doc::text, d.scene::text, t.data::text),
          'draft', coalesce(p.draft_doc::text, d.draft_scene::text, t.draft_data::text,
                            a.draft_source::text),
          'cards', (select string_agg(r.body_md, '|' order by r.slug)
                      from recall_nodes r where r.map_id = n.id),
          'links', (select string_agg(s.token, '|' order by s.token)
                      from shares s where s.node_id = n.id and s.revoked_at is null),
          'appdata', (select ad.size_bytes from app_databases ad where ad.app_node_id = n.id)
        )::text
          from nodes n
          left join pages p on p.node_id = n.id
          left join draws d on d.node_id = n.id
          left join tables t on t.node_id = n.id
          left join apps a on a.node_id = n.id
         where n.id = i), 'gone')
    $$;
    revoke all on function a8_probe(uuid) from public;
    grant execute on function a8_probe(uuid) to mantle_write_user, mantle_view_user;`);
}

/**
 * Build the fixture (guide-oracle.ts, its header) on a migrated scratch
 * database, as an operator's psql would (system work, system(test)).
 * `kinds` is the registry's workspace class, which the test pins to the
 * guide's list.
 */
export async function buildA8Fixture(
  sql: Sql,
  kinds: readonly string[],
  rootOf: (kind: string) => string,
): Promise<A8Fixture> {
  const tag = `a8${randomUUID().slice(0, 6)}`;
  const L = Object.fromEntries(GUIDE_ROLES.map((r) => [r, randomUUID()])) as Record<
    GuideRole,
    string
  >;
  const rows = GUIDE_ROLES.map((r) => {
    const admin = r === 'owner' || r === 'admin';
    return sql`(${L[r]}, ${`${tag}-${r}@example.invalid`}, 'x', ${r === 'owner'},
                 ${admin ? 'admin' : 'member'}, ${r})`;
  });
  await sql`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
            values ${rows.reduce((a, b) => sql`${a}, ${b}`)}`;
  await sql`insert into spaces (id, kind, login_id) values (${L.owner}, 'brain', ${L.owner})
            on conflict (id) do nothing`;
  await sql`select * from mantle_ws_migrate()`;
  const ws = { admin: '', H: '', W: '', R: '', T: '', O: '' };
  ws.admin = (
    await sql<{ id: string }[]>`select id::text as id from workspaces
                                  where owner_id = ${L.owner} and is_admin`
  )[0]!.id;
  // The seats of guide-oracle.ts SEATS (Admin's come from the role).
  const seats: Record<'H' | 'W' | 'R' | 'T' | 'O', [GuideRole, boolean][]> = {
    H: [['homeModerator', true]],
    W: [['writeGrant', false]],
    R: [
      ['readGrant', true],
      ['homeModerator', true],
    ],
    T: [
      ['homeModerator', true],
      ['writeGrant', true],
    ],
    O: [['outsider', true]],
  };
  for (const key of ['H', 'W', 'R', 'T', 'O'] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into workspaces (owner_id, name) values (${L.owner}, ${`${tag} ${key}`})
      returning id::text as id`;
    ws[key] = row!.id;
    for (const [role, mod] of seats[key]) {
      await sql`insert into workspace_users (workspace_id, login_id, moderator)
                values (${row!.id}, ${L[role]}, ${mod})`;
    }
  }
  // Only the fixture's seats: a Team seat, if the brain still makes one,
  // goes (nothing is granted to it).
  await sql`delete from workspace_users u using workspaces w
             where w.id = u.workspace_id and not w.is_admin
               and w.id <> all(${arr(Object.values(ws))}::uuid[])
               and u.login_id = any(${arr(Object.values(L))}::uuid[])`;
  const privateWs: Partial<Record<GuideRole, string>> = {};
  for (const role of ['homeModerator', 'writeGrant', 'readGrant', 'outsider'] as const) {
    privateWs[role] = (
      await sql<{ ws: string }[]>`select mantle_ws_private_workspace(${L[role]}::uuid)::text as ws`
    )[0]!.ws;
  }
  const scope = {} as A8Fixture['scope'];
  for (const role of GUIDE_ROLES) {
    const [s] = await sql<{ ws: string[]; mod: string[] }[]>`
      select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
             coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                      filter (where u.moderator), '{}') as mod
        from workspace_users u join workspaces w on w.id = u.workspace_id and w.archived_at is null
       where u.login_id = ${L[role]}`;
    scope[role] = { ws: [...s!.ws], mod: [...s!.mod] };
  }

  const grant = async (id: string) => {
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      await tx`delete from item_grants where node_id = ${id} and via_folder_id is null`;
      await tx`insert into item_grants (node_id, workspace_id, is_home, write) values
        (${id}, ${ws.H}, true, false), (${id}, ${ws.W}, false, true), (${id}, ${ws.R}, false, false)`;
    });
  };

  /** One item of `kind` at `path` under `parent`, with its content rows,
   *  its passage and (unless a snapshot copy) an open public link. */
  const makeItem = async (
    kind: string,
    parent: string,
    path: string,
    o: { snapshotOf?: string; homeWs?: string } = {},
  ): Promise<{ id: string; token: string }> => {
    const id = randomUUID();
    const token = `zq${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const data = { rank: 'a0', ...(o.snapshotOf ? { snapshot_of: o.snapshotOf } : {}) };
    await sql.begin(async (tx) => {
      if (o.homeWs) await tx`select set_config('mantle.create_ws', ${o.homeWs}, true)`;
      await tx`select mantle_lock_heads(array[${parent}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path, data)
               values (${id}, ${L.owner}, ${kind}, ${`${tag} ${kind} ${path}`}, ${path}::ltree,
                       ${sql.json(data)})`;
    });
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${id}]::uuid[], 'update')`;
      if (kind === 'page') await tx`insert into pages (node_id, doc) values (${id}, '{"v":0}')`;
      if (kind === 'draw') await tx`insert into draws (node_id, scene) values (${id}, '{"v":0}')`;
      if (kind === 'table') await tx`insert into tables (node_id, data) values (${id}, '{"v":0}')`;
      if (kind === 'app') {
        await tx`insert into apps (node_id) values (${id})`;
        await tx`insert into app_databases (owner_id, app_node_id, storage_path)
                 values (${L.owner}, ${id}, ${`/tmp/${id}.db`})`;
      }
      if (kind === 'recall') {
        await tx`insert into recall_maps (id, owner_id, slug, title, node_id)
                 values (${id}, ${L.owner}, ${`${tag}-${id.slice(0, 8)}`}, ${tag}, ${id})`;
        await tx`insert into recall_nodes (owner_id, map_id, slug, kind, title)
                 values (${L.owner}, ${id}, 'card', 'card', 'A card')`;
      }
      await tx`insert into content_chunks (owner_id, node_id, ordinal, text)
               values (${L.owner}, ${id}, 0, ${`a passage about ${token}`})`;
      if (!o.snapshotOf) {
        await tx`insert into shares (token, owner_id, node_id, node_type)
                 values (${`${tag}-${randomUUID()}`}, ${L.owner}, ${id}, ${kind})`;
      }
    });
    return { id, token };
  };

  const items: A8Fixture['items'] = {};
  const kindRoot: Record<string, string> = {};
  const kindRootPath: Record<string, string> = {};
  for (const kind of kinds) {
    const root = rootOf(kind);
    await sql`insert into nodes (owner_id, type, title, path)
              select ${L.owner}, 'branch', ${root}, ${root}::ltree
               where not exists (select 1 from nodes where owner_id = ${L.owner}
                                   and type = 'branch' and path = ${root}::ltree)`;
    const rootId = (
      await sql<{ id: string }[]>`select id::text as id from nodes
         where owner_id = ${L.owner} and type = 'branch' and path = ${root}::ltree`
    )[0]!.id;
    kindRoot[kind] = rootId;
    kindRootPath[kind] = root;
    const label = `${tag}${kind.replace(/_/g, '')}`;
    const folderPath = `${root}.${label}f`;
    const folder = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select mantle_lock_heads(array[${rootId}]::uuid[], 'share')`;
      await tx`insert into nodes (id, owner_id, type, title, path)
               values (${folder}, ${L.owner}, 'branch', ${`${tag} F ${kind}`}, ${folderPath}::ltree)`;
    });
    await grant(folder);
    const pathAt = (base: string, n: string) => (kind === 'branch' ? `${base}.${label}${n}` : base);
    const rootItem = await makeItem(kind, rootId, pathAt(root, 'r'));
    await grant(rootItem.id);
    const folderItem = await makeItem(kind, folder, pathAt(folderPath, 's'));
    items[kind] = {
      root: { ...rootItem, folder: null, parent: rootId, parentPath: root },
      folder: { ...folderItem, folder, parent: folder, parentPath: folderPath },
    };
    // The author's snapshot copy (update-prod.md, "Snapshot copies"): of
    // the root item, homed in writeGrant's private workspace, Write off.
    if (GUIDE_SNAPSHOT_KINDS.includes(kind)) {
      const copy = await makeItem(kind, rootId, pathAt(root, 'c'), {
        snapshotOf: rootItem.id,
        homeWs: privateWs.writeGrant!,
      });
      items[kind]!.snapshot = { ...copy, folder: null, parent: rootId, parentPath: root };
    }
  }
  return { tag, owner: L.owner, logins: L, ws, privateWs, scope, items, kindRoot, kindRootPath };
}

// ── cells ───────────────────────────────────────────────────────────────────

export type A8Cell = {
  actor: GuideActor;
  /** The login asked for; null for an actor that answers no login. */
  role: GuideRole | null;
  kind: string;
  placement: GuidePlacement;
  action: GuideAction;
};

export const cellName = (c: A8Cell) =>
  `${c.actor}/${c.role ?? '-'} ${c.action} ${c.kind} @${c.placement}`;

/** Every cell: each login actor for each role, each other actor once. */
export function a8Cells(kinds: readonly string[]): A8Cell[] {
  const out: A8Cell[] = [];
  for (const kind of kinds) {
    for (const placement of GUIDE_PLACEMENTS) {
      for (const action of GUIDE_ACTIONS) {
        for (const actor of GUIDE_LOGIN_ACTORS) {
          for (const role of GUIDE_ROLES) out.push({ actor, role, kind, placement, action });
        }
        for (const actor of GUIDE_OTHER_ACTORS) {
          out.push({ actor, role: null, kind, placement, action });
        }
      }
    }
  }
  return out;
}

export const answerOf = (c: A8Cell): GuideAnswer =>
  expectedAccess(
    { surface: 'sql', placement: c.placement, actor: c.actor },
    c.role,
    c.kind,
    c.action,
  );

/** The connections one worker runs its cells on. */
export type A8Conns = { sys: Sql; w: Sql };

type Settings = {
  ws: string[];
  mod: string[];
  login: string;
  actor: string;
  mode: 'rw' | 'ro';
  createWs: string;
  privateWs: string;
};

/** The settings a cell's caller runs with (docs/actors.md, the actor
 *  kinds; the scope as the gate and the turn scope build it). */
function settingsOf(fx: A8Fixture, c: A8Cell): Settings {
  const wsId = (w: GuideWorkspace, role: GuideRole | null): string =>
    w === 'private' ? (role ? (fx.privateWs[role] ?? '') : '') : fx.ws[w];
  const none = { createWs: '', privateWs: '' };
  switch (c.actor) {
    case 'assistant':
      return {
        ws: [wsId(ASSISTANT_WORKSPACE, null)],
        mod: [],
        login: '',
        actor: 'assistant:none',
        mode: 'ro',
        ...none,
      };
    case 'link':
    case 'peer':
    case 'contact-ro': {
      // In the scope of a login that may write (the Write grant): the actor
      // alone decides (as the A3a write grid).
      const s = fx.scope.writeGrant;
      const actor = c.actor === 'link' ? 'link' : c.actor === 'peer' ? 'peer:none' : 'contact:ro';
      return { ws: s.ws, mod: s.mod, login: fx.logins.writeGrant, actor, mode: 'ro', ...none };
    }
    case 'contact-rw':
      return { ws: [], mod: [], login: '', actor: 'contact:rw', mode: 'rw', ...none };
    case 'system':
      return { ws: [], mod: [], login: '', actor: 'system:test', mode: 'rw', ...none };
    default:
      break;
  }
  const role = c.role!;
  const id = fx.logins[role];
  const own = fx.scope[role];
  const kindOf = c.actor === 'login-ro' ? 'ro' : role === 'owner' ? 'owner' : 'rw';
  const priv = fx.privateWs[role] ?? '';
  if (c.actor === 'turn') {
    // A turn runs in the assistant's workspace (agent-viewer: ws [X], a
    // Moderator of X when the login is one). A create there names X as the
    // current workspace when the login moderates it (the home rule, 1), else
    // the private fallback, added to the write scope (writeScopeWithPrivate).
    const x = wsId(TURN_WORKSPACE[role], role);
    const ws = own.ws.includes(x) ? [x] : [];
    const mod = own.mod.includes(x) ? [x] : [];
    const createWs = mod.length ? x : '';
    const landsPrivate = c.action === 'create' && !createWs && priv;
    return {
      ws: landsPrivate ? [...ws, priv] : ws,
      mod: landsPrivate ? [...mod, priv] : mod,
      login: id,
      actor: `login:${kindOf}:${id}`,
      mode: 'rw',
      createWs,
      privateWs: priv,
    };
  }
  return {
    ws: own.ws,
    mod: own.mod,
    login: id,
    actor: `login:${kindOf}:${id}`,
    mode: c.actor === 'login-ro' ? 'ro' : 'rw',
    createWs: '',
    privateWs: priv,
  };
}

const READS: readonly GuideAction[] = ['read', 'list', 'search'];

type Got =
  | { seen: boolean }
  | { changed: boolean; state: string; newId?: string }
  | { refused: true }
  | { failure: string };

/** Run one cell; null when it matches the oracle, else why not. */
export async function runA8Cell(conns: A8Conns, fx: A8Fixture, c: A8Cell): Promise<string | null> {
  const want = answerOf(c);
  if ('na' in want) throw new Error(`runA8Cell: ${cellName(c)} is not applicable`);
  const item = fx.items[c.kind]![c.placement]!;
  const s = settingsOf(fx, c);
  const onSystem = c.actor === 'system' || c.actor === 'contact-rw';
  let got: Got | null = null;
  try {
    if (READS.includes(c.action)) {
      got = await read(conns.sys, fx, c, item, onSystem ? null : s);
    } else {
      got = await write(onSystem ? conns.sys : conns.w, fx, c, item, s, onSystem);
    }
  } catch (err) {
    if (!(err instanceof Rollback)) {
      return `error: ${(err as Error).message.slice(0, 200)}`;
    }
  }
  return judge(fx, c, want, got);
}

/** read, list, search: on the workspace role in the caller's scope (null:
 *  system work, the system pool). */
async function read(
  sys: Sql,
  fx: A8Fixture,
  c: A8Cell,
  item: A8Item,
  s: Settings | null,
): Promise<Got> {
  let got: Got = { failure: 'no result' };
  await sys
    .begin(async (tx) => {
      if (s) {
        await tx`set local role mantle_view_user`;
        await tx`select set_config('mantle.ws', ${arr(s.ws)}, true),
                        set_config('mantle.mod_ws', ${arr(s.mod)}, true),
                        set_config('mantle.login_id', ${s.login}, true)`;
      }
      let ids: string[];
      if (c.action === 'read') {
        ids = (
          await tx<{ id: string }[]>`select id::text as id from nodes where id = ${item.id}`
        ).map((r) => r.id);
      } else if (c.action === 'list') {
        const table = CONTENT_TABLE[c.kind];
        // The kind's listing (listPages and kin): the kind's items under its
        // root, joined to its content row where it has one.
        const rootPath = fx.kindRootPath[c.kind]!;
        ids = (
          table
            ? await tx.unsafe<{ id: string }[]>(
                `select n.id::text as id from nodes n join ${table} c on c.node_id = n.id
                  where n.owner_id = $1 and n.type = $2 and n.path <@ $3::ltree`,
                [fx.owner, c.kind, rootPath],
              )
            : await tx<{ id: string }[]>`select n.id::text as id from nodes n
                where n.owner_id = ${fx.owner} and n.type = ${c.kind}
                  and n.path <@ ${rootPath}::ltree`
        ).map((x) => x.id);
      } else {
        // search: the passage arm of searchChunks (content_chunks joined to
        // its node; the chunk follows the node's read rule, 0249).
        ids = (
          await tx<{ id: string }[]>`select c.node_id::text as id from content_chunks c
            join nodes n on n.id = c.node_id
           where c.owner_id = ${fx.owner}
             and c.search_tsv @@ plainto_tsquery('english', ${item.token})`
        ).map((x) => x.id);
      }
      got = { seen: ids.includes(item.id) };
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback))
        got = {
          failure: `error ${(err as { code?: string }).code ?? '?'}: ${(err as Error).message.slice(0, 160)}`,
        };
    });
  return got;
}

/** The write a cell makes, and its row effect read back through the probe. */
async function write(
  pool: Sql,
  fx: A8Fixture,
  c: A8Cell,
  item: A8Item,
  s: Settings,
  onSystem: boolean,
): Promise<Got> {
  let got: Got = { failure: 'no result' };
  const login = c.role ? fx.logins[c.role] : fx.owner;
  await pool
    .begin(async (tx) => {
      await tx`select set_config('mantle.actor', ${s.actor}, true),
                      set_config('mantle.write_mode', ${s.mode}, true),
                      set_config('mantle.actor_check', 'on', true)`;
      if (!onSystem) {
        await tx`select set_config('mantle.ws', ${arr(s.ws)}, true),
                        set_config('mantle.mod_ws', ${arr(s.mod)}, true),
                        set_config('mantle.login_id', ${s.login}, true),
                        set_config('mantle.create_ws', ${s.createWs}, true),
                        set_config('mantle.private_ws', ${s.privateWs}, true)`;
      }
      if (c.action === 'create') {
        await tx`select mantle_lock_heads(array[${item.parent}]::uuid[], 'share')`;
      } else {
        const heads = item.folder ? [item.id, item.folder] : [item.id];
        await tx`select mantle_lock_heads(${heads}::uuid[], 'update')`;
      }
      const probe = async (id: string) =>
        (await tx<{ p: string }[]>`select a8_probe(${id}::uuid) as p`)[0]!.p;
      const before = c.action === 'create' ? 'gone' : await probe(item.id);
      await tx`savepoint cell`;
      try {
        const newId = await act(tx, fx, c, item, login);
        const state = await probe(newId ?? item.id);
        got = { changed: state !== before, state, ...(newId ? { newId } : {}) };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === '42501') {
          await tx`rollback to savepoint cell`;
          const state = c.action === 'create' ? 'gone' : await probe(item.id);
          got =
            state === before
              ? { refused: true }
              : { failure: `refused, but the row changed: ${state}` };
        } else {
          got = { failure: `error ${e.code ?? '?'}: ${(e.message ?? '').slice(0, 160)}` };
        }
      }
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback))
        got = {
          failure: `error ${(err as { code?: string }).code ?? '?'}: ${(err as Error).message.slice(0, 160)}`,
        };
    });
  return got;
}

/** The statement of a write action; a create returns the new item's id. */
async function act(
  tx: Tx,
  fx: A8Fixture,
  c: A8Cell,
  item: A8Item,
  login: string,
): Promise<string | undefined> {
  const id = item.id;
  const R = fx.ws.R;
  const T = fx.ws.T;
  switch (c.action) {
    case 'edit': {
      const t = CONTENT[c.kind];
      if (t) {
        await tx.unsafe(`update ${t.table} set ${t.column} = '{"v":1}'::jsonb where node_id = $1`, [
          id,
        ]);
      } else if (c.kind === 'recall') {
        await tx`update recall_nodes set body_md = 'changed' where map_id = ${id}`;
      } else {
        await tx`update nodes set title = title || ' (edited)' where id = ${id}`;
      }
      return undefined;
    }
    case 'editDraft': {
      const d = DRAFT[c.kind]!;
      await tx.unsafe(
        `update ${d.table} set ${d.column} = '{"files":{}}'::jsonb where node_id = $1`,
        [id],
      );
      return undefined;
    }
    case 'delete':
      await tx`delete from nodes where id = ${id}`;
      return undefined;
    case 'move':
      await tx`select mantle_grant_move_home(${id}::uuid, ${T}::uuid, false, ${login}::uuid)`;
      return undefined;
    case 'grantAdd':
      await tx`select mantle_grant_change('add', ${id}::uuid, ${T}::uuid, false, ${login}::uuid)`;
      return undefined;
    case 'grantRemove':
      // A grant the item took from its folder: "Remove from this
      // workspace" (exclude); a hand grant: remove.
      await tx`select mantle_grant_change(${item.folder ? 'exclude' : 'remove'}, ${id}::uuid,
                                          ${R}::uuid, null, ${login}::uuid)`;
      return undefined;
    case 'writeSwitch':
      // A grant the item took from its folder is made its own first ("This
      // grant comes from the folder. Use Change here first": patchGrant).
      if (item.folder) {
        await tx`select mantle_grant_change('hand', ${id}::uuid, ${R}::uuid, null, ${login}::uuid)`;
      }
      await tx`select mantle_grant_change('write', ${id}::uuid, ${R}::uuid, true, ${login}::uuid)`;
      return undefined;
    case 'link':
      // As the app opens a new link (content shares.ts createShare): the old
      // open link retired, the new one made.
      await tx`
        with retired as (
          update shares set revoked_at = now()
           where node_id = ${id} and revoked_at is null and contact_id is null returning 1)
        insert into shares (token, owner_id, node_id, node_type)
        select ${`${fx.tag}-${randomUUID()}`}, ${fx.owner}, ${id}, ${c.kind}
          from (select count(*) from retired) r`;
      return undefined;
    case 'appData':
      await tx`update app_databases set size_bytes = size_bytes + 1 where app_node_id = ${id}`;
      return undefined;
    case 'create': {
      const path =
        c.kind === 'branch'
          ? `${item.parentPath}.${fx.tag}n${randomUUID().slice(0, 6)}`
          : item.parentPath;
      const [row] = await tx<{ id: string }[]>`
        insert into nodes (owner_id, type, title, path)
        values (${fx.owner}, ${c.kind}, ${`${fx.tag} new ${c.kind}`}, ${path}::ltree)
        returning id::text as id`;
      return row?.id;
    }
    default:
      throw new Error(`act: ${c.action}`);
  }
}

/** The landing workspace id the oracle names. */
function landingId(fx: A8Fixture, c: A8Cell, lands: string | undefined): string | null {
  switch (lands) {
    case 'H':
    case 'R':
    case 'O':
      return fx.ws[lands];
    case 'admin':
      return fx.ws.admin;
    case 'private':
      return c.role ? (fx.privateWs[c.role] ?? null) : null;
    default:
      return null;
  }
}

/** Whether an allowed write made the change its action names. */
function effectMade(fx: A8Fixture, c: A8Cell, want: GuideAnswer, state: string): string | null {
  if (c.action === 'delete') return state === 'gone' ? null : 'not deleted';
  const p = JSON.parse(state) as { home: string; read: string[]; write: string[] };
  switch (c.action) {
    case 'move':
      return p.home === fx.ws.T ? null : `home is ${p.home}, not T`;
    case 'grantAdd':
      return p.read.includes(fx.ws.T) ? null : 'T does not read it';
    case 'grantRemove':
      return !p.read.includes(fx.ws.R) ? null : 'R still reads it';
    case 'writeSwitch':
      return p.write.includes(fx.ws.R) ? null : 'R has no Write';
    case 'create': {
      if (!('allow' in want) || !want.allow) return null;
      const lands = landingId(fx, c, want.lands);
      if (lands && p.home !== lands)
        return `landed in ${p.home}, the oracle says ${want.lands} (${lands})`;
      if (c.placement === 'folder') {
        const read = [...p.read].sort();
        const folder = [
          fx.ws.H,
          fx.ws.W,
          fx.ws.R,
          ...(lands && ![fx.ws.H].includes(lands) ? [lands] : []),
        ].sort();
        if (JSON.stringify(read) !== JSON.stringify(folder)) {
          return `read by ${read.join(',')}, not the folder's grants and its home`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function judge(fx: A8Fixture, c: A8Cell, want: GuideAnswer, got: Got | null): string | null {
  if (!got) return 'no result';
  if ('failure' in got) return got.failure;
  const allow = 'allow' in want && want.allow;
  if ('seen' in got) {
    if (allow && !got.seen) return 'not seen, the oracle allows';
    if (!allow && got.seen) return 'seen, the oracle denies';
    return null;
  }
  if ('refused' in got) return allow ? 'refused (42501), the oracle allows' : null;
  if (!allow) return got.changed ? `changed (${got.state.slice(0, 120)}), the oracle denies` : null;
  if (!got.changed && c.action !== 'create') return 'no row changed, the oracle allows';
  if (c.action === 'create' && got.state === 'gone') return 'no row made, the oracle allows';
  return effectMade(fx, c, want, got.state);
}
