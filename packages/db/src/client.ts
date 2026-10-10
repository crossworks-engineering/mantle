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
