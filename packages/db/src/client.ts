import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema/index';
import { env, envFlag } from '@mantle/config';
import {
  currentScopeTx,
  currentSpaceScope,
  currentScope,
  isSystemScope,
  SCOPE_AREAS,
  type ScopeArea,
  newTxHooks,
  runInSystemTx,
  runInWorkspaceTx,
  currentWorkspaceScope,
  inTurnScope,
  assertSystemDbCaller,
  systemDbAccessChecked,
  isUnscoped,
  runInTurnScope,
  type WorkspaceScope,
  runTxHooks,
  runInViewerScope,
  type ViewerFor,
  type AppRunFor,
  viewerDatabaseUrl,
  viewerRolePassword,
  type PoolRole,
  currentRequestMode,
  noteOwnRuleSystemRead,
  noteRequestSystemWrite,
  requestWriteScope,
  currentCreateHome,
  requestScopeMemo,
  type CreateHome,
} from './viewer';

declare global {
  var __mantleSql: ReturnType<typeof postgres> | undefined;

  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;

  /** The workspace role's small pool (see viewer.ts), opened on first use. */
  var __mantleViewerDbs:
    | Map<PoolRole, { sql: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }>
    | undefined;

  /** The turn-scope handle (workspaces W4b), over the workspace role's pool. */
  var __mantleTurnDb: PostgresJsDatabase<typeof schema> | undefined;
}

/** Connections of the limited pool. Small on purpose: max_connections is
 *  200 and every process of a box opens its own pools. */
const VIEWER_POOL_MAX = 3;

/**
 * Lazy singleton. Initialised on first call so Next.js can build pages that
 * don't actually query the DB without DATABASE_URL set (e.g. /login).
 *
 * The pool MUST be cached in every environment. `db` (below) is a Proxy that
 * calls getDb() on every property access, so without a cache each access would
 * mint a fresh `postgres()` pool (max: 10) and leak connections without bound.
 * The cache used to be gated behind `NODE_ENV !== 'production'` (the usual
 * Next.js survive-HMR-in-dev idiom) — but that inverted the logic: in
 * production nothing was cached, so every query opened a new pool and the
 * long-lived workers/agent exhausted Postgres within seconds. Cache always;
 * globalThis is process-global, so one pool per process is exactly right.
 */
function getAdminDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleDb) return globalThis.__mantleDb;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const sql = globalThis.__mantleSql ?? postgres(url, { max: 10, prepare: false });
  globalThis.__mantleSql = sql;
  const client = drizzle(sql, { schema });
  globalThis.__mantleDb = client;
  return client;
}

/**
 * The limited pool: logs in as the workspace LOGIN role, so row level
 * security filters every read. Fails loudly (never falls back to the admin
 * pool) when the master key is missing or the role cannot log in.
 */
function getViewerDb(level: PoolRole): PostgresJsDatabase<typeof schema> {
  const pools = (globalThis.__mantleViewerDbs ??= new Map());
  const cached = pools.get(level);
  if (cached) return cached.db;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set');
  const password = viewerRolePassword(env('MANTLE_MASTER_KEY') ?? '', level);
  const perDatabase = envFlag('MANTLE_VIEWER_ROLES_PER_DATABASE');
  const sql = postgres(viewerDatabaseUrl(url, level, password, perDatabase), {
    max: VIEWER_POOL_MAX,
    prepare: false,
    // No JIT on a scoped connection (W7a): a row rule raises the planner's
    // cost estimate past jit_above_cost, so a vector search that reads 50
    // rows paid about 13 ms of compiling on a large brain copy (5 ms without,
    // 3 ms on the system pool). Scoped reads are small; JIT never pays here.
    connection: { jit: 'off' },
  });
  const client = drizzle(sql, { schema });
  pools.set(level, { sql, db: client });
  return client;
}

/**
 * A turn's scope was looked for at query time and is gone (workspaces W4b):
 * a query built inside a turn scope ran after the turn ended, or from a
 * callback that does not carry it. Refused, never run unscoped.
 */
export class ScopeLostError extends Error {
  readonly code = 'scope-lost';
  constructor() {
    super('A scoped query ran outside its turn scope; refused (it never runs unscoped).');
    this.name = 'ScopeLostError';
  }
}

const SCOPE_SETTINGS_SQL =
  "select set_config('mantle.ws', $1, true), set_config('mantle.mod_ws', $2, true), " +
  "set_config('mantle.login_id', $3, true)";

/** The settings of the turn scope running NOW: read when a query runs, not
 *  when it was built. */
function turnScopeParams(): [string, string, string] {
  const scope = currentWorkspaceScope();
  if (!scope || !inTurnScope()) throw new ScopeLostError();
  return [
    uuidArrayLiteral(scope.ws, 'turn scope ws'),
    uuidArrayLiteral(scope.modWs, 'turn scope modWs'),
    scope.loginId ?? '',
  ];
}

type PgSql = ReturnType<typeof postgres>;

/**
 * A postgres.js client for drizzle that runs every query in its own short
 * transaction on the workspace role: BEGIN, the turn's scope settings
 * (transaction-local), the query, COMMIT, pipelined on one connection. The
 * scope is read when the query RUNS; with none (the turn ended, or the
 * callback lost it) the query is refused (ScopeLostError), never sent on
 * another pool. `begin` (db.transaction) sets the same settings first, so a
 * search step that needs one transaction (withHnswPool) keeps the scope.
 */
