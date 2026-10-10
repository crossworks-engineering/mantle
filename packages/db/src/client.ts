import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';
import { env, envFlag } from '@mantle/config';
import {
  currentScopeTx,
  currentSpaceScope,
  currentViewerLevel,
  newTxHooks,
  runInSystemTx,
  runInTxScope,
  runInWorkspaceTx,
  currentWorkspaceScope,
  type WorkspaceScope,
  runTxHooks,
  withViewer,
  viewerDatabaseUrl,
  viewerRolePassword,
  type PoolRole,
} from './viewer';

declare global {
  var __mantleSql: ReturnType<typeof postgres> | undefined;

  var __mantleDb: PostgresJsDatabase<typeof schema> | undefined;

  /** One small pool per limited level (see viewer.ts), opened on first use. */
  var __mantleViewerDbs:
    | Map<PoolRole, { sql: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }>
    | undefined;
}

/** Connections per limited pool. Small on purpose: max_connections is 200
 *  and every process of a box opens its own pools. */
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
 * The limited pool for a viewer level: logs in as that level's LOGIN role,
 * so row level security filters every read. Fails loudly (never falls back to
 * the admin pool) when the master key is missing or the role cannot log in.
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
  });
  const client = drizzle(sql, { schema });
  pools.set(level, { sql, db: client });
  return client;
}

/** The handle for the current scope (viewer.ts): a scope's own transaction
 *  (a personal space, team drafts), else the level's pool, else admin. */
function getDb(): PostgresJsDatabase<typeof schema> {
  const tx = currentScopeTx();
  if (tx) return tx as PostgresJsDatabase<typeof schema>;
  const level = currentViewerLevel();
  return level === 'admin' ? getAdminDb() : getViewerDb(level);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The level a login's personal space runs at (client logins C1): team for an
 * admin or a member, client for a client. A role this code does not know has
 * no space level: withSpace refuses it (fail closed). Read on the admin pool
 * on every call, never cached: the row is the truth.
 *
 * The one query also checks the pair (client logins audit A16): the space
 * must be this login's (`spaces.login_id`), and the login must be active
 * (`disabled_at IS NULL`). Every caller takes both ids from one session
 * today; this keeps a future caller that mixes them up from acting in
 * another login's space, or for a disabled login.
 */
export async function spaceLevelForLogin(
  loginId: string,
  spaceId: string,
): Promise<'team' | 'client'> {
  const rows = (await getAdminDb().execute(
    sqlTag`select u.role,
                  u.disabled_at is null as active,
                  exists (select 1 from spaces s
                           where s.id = ${spaceId} and s.login_id = u.id) as owns_space
             from auth.users u where u.id = ${loginId}`,
  )) as unknown as { role: string; active: boolean; owns_space: boolean }[];
  const row = rows[0];
  if (!row) throw new Error('withSpace: no such login');
  if (!row.owns_space) throw new Error('withSpace: the space is not this login’s');
  if (!row.active) throw new Error('withSpace: the login is disabled');
  switch (row.role) {
    case 'admin':
    case 'member':
      return 'team';
    case 'client':
      return 'client';
    default:
      throw new Error('withSpace: this login has no personal space level');
  }
}

/**
 * Run `fn` for ONE personal space (member logins Phase 2, plan section 2b).
 * Opens a short transaction on the personal-space role (`mantle_view_space`)
 * that sets `mantle.space_id` and `mantle.login_id`; every `db` query inside
 * runs in it, so row level security shows and accepts only that space's rows.
 * Keep it short: never hold one across an LLM call.
 *
 * The scope's level comes from the login's role (client logins C1): team for
 * an admin or a member, client for a client. The level only goes down, so a
 * `withViewer('team', …)` inside a client's space reads at client.
 *
 * Nesting: the same space reuses the open transaction; another space throws.
 * `withViewer('team', …)` inside leaves the space for the brain's Library;
 * `asSystem` leaves it for the admin pool.
 */
export async function withSpace<T>(
  scope: { spaceId: string; loginId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(scope.spaceId) || !UUID_RE.test(scope.loginId)) {
    throw new Error('withSpace: spaceId and loginId must be uuids');
  }
  const open = currentSpaceScope();
  if (open && currentScopeTx()) {
    if (open.spaceId !== scope.spaceId || open.loginId !== scope.loginId) {
      throw new Error('withSpace: already acting for another space');
    }
    return fn();
  }
  const level = await spaceLevelForLogin(scope.loginId, scope.spaceId);
  // Disk work tied to this transaction (afterCommit / afterRollback) runs
  // once it has ended, never inside it.
  const hooks = newTxHooks();
  let result: T;
  try {
    result = await getViewerDb('space').transaction(async (tx) => {
      await tx.execute(
        sqlTag`select set_config('mantle.space_id', ${scope.spaceId}, true),
                      set_config('mantle.login_id', ${scope.loginId}, true)`,
      );
      return runInTxScope({ level, space: { ...scope }, tx, hooks }, fn);
    });
  } catch (err) {
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

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
  if (currentViewerLevel() !== 'admin' || currentScopeTx()) {
    throw new Error('withSystemTx: only outside a viewer scope and any other transaction');
  }
  const hooks = newTxHooks();
  let result: T;
  try {
    result = await getAdminDb().transaction((tx) => runInSystemTx({ tx, hooks }, () => fn(tx)));
  } catch (err) {
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(hooks.commit, 'commit');
  return result;
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
 * Run `fn` at the team level with the human flag on: the only scope in which
 * other members' TEAM-SHARED personal items (team drafts) are visible, next
 * to the Library (plan 2b: agents never read other people's drafts, and no
 * agent path sets the flag). One short transaction on the team pool.
 */
export async function withTeamDrafts<T>(fn: () => Promise<T>): Promise<T> {
  return withHumanViewer('team', fn);
}

/**
 * Run `fn` at `level` (team or client) with the human flag on: a login's own
 * request, never an agent (no agent path calls this). For team: Team drafts
 * and a client's submitted items (client requests, 0194); for both: the
 * client thread on a client-level brain item (0194, decision 8). One short
 * transaction on that level's pool. Inside a lower scope the level only goes
 * down (withViewer), and the flag is set on the transaction this opens.
 */
export async function withHumanViewer<T>(
  level: 'team' | 'client',
  fn: () => Promise<T>,
): Promise<T> {
  return withViewer(level, () => {
    const effective = currentViewerLevel();
    if (effective !== 'team' && effective !== 'client') {
      throw new Error(`withHumanViewer: no human scope at ${effective}`);
    }
    return getViewerDb(effective).transaction(async (tx) => {
      await tx.execute(sqlTag`select set_config('mantle.human', 'on', true)`);
      return runInTxScope({ level: effective, tx }, fn);
    });
  });
}

/**
 * Content handle. A Proxy that defers initialisation until the first property
 * access, and picks the pool per access: inside `withViewer(level, …)` it is
 * that level's limited pool, so row level security applies.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    return Reflect.get(getDb() as object, prop);
  },
});

/**
 * Infrastructure handle: always the admin pool, whatever the viewer. For the
 * writes a limited turn still needs (traces, trace steps, tool-result spills,
 * pending tool calls, share counters, access logs). NEVER for content reads:
 * that would read past row level security. Only an allowlisted set of
 * infrastructure modules may import it.
 */
export const systemDb = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
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
  if (sql) await sql.end();
  if (viewers) await Promise.all([...viewers.values()].map((v) => v.sql.end()));
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