function turnScopedClient(base: PgSql): PgSql {
  // BEGIN, the settings, the query and COMMIT go out together on one
  // reserved connection: one round trip, not three (W6a: `begin` waits for
  // BEGIN, and COMMIT is a trip of its own). A failing statement aborts the
  // transaction; the COMMIT then rolls back, and the first error is thrown.
  const run = async (
    query: string,
    params: unknown[] | undefined,
    mode: 'rows' | 'values' | 'simple',
  ) => {
    const settings = turnScopeParams();
    const conn = await base.reserve();
    try {
      const begin = conn.unsafe('begin');
      const scope = conn.unsafe(SCOPE_SETTINGS_SQL, settings);
      const q = conn.unsafe(query, (params ?? []) as never[]);
      // A raw caller's simple protocol (a parameterless query with its own
      // literals, entities.ts graph paths) works in a scope too (W7a).
      const main = mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q;
      const commit = conn.unsafe('commit');
      const out = await Promise.allSettled([begin, scope, main, commit]);
      const failed = out.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      return (out[2] as PromiseFulfilledResult<unknown>).value;
    } finally {
      conn.release();
    }
  };
  const client = {
    options: base.options,
    unsafe(query: string, params?: unknown[]) {
      let pending: Promise<unknown> | null = null;
      const once = () => (pending ??= run(query, params, 'rows'));
      return {
        values: () => run(query, params, 'values'),
        simple: () => run(query, params, 'simple'),
        then: (ok?: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => once().then(ok, bad),
        catch: (bad?: (e: unknown) => unknown) => once().catch(bad),
        finally: (fn?: () => void) => once().finally(fn),
      };
    },
    begin(fn: (t: PgSql) => unknown) {
      let settings: [string, string, string];
      try {
        settings = turnScopeParams();
      } catch (err) {
        return Promise.reject(err);
      }
      return base.begin(async (t) => {
        await t.unsafe(SCOPE_SETTINGS_SQL, settings);
        return fn(t as unknown as PgSql);
      });
    },
  };
  return client as unknown as PgSql;
}

/** The drizzle handle of turn scopes: one per process, over the workspace
 *  role's pool. */
function getTurnScopedDb(): PostgresJsDatabase<typeof schema> {
  if (globalThis.__mantleTurnDb) return globalThis.__mantleTurnDb;
  getViewerDb('user');
  const base = globalThis.__mantleViewerDbs!.get('user')!.sql;
  const client = drizzle(turnScopedClient(base), { schema });
  globalThis.__mantleTurnDb = client;
  return client;
}

/** The handle for the current scope (viewer.ts): a scope's own transaction,
 *  a turn scope's per-query handle, else admin (system work). */
function getDb(): PostgresJsDatabase<typeof schema> {
  const tx = currentScopeTx();
  if (tx) return tx as PostgresJsDatabase<typeof schema>;
  if (inTurnScope()) return getTurnScopedDb();
  return getAdminDb();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` in ONE admin-pool transaction, on its own connection: every `db`
 * query inside is that transaction (`fn` gets it too). `afterCommit` work
 * inside runs once it commits, `afterRollback` work once it rolls back:
 * file side effects follow the rows they belong to (team apps follow-up).
 * Only from outside any viewer scope and outside another transaction scope.
 */
export async function withSystemTx<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  // A request scope (W6a) writes through here: writes stay on the system
  // pool with their rule in the statement (plan 2.3), in a read request too
  // (a lazy backfill, a root folder made on first open).
  const inRequest = currentRequestMode() !== null;
  if ((!isSystemScope() && !inRequest) || currentScopeTx()) {
    throw new Error('withSystemTx: only outside a viewer scope and any other transaction');
  }
  // Tests and development: a request scope's system transaction is one of
  // its writes (W6a fix round 2, L-c), pinned by the route sweep with the
  // file that opened it.
  if (inRequest) noteRequestSystemWrite('withSystemTx');
  // An Admin user's write request (W6a fix round 1, M1): the login's scope
  // on the transaction, so the database checks moves (0241/0245), creates in
  // a folder and deletes (0266) against its workspaces. mantle.login_id is
  // left unset: the 0250 stamp would otherwise mark trace, run and chat rows
  // made in the same transaction as this login's, which nothing asks for.
  const writeScope = requestWriteScope();
  const settings = writeScope
    ? [
        uuidArrayLiteral(writeScope.ws, 'write scope ws'),
        uuidArrayLiteral(writeScope.modWs, 'write scope modWs'),
      ]
    : null;
  // Where a create lands (W6b): the database's default home reads these.
  const home = currentCreateHome();
  const homeSettings = home
    ? [
        checkedUuidOrEmpty(home.createWs),
        checkedUuidOrEmpty(home.privateWs),
        home.stamp && Object.keys(home.stamp).length > 0 ? JSON.stringify(home.stamp) : '',
      ]
    : null;
  const hooks = newTxHooks();
  let result: T;
  try {
    result = await getAdminDb().transaction(async (tx) => {
      if (settings) {
        await tx.execute(
          sqlTag`select set_config('mantle.ws', ${settings[0]}, true),
                        set_config('mantle.mod_ws', ${settings[1]}, true)`,
        );
      }
      if (homeSettings) {
        await tx.execute(
          sqlTag`select set_config('mantle.create_ws', ${homeSettings[0]}, true),
                        set_config('mantle.private_ws', ${homeSettings[1]}, true),
                        set_config('mantle.ingest_notify', ${home?.quiet ? 'off' : ''}, true),
                        set_config('mantle.create_stamp', ${homeSettings[2]}, true)`,
        );
      }
      return runInSystemTx({ tx, hooks }, () => fn(tx));
    });
  } catch (err) {
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

/** A uuid, checked, or '' for none. */
function checkedUuidOrEmpty(id: string | null): string {
  if (id === null) return '';
  if (!UUID_RE.test(id)) throw new Error('create home: not a uuid');
  return id.toLowerCase();
}

/** A Postgres uuid[] literal from validated ids. */
function uuidArrayLiteral(ids: readonly string[], what: string): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`${what}: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return `{${[...new Set(ids)].sort().join(',')}}`;
}

/**
 * Run `fn` in ONE workspace scope (workspaces W1, plan section 2.1): a short
 * transaction on the workspace role (`mantle_view_user`) that sets
 * `mantle.ws`, `mantle.mod_ws` and `mantle.login_id`; every `db` query inside
 * runs in it, so row security shows only what those workspaces hold (and a
 * per-login row only to its login). `modWs` must be a subset of `ws`.
 * Not nested in any other scope (fails loudly); keep it short, never across
 * an LLM call.
 */
export async function withScope<T>(scope: WorkspaceScope, fn: () => Promise<T>): Promise<T> {
  if (currentWorkspaceScope() || currentScopeTx() || currentSpaceScope()) {
    throw new Error('withScope: already inside a scope');
  }
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    throw new Error('withScope: loginId must be a uuid');
  }
  const ws = uuidArrayLiteral(scope.ws, 'withScope ws');
  const mod = uuidArrayLiteral(scope.modWs, 'withScope modWs');
  const inWs = new Set(scope.ws);
  if (scope.modWs.some((id) => !inWs.has(id))) {
    throw new Error('withScope: modWs must be a subset of ws');
  }
  const frozen: WorkspaceScope = {
    kind: scope.kind,
    loginId: scope.loginId,
    ws: Object.freeze([...new Set(scope.ws)].sort()),
    modWs: Object.freeze([...new Set(scope.modWs)].sort()),
  };
  const hooks = newTxHooks();
  let result: T;
  try {
    result = await getViewerDb('user').transaction(async (tx) => {
      await tx.execute(
        sqlTag`select set_config('mantle.ws', ${ws}, true),
                      set_config('mantle.mod_ws', ${mod}, true),
                      set_config('mantle.login_id', ${scope.loginId ?? ''}, true)`,
      );
      return runInWorkspaceTx({ ws: frozen, tx, hooks }, fn);
    });
  } catch (err) {
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

/**
 * Run `fn` as an assistant TURN in one workspace scope (workspaces W4b, plan
 * 5.1): every `db` query inside, after any await, runs on the workspace role
 * (`mantle_view_user`) in its own short transaction that sets the scope, so
 * no transaction is held across an LLM call. Fails closed: a query built
 * here that runs after the turn ended (or from a callback that lost it) is
 * refused (ScopeLostError), never sent on the system pool. Nested in the
 * same scope it just runs `fn`;
 * inside any other scope it is refused. `modWs` must be a subset of `ws`.
 * Writes are not made here: they go through the system pool's own paths.
 */
export async function withTurnScope<T>(
  scope: WorkspaceScope,
  fn: () => Promise<T>,
  opts: { writes?: boolean } = {},
): Promise<T> {
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    throw new Error('withTurnScope: loginId must be a uuid');
  }
  uuidArrayLiteral(scope.ws, 'withTurnScope ws');
  uuidArrayLiteral(scope.modWs, 'withTurnScope modWs');
  if (scope.ws.length === 0) throw new Error('withTurnScope: a turn reads at least one workspace');
  const inWs = new Set(scope.ws);
  if (scope.modWs.some((id) => !inWs.has(id))) {
    throw new Error('withTurnScope: modWs must be a subset of ws');
  }
  const frozen: WorkspaceScope = Object.freeze({
    kind: scope.kind,
    loginId: scope.loginId,
    ws: Object.freeze([...new Set(scope.ws)].sort()),
    modWs: Object.freeze([...new Set(scope.modWs)].sort()),
  });
  // An Admin turn (W7a, `writes`): the Admin assistant and the Admin MCP
  // surface write as an Admin user's mutating request does, on the system
  // pool with the turn's scope set on its transactions (the database's
  // move, create and delete checks), and read drafts as the editor does.
  return runInTurnScope(
    frozen,
    fn,
    opts.writes ? Object.freeze({ writes: true, drafts: true }) : undefined,
  );
}

/** The transaction handle `db.transaction` gives its callback. */
type ReadTx = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0];

/**
 * A transaction that only READS (W7a): in a turn or request scope it runs
 * on the workspace role with the scope set, even where `db.transaction` is
 * a write (a mutating request, an Admin turn) and goes to the system pool.
 * A vector search's settings transaction (withHnswPool) uses it, so a scoped
 * search never reads past the scope. Anywhere else it is `db.transaction`.
 */
export function readTransaction<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

const holdsAdmin = new WeakMap<WorkspaceScope, Promise<boolean>>();

/**
 * Whether the current code may do Admin-workspace work (plan 5.4, adminOnly):
 * unscoped system work (the owner's paths, and the Admin assistant and the
 * Admin MCP surface under MANTLE_ADMIN_READS=system) yes; a workspace scope when it holds
 * the Admin workspace (asked of the database once per scope). Fails closed:
 * an error reads as no.
 */
export async function scopeHoldsAdmin(): Promise<boolean> {
  const scope = currentWorkspaceScope();
  if (!scope) return isUnscoped();
  let p = holdsAdmin.get(scope);
  if (!p) {
    p = (async () => {
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_is_admin"() as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    })();
    holdsAdmin.set(scope, p);
  }
  return p;
}

/**
 * Whether the current code may do an "Admin only" thing in `area` (plan S2,
 * 2.4): system work may; a user scope may when it holds the Admin workspace,
 * its login is a user there and its limits leave the area on
 * (mantle_scope_has_area, the rule of areasFor); so may an assistant turn
 * that answers such a login (W7a: the Admin assistant, which answers the
 * owner when no login asks). A link and an assistant turn with no login
 * never may. An unknown kind or area is refused (fails
 * closed).
 */
export async function scopeHasArea(area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area)) return false;
  const scope = currentScope();
  switch (scope.kind) {
    case 'system':
      return true;
    case 'user':
    case 'assistant': {
      if (!scope.loginId) return false;
      try {
        const rows = (await getDb().execute(
          sqlTag`select "public"."mantle_scope_has_area"(${area}) as a`,
        )) as unknown as { a: boolean }[];
        return rows[0]?.a === true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/**
 * Whether `loginId` is a user of this brain's live Admin workspace now, its
 * login enabled (W7 integration fix 3, L1): what the rollback switch
 * (MANTLE_ADMIN_READS=system) asks before it puts a login's reads on the
 * system pool, never the admin role alone (a login taken out of Admin keeps
 * its role). A brain not on workspaces: yes (the role decides, as before).
 * Fails closed. Admin pool.
 */
export async function loginHoldsAdmin(loginId: string): Promise<boolean> {
  if (!UUID_RE.test(loginId)) return false;
  try {
    if (!(await brainOnWorkspacesNow())) return true;
    const rows = (await getAdminDb().execute(
      sqlTag`select exists (
               select 1 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch {
    return false;
  }
}

/**
 * Whether login `loginId` holds Admin `area` now, asked on the system pool
 * for a login other than the current caller (W7a fix round 3: the maker of
 * an API tool, when the tool's secret refs resolve at run time). The rule
 * of mantle_scope_has_area and areasFor: a live login that is a user of the
 * brain's live Admin workspace whose limits leave the area on. A brain not
 * on workspaces keeps today's rule (any admin: yes). Fails closed.
 */
export async function loginHasArea(loginId: string, area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area) || !UUID_RE.test(loginId)) return false;
  try {
    if (!(await brainOnWorkspacesNow())) return true;
    const rows = (await getAdminDb().execute(
      sqlTag`select exists (
               select 1 from workspaces w
                 join workspace_users u on u.workspace_id = w.id and u.login_id = ${loginId}::uuid
                 join auth.users l on l.id = u.login_id and l.disabled_at is null
                where w.owner_id = mantle_brain_id() and w.is_admin and w.archived_at is null
                  and coalesce(u.limits -> 'areas' ->> ${area}, '') <> 'false') as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` in ONE admin-pool transaction whose FIRST lock is the heads of
 * `ids` (workspaces plan U1 and V2): every writer of nodes, chunks, windows,
 * facts and grants goes through here, so no two writers can deadlock and none
 * can miss another's grant change. `update` for a change of grants, a move, a
 * delete or a chunk rewrite; `share` for a new item in a folder (lock the
 * folder). The database checks it (mantle.heads_check: off, warn, on).
 */
export async function withHeads<T>(
  ids: readonly string[],
  mode: 'update' | 'share',
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withHeads');
  return withSystemTx(async (tx) => {
    await tx.execute(sqlTag`select mantle_lock_heads(${list}::uuid[], ${mode})`);
    return fn(tx);
  });
}

/**
 * withHeads for a whole subtree (plan U2, V1, V3): the heads of `root` and
 * everything under it (a folder), plus `extra` (a move's old and new
 * folder), locked FIRST; later rounds pick up rows that arrived while the
 * first round waited, without waiting. For a folder's grant change and for a
 * move. A busy later round fails with 55P03: wrap in withDeadlockRetry.
 */
export async function withSubtreeHeads<T>(
  root: string,
  extra: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(root)) throw new Error('withSubtreeHeads: root must be a uuid');
  const list = uuidArrayLiteral(extra, 'withSubtreeHeads');
  return withSystemTx(async (tx) => {
    await tx.execute(sqlTag`select mantle_lock_subtree_heads(${root}::uuid, ${list}::uuid[])`);
    return fn(tx);
  });
}

/** The folders `items` would sit in (an item's path is its folder's path; a
 *  folder's parent is one level up). Read on the admin pool BEFORE the
 *  transaction, so the heads can still be its first lock. */
export async function folderHeadIds(
  ownerId: string,
  items: readonly { type: string; path: string }[],
): Promise<string[]> {
  if (!UUID_RE.test(ownerId)) throw new Error('folderHeadIds: ownerId must be a uuid');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = `${it.type}\u0000${it.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rows = (await getAdminDb().execute(
      sqlTag`select mantle_parent_folder(${ownerId}::uuid, ${it.type}::node_type, ${it.path}::ltree) as id`,
    )) as unknown as { id: string | null }[];
    const id = rows[0]?.id;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Heads for creating nodes (plan U1): the folders they land in, SHARE (many
 * creators may add to one folder at once; a grant change on the folder
 * waits for them, or they for it).
 */
export async function withNodeInsertHeads<T>(
  ownerId: string,
  items: readonly { type: string; path: string }[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  return withHeads(await folderHeadIds(ownerId, items), 'share', fn);
}

/**
 * Heads for moving one node (a path change, plan V3): the node and, for a
 * folder, everything under it, plus its old folder and the folder at
 * `newPath`, in rounds until stable.
 */
export async function withNodeMoveHeads<T>(
  ownerId: string,
  node: { id: string; type: string; path: string },
  newPath: string,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const folders = await folderHeadIds(ownerId, [
    { type: node.type, path: node.path },
    { type: node.type, path: newPath },
  ]);
  return withSubtreeHeads(node.id, folders, fn);
}

/**
 * Heads for deleting nodes (plan V4): each node, everything under a folder,
 * and the folders they sit in, UPDATE. Read before the transaction.
 */
export async function withNodeDeleteHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const list = uuidArrayLiteral(ids, 'withNodeDeleteHeads');
  const rows = (await getAdminDb().execute(
    sqlTag`select distinct x.id from (
             select d.id from nodes n
               join nodes d on d.owner_id = n.owner_id
                and (d.id = n.id or (n.type = 'branch' and d.path <@ n.path))
              where n.id = any(${list}::uuid[])
             union
             select mantle_parent_folder(n.owner_id, n.type, n.path) from nodes n
              where n.id = any(${list}::uuid[])
           ) x where x.id is not null`,
  )) as unknown as { id: string }[];
  return withHeads(
    rows.map((r) => r.id),
    'update',
    fn,
  );
}

/**
 * Heads for a writer that also runs inside a member's personal space: in the
 * brain, `open` takes the heads and runs `fn` in its transaction; inside a
 * personal-space scope (rows outside any workspace grant, on the space
 * role, where heads cannot be taken) `fn` runs on the scope's own
 * transaction. That second path is removed with personal spaces in W6b
 * (workspaces plan); it is the one sanctioned exemption.
 */
export async function headsOrSpace<T>(
  open: (fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>) => Promise<T>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope()) return fn(getDb());
  return open(fn);
}

/**
 * A write of rows the CURRENT personal space owns, on the space's own
 * transaction (withSpace). The space role cannot take heads, and it needs
 * none: the database exempts rows a personal space owns from the heads
 * check, because no workspace reads them (migration 0244 refuses a grant on
 * one). Throws outside a personal-space scope, so it cannot carry a brain
 * write. Removed with personal spaces in W6b (W4 replaces the exemption
 * before it grants personal items).
 */
export async function withSpaceRows<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (!currentSpaceScope()) {
    throw new Error('withSpaceRows: only inside a personal-space scope (withSpace)');
  }
  return fn(getDb());
}

/**
 * Rows that personal spaces own, written on `q` (an open transaction or the
 * pool) outside a space scope: an admin's purge, a takeover between two
 * spaces, a brain folder rename carried into the members' drafts. Checks
 * first that every id in `spaceIds` is a personal space. The database
 * exempts those rows from the heads check (0244) and still checks any brain
 * row, so a brain write slipped in here is caught there. Removed with
 * personal spaces in W6b.
 */
export async function onSpaceRows<
  Q extends { execute: PostgresJsDatabase<typeof schema>['execute'] },
  T,
>(q: Q, spaceIds: string | readonly string[], fn: (q: Q) => Promise<T>): Promise<T> {
  const ids = typeof spaceIds === 'string' ? [spaceIds] : [...new Set(spaceIds)];
  const list = uuidArrayLiteral(ids, 'onSpaceRows');
  const rows = (await q.execute(
    sqlTag`select count(*)::int as n from spaces
            where id = any(${list}::uuid[]) and kind = 'personal'`,
  )) as unknown as { n: number }[];
  if ((rows[0]?.n ?? 0) !== ids.length) {
    throw new Error('onSpaceRows: every id must be a personal space');
  }
  return fn(q);
}

/**
 * Heads for a writer that changes an item's level or what it embeds (a level
 * set, a save that adds or drops an embed): the item's head (`ids`, for
 * update) FIRST, so the level bridge (0251) finds its writer holding heads
 * and takes the rows that follow from the change (embeds, inherited levels)
 * itself without waiting. The whole transaction is retried when a head was
 * busy (55P03) or a deadlock was broken.
 *
 * Inside a personal-space scope (withSpace) `fn` runs on the space's own
 * transaction (headsOrSpace: no heads there, rule 1 of 0244). Inside an open
 * system transaction (withSystemTx, withHeads) it runs on that transaction:
 * its heads are already first, and the bridge locks the rest.
 */
export async function withWriterHeads<T>(
  ids: readonly string[],
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (currentSpaceScope() || currentScopeTx()) {
    // A savepoint of the open transaction, as db.transaction is there.
    return getDb().transaction((tx) => fn(tx as unknown as PostgresJsDatabase<typeof schema>));
  }
  return withDeadlockRetry(() => withHeads(ids, 'update', fn));
}

/**
 * Lock more heads later in a heads transaction (plan U2, V1): FOR UPDATE
 * NOWAIT, for rows found only after the first lock (a bundle, the folders an
 * Accept lands in). A busy head fails with 55P03: run the whole transaction
 * in withDeadlockRetry.
 */
export async function lockMoreHeads(
  tx: { execute: PostgresJsDatabase<typeof schema>['execute'] },
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const list = uuidArrayLiteral(ids, 'lockMoreHeads');
  await tx.execute(sqlTag`select mantle_lock_heads_more(${list}::uuid[])`);
}

/** SQLSTATEs a whole transaction may be retried for: a deadlock, a
 *  serialization failure (a head missing in 'on' mode, a growing subtree), a
 *  NOWAIT lock that was busy. */
const RETRYABLE = new Set(['40P01', '40001', '55P03']);

function sqlState(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Run a whole transaction again when it failed for a retryable reason
 * (plan V1: every retry is at the caller, never inside a function). `run`
 * must start its own transaction each time (withHeads, withScope,
 * withSystemTx), so nothing of a failed attempt survives.
 */
export async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = sqlState(err);
      if (attempt >= attempts || code === null || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.random() * 40 * attempt));
    }
  }
}

/**
 * The R6 shim (plan R6, S2, T4): run `fn` for whoever `actsFor` names, in a
 * WORKSPACE scope. A login reads the union of its
 * live workspaces (a disabled login: none); an assistant reads its own
 * workspace (none when it sits on no workspace); a public link reads no
 * workspace and carries its served list. Every query inside, after any
 * await, runs on the workspace role in its own short transaction that sets
 * the scope (as a turn scope does), so a long request holds no transaction.
 * Fails closed: an empty scope reads nothing.
 *
 * System work never comes through here: a caller that may run as the
 * system runs `fn` itself (the level argument that said so went in W8c).
 * Inside the same workspace scope it just runs `fn`; inside another one it
 * is refused, unless it narrows a request scope.
 */
export async function withViewer<T>(actsFor: ViewerFor, fn: () => Promise<T>): Promise<T> {
  // Inside the request scope of this very login (W6a): that scope is the
  // one withViewer would build, read once by the session guard. No second
  // lookup per call (the W5b2 member search cost).
  const open = currentWorkspaceScope();
  if (
    'login' in actsFor &&
    !actsFor.app &&
    currentRequestMode() &&
    open?.kind === 'user' &&
    open.loginId === actsFor.login.toLowerCase()
  ) {
    return fn();
  }
  return runInViewerScope(await memoScopeFor(actsFor), fn);
}

/** viewerScopeFor, once per request for the same login (and app) or agent:
 *  workspace and membership changes take effect on the next request. */
function memoScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const memo = requestScopeMemo();
  const key =
    'login' in actsFor
      ? `login:${actsFor.login.toLowerCase()}:${actsFor.app ? JSON.stringify(actsFor.app) : ''}`
      : 'agent' in actsFor
        ? `agent:${actsFor.agent ?? ''}`
        : null;
  if (!memo || key === null) return viewerScopeFor(actsFor);
  let p = memo.get(key);
  if (!p) {
    p = viewerScopeFor(actsFor);
    // A failed lookup is not kept: the next call asks again.
    p.catch(() => memo.delete(key!));
    memo.set(key, p);
  }
  return p;
}

/**
 * The login's workspaces and Moderator ones, as SQL columns of a query on
 * auth.users (W6a fix round 1, the bench): the session's one login read
 * carries them, and seedLoginScope keeps them as this request's scope, so
 * the guard needs no second lookup. The same rule as viewerScopeFor: live
 * workspaces only, none for a disabled login. The login is a bound id, not
 * the outer column: drizzle writes a single-table query's columns without
 * their table, and a bare "id" in the subquery would be the workspace's.
 */
export function loginScopeColumns(loginId: string, disabledAt: AnyPgColumn) {
  return {
    scopeWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${loginId}::uuid), '{}') else '{}' end`,
    scopeModWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and w.archived_at is null
         where u.login_id = ${loginId}::uuid and u.moderator), '{}') else '{}' end`,
  };
}

/** Keep a login's scope, read with its row (loginScopeColumns), as this
 *  request's: loginScopeFor and withViewer for that login reuse it. No-op
 *  outside a request, or when the request already looked it up. */
export function seedLoginScope(
  loginId: string,
  ws: readonly string[],
  modWs: readonly string[],
): void {
  const memo = requestScopeMemo();
  if (!memo || !UUID_RE.test(loginId)) return;
  const key = `login:${loginId.toLowerCase()}:`;
  if (memo.has(key)) return;
  memo.set(
    key,
    Promise.resolve(
      Object.freeze({
        kind: 'user' as const,
        loginId: loginId.toLowerCase(),
        ws: Object.freeze([...ws]),
        modWs: Object.freeze([...modWs]),
      }),
    ),
  );
}

/**
 * The scope the session guard enters for a signed-in login (W6a): the
 * union of its live workspaces, Moderator where it is one (a disabled
 * login: none). The same scope `withViewer({ login }, …)` builds.
 */
export async function loginScopeFor(loginId: string): Promise<WorkspaceScope> {
  return memoScopeFor({ login: loginId });
}

/** Why a create home was refused: a workspace id that is not one, a
 *  workspace the login is not in, or no workspace to make a private one in. */
export type CreateHomeRefusal = {
  refused: 'invalid' | 'not-member' | 'no-workspace';
  message: string;
};

/**
 * Where a login's creates land (docs/workspaces.md, "Where a new item
 * lands"; W6b): one function for the web routes (session.ts createHomeFor)
 * and assistant turns (A0: @mantle/tools turnCreateHome).
 *
 *  - `askedWs` (a request's ?ws=, a workspace assistant's own workspace): a
 *    workspace the login is not in is refused; one it moderates is where
 *    its creates land; one it only reads is as if none was named.
 *  - `ownWork` (a login outside the Admin workspace; 'auto' asks the
 *    database): its private workspace is the fallback (the folder it makes
 *    the item in when it may edit that, else the private workspace), made
 *    now when `makePrivate` and it has none. With no workspace to make one
 *    in, refused. An Admin user has no private fallback: the folder's home,
 *    else Admin.
 *
 * Admin pool: it names a place, it grants nothing (the database's create
 * checks still run).
 */
export async function resolveCreateHome(
  loginId: string,
  o: { askedWs?: string | null; ownWork: boolean | 'auto'; makePrivate: boolean },
): Promise<CreateHome | CreateHomeRefusal> {
  let createWs: string | null = null;
  if (o.askedWs !== undefined && o.askedWs !== null && o.askedWs !== '') {
    if (!UUID_RE.test(o.askedWs))
      return { refused: 'invalid', message: 'ws must be a workspace id.' };
    const scope = await loginScopeFor(loginId);
    const ws = o.askedWs.toLowerCase();
    if (!scope.ws.includes(ws)) {
      return { refused: 'not-member', message: 'You are not in that workspace.' };
    }
    if (scope.modWs.includes(ws)) createWs = ws;
  }
  const admin = getAdminDb();
  const ownWork =
    o.ownWork === 'auto'
      ? !(
          (await admin.execute(sqlTag`
            select 1 from workspace_users u
              join workspaces w on w.id = u.workspace_id and w.is_admin and w.archived_at is null
             where u.login_id = ${loginId}::uuid limit 1`)) as unknown as unknown[]
        ).length
      : o.ownWork;
  if (!ownWork) return { createWs, privateWs: null };
  if (!o.makePrivate) {
    const own = (await admin.execute(sqlTag`
      select p.workspace_id::text as ws from private_workspaces p
        join workspaces w on w.id = p.workspace_id and w.archived_at is null
       where p.login_id = ${loginId}::uuid`)) as unknown as { ws: string }[];
    return { createWs, privateWs: own[0]?.ws ?? null };
  }
  const rows = (await admin.execute(
    sqlTag`select "public"."mantle_ws_private_workspace"(${loginId}::uuid)::text as ws`,
  )) as unknown as { ws: string | null }[];
  const privateWs = rows[0]?.ws ?? null;
  if (!privateWs) {
    return { refused: 'no-workspace', message: 'You have no workspace to create in yet.' };
  }
  return { createWs, privateWs };
}

let brainOnWorkspaces = false;

/**
 * Whether this brain is on workspaces: it has an Admin workspace (the
 * workspaces migration ran). A brain the migration skipped (a box with
 * client logins, set up by hand first, plan 21.9) keeps today's rule for an
 * Admin user: reads on the system pool, as before W6a. Read on the system
 * pool; a yes is kept for the life of the process (no box goes back).
 */
export async function brainOnWorkspacesNow(): Promise<boolean> {
  if (brainOnWorkspaces) return true;
  const rows = (await getAdminDb().execute(
    sqlTag`select exists (select 1 from workspaces
                           where owner_id = mantle_brain_id() and is_admin) as on`,
  )) as unknown as { on: boolean }[];
  brainOnWorkspaces = rows[0]?.on === true;
  return brainOnWorkspaces;
}

/** The live workspaces beyond Admin an app run reads through (AppRunFor):
 *  a brain app's holders from its grants; the brain's Team workspace (team
 *  rules) only for `{ team: true }` or a brain app with no row beyond Admin
 *  at all (an archived workspace's row counts: such an app reads nothing,
 *  as `getAppRuntime`'s toolRules says 'team' for it). An id that is not an
 *  app reads nothing. Admin pool. */
async function appRunHolders(app: AppRunFor): Promise<string[]> {
  const admin = getAdminDb();
  if ('id' in app) {
    if (!UUID_RE.test(app.id)) throw new Error('withViewer: app must be a uuid');
    const [row] = (await admin.execute(
      sqlTag`select coalesce(array(
                      select w.id::text from workspaces w
                       where w.id = any(n.read_ws) and not w.is_admin and w.archived_at is null
                       order by w.id), '{}') as live,
                    exists (select 1 from item_grants g
                              join workspaces w on w.id = g.workspace_id and not w.is_admin
                             where g.node_id = n.id and not g.excluded) as beyond
               from nodes n
              where n.id = ${app.id} and n.type = 'app'`,
    )) as unknown as { live: string[]; beyond: boolean }[];
    if (!row) return [];
    if (row.live.length > 0) return [...row.live];
    if (row.beyond) return [];
  }
  const team = (await admin.execute(
    sqlTag`select w.id::text as id from workspaces w
            where w.owner_id = mantle_brain_id() and w.bridge_key = 'team'
              and w.archived_at is null`,
  )) as unknown as { id: string }[];
  return team.map((r) => r.id);
}

/** The scope `withViewer` enters for `actsFor`, read on the admin pool. */
export async function viewerScopeFor(actsFor: ViewerFor): Promise<WorkspaceScope> {
  const admin = getAdminDb();
  if ('login' in actsFor) {
    if (!UUID_RE.test(actsFor.login)) throw new Error('withViewer: login must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select coalesce(array_agg(u.workspace_id::text order by u.workspace_id), '{}') as ws,
                    coalesce(array_agg(u.workspace_id::text order by u.workspace_id)
                             filter (where u.moderator), '{}') as mod
               from workspace_users u
               join workspaces w on w.id = u.workspace_id and w.archived_at is null
               join auth.users l on l.id = u.login_id and l.disabled_at is null
              where u.login_id = ${actsFor.login}`,
    )) as unknown as { ws: string[]; mod: string[] }[];
    let ws = rows[0]?.ws ?? [];
    let mod = rows[0]?.mod ?? [];
    if (actsFor.app) {
      // An app run (plan R2, H1): the holders beyond Admin, met with the
      // runner's workspaces; see AppRunFor.
      const held = await appRunHolders(actsFor.app);
      const holder = held.length === 1 ? held[0]! : null;
      ws = holder && ws.includes(holder) ? [holder] : [];
      mod = mod.filter((m) => ws.includes(m));
    }
    return Object.freeze({
      kind: 'user',
      loginId: actsFor.login.toLowerCase(),
      ws: Object.freeze([...ws]),
      modWs: Object.freeze([...mod]),
    });
  }
  if ('agent' in actsFor) {
    const none = Object.freeze({
      kind: 'assistant' as const,
      loginId: null,
      ws: Object.freeze([]),
      modWs: Object.freeze([]),
    });
    if (actsFor.agent === null) return none;
    if (!UUID_RE.test(actsFor.agent)) throw new Error('withViewer: agent must be a uuid');
    const rows = (await admin.execute(
      sqlTag`select a.workspace_id::text as ws from agents a
               join workspaces w on w.id = a.workspace_id and w.archived_at is null
              where a.id = ${actsFor.agent}`,
    )) as unknown as { ws: string }[];
    return Object.freeze({
      kind: 'assistant',
      loginId: null,
      ws: Object.freeze(rows[0]?.ws ? [rows[0].ws] : []),
      modWs: Object.freeze([]),
    });
  }
  const served = actsFor.link.served.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  return Object.freeze({
    kind: 'link',
    loginId: null,
    ws: Object.freeze([]),
    modWs: Object.freeze([]),
    served: Object.freeze([...new Set(served)].sort()),
  });
}

/**
 * Content handle. A Proxy that defers initialisation until the first property
 * access, and picks the pool per access: inside a workspace scope it is the
 * workspace role's pool, so row level security applies.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    // A request scope (W6a, plan 2.3): writes stay on the system pool with
    // their rule in the statement; reads run in the scope. A transaction is
    // a write in a mutating request, and stays in the scope in a read
    // request (a search step that needs one transaction). A raw execute
    // always runs in the scope (fix round 1, M3): a raw write says so with
    // executeWrite.
    const mode = currentRequestMode();
    if (mode && !currentScopeTx()) {
      if (
        prop === 'insert' ||
        prop === 'update' ||
        prop === 'delete' ||
        (prop === 'transaction' && mode.writes)
      ) {
        noteRequestSystemWrite(String(prop));
        // Bound to the system handle (W6a fix round 2): drizzle's builders
        // read `this.session`, which on this proxy is the scope's session, so
        // an unbound method ran the write on the workspace role (a page's
        // block-id backfill failed with permission denied).
        const admin = getAdminDb();
        const fn = Reflect.get(admin as object, prop) as (...args: unknown[]) => unknown;
        return fn.bind(admin);
      }
    }
    if (prop === 'select' || prop === 'selectDistinct' || prop === 'execute' || prop === 'query') {
      noteOwnRuleSystemRead(String(prop));
    }
    return Reflect.get(getDb() as object, prop);
  },
});

/**
 * Whether a raw statement writes (W6a): a leading write verb, or a write
 * clause anywhere (a data-modifying CTE, a row lock). No longer routes a
 * request scope's raw statements (fix round 1, M3: a read it took for a
 * write ran unscoped); executeWrite uses it to refuse a statement that does
 * not write.
 */
export function isWriteSql(text: string): boolean {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (
    /^\s*\(?\s*(insert|update|delete|merge|truncate|lock|refresh|notify|call|do|create|alter|drop)\b/i.test(
      body,
    )
  ) {
    return true;
  }
  return /\b(insert\s+into|delete\s+from|update\s+[\w".]+\s+(as\s+\w+\s+)?set|for\s+(no\s+key\s+)?update|for\s+(key\s+)?share|pg_notify|pg_advisory_x?act_lock|pg_advisory_lock|nextval|setval)\b/i.test(
    body,
  );
}

/** The SQL text of a drizzle query or a string. */
function sqlTextOf(query: unknown): string {
  if (typeof query === 'string') return query;
  const admin = getAdminDb() as unknown as {
    dialect: { sqlToQuery: (q: unknown) => { sql: string } };
  };
  return admin.dialect.sqlToQuery(
    typeof (query as { getSQL?: unknown }).getSQL === 'function'
      ? (query as { getSQL: () => unknown }).getSQL()
      : query,
  ).sql;
}

/** A statement that only reads, sent to executeWrite. */
export class NotAWriteError extends Error {
  constructor() {
    super('executeWrite: the statement does not write; read through db in the caller’s scope.');
    this.name = 'NotAWriteError';
  }
}

/**
 * A raw WRITE, said so (W6a fix round 1, M3). Inside a request scope
 * `db.execute` always runs in the scope, on the workspace role, where a
 * write fails loudly; a raw statement that writes comes here and runs on
 * the system pool, as the typed writes (db.insert, update, delete) do there.
 * Anywhere else it is exactly `db.execute`. Refuses a statement that does
 * not write (isWriteSql), so it is never a door for a read.
 */
export function executeWrite(
  query: Parameters<PostgresJsDatabase<typeof schema>['execute']>[0],
): ReturnType<PostgresJsDatabase<typeof schema>['execute']> {
  if (!isWriteSql(sqlTextOf(query))) throw new NotAWriteError();
  if (currentRequestMode() && !currentScopeTx()) {
    noteRequestSystemWrite('executeWrite');
    return getAdminDb().execute(query);
  }
  return getDb().execute(query);
}

/**
 * Infrastructure handle: always the admin pool, whatever the viewer. For the
 * writes a limited turn still needs (traces, trace steps, tool-result spills,
 * pending tool calls, share counters, access logs). NEVER for content reads:
 * that would read past row level security. Only an allowlisted set of
 * infrastructure modules may import it, and inside a turn scope only they
 * may use it (assertSystemDbCaller, workspaces W4b fix round 2).
 */
export const systemDb = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    if (inTurnScope() && systemDbAccessChecked(prop)) assertSystemDbCaller();
    return Reflect.get(getAdminDb() as object, prop);
  },
});

/**
 * End the pooled connections so a short-lived process can exit.
 *
 * Long-lived servers never call this — the pool is meant to outlive any single
 * request. One-shot CLI scripts MUST, because `postgres()` holds open sockets:
 * once the work is done the event loop still has a live handle and node never
 * exits. That failure is silent and expensive — the app-db and table-workbook
 * backup scripts finished their snapshots, printed their summary, then hung
 * forever; `db-dump.sh` runs `snapshot && tar` inside ONE `docker exec`, so the
 * tar was never reached and every archive landed 0 bytes while the run looked
 * clean. Any script that touches `db` and is expected to terminate needs this.
 *
 * Idempotent, and safe to call when the pool was never opened.
 */
export async function closeDb(): Promise<void> {
  const sql = globalThis.__mantleSql;
  const viewers = globalThis.__mantleViewerDbs;
  globalThis.__mantleSql = undefined;
  globalThis.__mantleDb = undefined;
  globalThis.__mantleViewerDbs = undefined;
  globalThis.__mantleTurnDb = undefined;
  if (sql) await sql.end();
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
