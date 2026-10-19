import { AsyncLocalStorage } from 'node:async_hooks';
import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PgDialect, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index';
import { holderWorkspacesSql } from './grant-reads';
import { runtimeRoleOn } from './runtime-role';
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
  currentRequestMode,
  noteOwnRuleSystemRead,
  noteRequestSystemWrite,
  requestWriteScope,
  currentCreateHome,
  currentSystemTx,
  requestScopeMemo,
  type SystemTxNest,
  boundLoginId,
  carriedWriteScope,
} from './viewer';
import {
  actorCheckMode,
  actorSetting,
  checkActorBound,
  currentActor,
  runAsSystem,
  loginActor,
  systemActor,
  writeModeOf,
  type Actor,
} from './actor';
import { withLease } from './reserved';
import { ACTOR_SQL_TAG } from './gateway/check-mode';
import { actorParams, setActorSql } from './gateway/actor-sql';
import {
  adminSql,
  getAdminDb,
  getViewerDb,
  onCloseDb,
  rawAdminSql,
  turnScopedDbOnce,
} from './gateway/pools';
import {
  levelEnded,
  NESTED_SAVEPOINT_WARN,
  openWriteTx,
  type LoginWriteRoute,
  type WriteTx,
} from './gateway/role-tx';
import {
  checkedUuidOrEmpty,
  joinedBegin,
  loginWritesMayRoute,
  onLoginWritePool,
  ownPrivate,
  systemWriteDb,
  typedWrite,
  uuidArrayLiteral,
  writeRoleBegin,
} from './gateway/write-route';
import { withMigratorConnection } from './migrator-connection';
import { errorMessage, RuntimeFaultError, UUID_RE } from '@mantle/std';
import { noteUnscopedYes } from './fail-open-sites';
import { liveWorkspaceSql } from './workspace-live';

export {
  ACTOR_CHECK_DRIFT_SQL,
  EDIT_CHECK_DRIFT_SQL,
  refreshActorCheckMode,
} from './gateway/check-mode';
export {
  actorClient,
  actorInTransaction,
  needsActorWrap,
  RESET_ACTOR_SQL,
  runsOutsideTransaction,
  setActorSql,
} from './gateway/actor-sql';
export { closeDb, openLoginWritePool, systemPoolRole } from './gateway/pools';
export {
  afterOuterCommit,
  afterOuterRollback,
  inOpenTransaction,
  JoinedWriteEndedError,
  NESTED_SAVEPOINT_WARN,
  setWritePoolWaitForTests,
  watchedSendsForTests,
  WritePoolBusyError,
} from './gateway/role-tx';
export { rawWriteTarget, writeRoleSettingsSql } from './gateway/write-route';

// ── The actor on the system pool (workspaces arch A2a) ──────────────────────

/** The handle properties that send a statement: the TypeScript actor check
 *  (A2a) runs on each access. drizzle's own reads (session, dialect) do
 *  not count. */
const STATEMENT_PROPS: ReadonlySet<PropertyKey> = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'query',
  'transaction',
  'with',
  '$with',
  '$count',
  'refreshMaterializedView',
]);

/**
 * One short transaction on a fresh connection of the system pool, outside
 * every caller's transaction and scope (never joined to an open login write
 * transaction or a savepoint of one, whose link it would wait behind), with
 * `lock_timeout`: a store broker's put-back after a flip that never landed
 * (A3b part 2 fix round 2, N3). `q` runs one statement in it; a lock wait
 * past `lockTimeoutMs` throws (55P03), as does a database that is gone.
 */
export async function brokerLockTx<T>(
  fn: (q: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
  lockTimeoutMs = 2_000,
): Promise<T> {
  const sql = rawAdminSql();
  const ms = Math.max(1, Math.floor(lockTimeoutMs));
  // The raw client: no actor, no scope, no caller transaction to join (it
  // only reads and locks a row).
  return sql.begin(async (t) => {
    await t.unsafe(`set local lock_timeout = '${ms}ms'`);
    return fn(
      async (text, params = []) =>
        (await t.unsafe(text, params as never[])) as unknown as Record<string, unknown>[],
    );
  }) as Promise<T>;
}

/** How the system transaction being opened (withSystemTx) runs: read by
 *  writeTxDb's begin. */
type WriteTxOpen =
  { how: 'write'; route: LoginWriteRoute; saves: { n: number } } | { how: 'join'; open: WriteTx };
const writeTxOpen = new AsyncLocalStorage<WriteTxOpen>();

let writeTxDbCache: PostgresJsDatabase<typeof schema> | null = null;
onCloseDb(() => {
  writeTxDbCache = null;
});

/** A drizzle handle whose transactions open as writeTxOpen says
 *  (withSystemTx's write paths). */
function writeTxDb(): PostgresJsDatabase<typeof schema> {
  return (writeTxDbCache ??= drizzle(
    {
      get options() {
        return adminSql().options;
      },
      begin(...args: unknown[]) {
        const o = writeTxOpen.getStore();
        if (!o) return Promise.reject(new RuntimeFaultError('writeTxDb: no write route'));
        if (o.how === 'join') return joinedBegin(o.open, args);
        return writeRoleBegin(o.route, args, o.saves);
      },
    } as unknown as PgSql,
    { schema },
  ));
}

/** A withSystemTx on the write role, as the outermost system
 *  transaction: its own hooks and nest (openSystemTx). */
function writeRoleSystemTx<T>(
  route: LoginWriteRoute,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  // One savepoint count for the transaction: its nested withSystemTx and
  // its joins (round 3, E).
  return openSystemTx(
    (run, saves) =>
      writeTxOpen.run({ how: 'write', route, saves }, () => writeTxDb().transaction(run)),
    fn,
  );
}

/**
 * withSystemTx inside an open login write transaction of the same route (a
 * request's db.transaction, M2): a savepoint of it, as nestedSystemTx is of
 * a system transaction, never a second connection. An inner error rolls
 * back the inner writes and runs its rollback hooks; on success its hooks
 * follow the outer transaction's end.
 */
async function joinedSystemTx<T>(
  open: WriteTx,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const hooks = newTxHooks();
  // The transaction's own savepoint count (round 3, E).
  const nest: SystemTxNest = { ...systemTxKeys(), busy: false, done: false, saves: open.saves };
  let result: T;
  try {
    result = await writeTxOpen.run({ how: 'join', open }, () =>
      writeTxDb().transaction((tx) => runInSystemTx({ tx, hooks, nest }, () => fn(tx))),
    );
  } catch (err) {
    nest.done = true;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  open.hooks.commit.push(...hooks.commit);
  open.hooks.rollback.push(...hooks.rollback);
  return result;
}

/**
 * A turn's scope was looked for at query time and is gone (workspaces W4b):
 * a query built inside a turn scope ran after the turn ended, or from a
 * callback that does not carry it. Refused, never run unscoped.
 */
export class ScopeLostError extends RuntimeFaultError {
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
 * Exported for reserved.db.test.ts only (not in index.ts).
 */
export function turnScopedClient(base: PgSql): PgSql {
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
    // A connection that died on the way is not handed back (reserved.ts).
    return withLease(base, async (lease) => {
      const conn = lease.sql;
      const begin = conn.unsafe('begin');
      const scope = conn.unsafe(SCOPE_SETTINGS_SQL, settings);
      const q = conn.unsafe(query, (params ?? []) as never[]);
      // A raw caller's simple protocol (a parameterless query with its own
      // literals, entities.ts graph paths) works in a scope too (W7a).
      const main = mode === 'values' ? q.values() : mode === 'simple' ? q.simple() : q;
      const commit = conn.unsafe('commit');
      const out = await Promise.allSettled([begin, scope, main, commit].map((s) => lease.watch(s)));
      const failed = out.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
      return (out[2] as PromiseFulfilledResult<unknown>).value;
    });
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
  return turnScopedDbOnce((base) => drizzle(turnScopedClient(base), { schema }));
}

/** The handle for the current scope (viewer.ts): a scope's own transaction,
 *  a turn scope's per-query handle, else admin (system work). */
function getDb(): PostgresJsDatabase<typeof schema> {
  const tx = currentScopeTx();
  if (tx) return tx as PostgresJsDatabase<typeof schema>;
  if (inTurnScope()) return getTurnScopedDb();
  return getAdminDb();
}

/** A nested system transaction that cannot reuse the open one (arch A2b,
 *  plan 20.2): another actor or create home, a second nested call while one
 *  runs, or a call after the open transaction ended. */
export class NestedSystemTxError extends RuntimeFaultError {
  readonly code = 'nested-system-tx';
  constructor(what: 'actor' | 'create home' | 'parallel' | 'ended') {
    super(
      what === 'parallel'
        ? 'withSystemTx: a nested call while another nested call runs on the same transaction is refused'
        : what === 'ended'
          ? 'withSystemTx: a nested call after its transaction ended is refused (a detached call?)'
          : `withSystemTx: a nested call with a different ${what} than the open transaction is refused`,
    );
    this.name = 'NestedSystemTxError';
  }
}

/** What a system transaction opened now would run as: its actor and create
 *  home, as keys a nested call compares (SystemTxNest). The write scope is
 *  not one: inside a system transaction it reads as none (the transaction
 *  masks the request's), so the open one's applies. */
function systemTxKeys(): Pick<SystemTxNest, 'actor' | 'home'> {
  const actor = currentActor();
  const home = currentCreateHome();
  return {
    actor: actor ? `${actorSetting(actor)}|${writeModeOf(actor)}` : '',
    home: home
      ? JSON.stringify([home.createWs, home.privateWs, !!home.quiet, home.stamp ?? null])
      : '',
  };
}

/**
 * withSystemTx nested in an open system transaction (arch A2b, plan 20.2;
 * A2b1 audit M2): a SAVEPOINT of that transaction, never a second one. An
 * inner error rolls back the inner writes only, and runs the inner
 * rollback hooks; on success the inner hooks join the outer ones and
 * follow its outcome. One nested call at a time per level, and none after
 * the level ended (a detached call).
 */
async function nestedSystemTx<T>(
  outer: NonNullable<ReturnType<typeof currentSystemTx>>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  if (outer.nest.done) throw new NestedSystemTxError('ended');
  if (outer.nest.busy) throw new NestedSystemTxError('parallel');
  const want = systemTxKeys();
  if (want.actor !== outer.nest.actor) throw new NestedSystemTxError('actor');
  if (want.home && want.home !== outer.nest.home) throw new NestedSystemTxError('create home');
  const hooks = newTxHooks();
  const nest: SystemTxNest = {
    actor: outer.nest.actor,
    home: outer.nest.home,
    busy: false,
    done: false,
    saves: outer.nest.saves,
  };
  // Counted once (round 4, N2): on the write role its savepoint goes
  // through joinWriteTx, which counts it in the same count. Only when this
  // system transaction is that write transaction (round 5, N6): a system
  // pool one inside a live write transaction counts its own.
  const onRole = openWriteTx.getStore();
  const countedByJoin = !!onRole && !levelEnded(onRole) && onRole.saves === outer.nest.saves;
  if (!countedByJoin) outer.nest.saves.n += 1;
  if (!countedByJoin && outer.nest.saves.n === NESTED_SAVEPOINT_WARN + 1) {
    console.warn(
      `[db] withSystemTx: more than ${NESTED_SAVEPOINT_WARN} nested calls in one transaction ` +
        '(a nested write in a loop?): past 64 subtransactions that write, every snapshot ' +
        'on the box gets slower (docs/actors.md)',
    );
  }
  outer.nest.busy = true;
  let result: T;
  try {
    result = await (outer.tx as PostgresJsDatabase<typeof schema>).transaction((sp) =>
      runInSystemTx({ tx: sp, hooks, nest }, () =>
        fn(sp as unknown as PostgresJsDatabase<typeof schema>),
      ),
    );
  } catch (err) {
    nest.done = true;
    outer.nest.busy = false;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  outer.nest.busy = false;
  outer.hooks.commit.push(...hooks.commit);
  outer.hooks.rollback.push(...hooks.rollback);
  return result;
}

/**
 * Run `fn` in ONE admin-pool transaction, on its own connection: every `db`
 * query inside is that transaction (`fn` gets it too). `afterCommit` work
 * inside runs once it commits, `afterRollback` work once it rolls back:
 * file side effects follow the rows they belong to (team apps follow-up).
 * Only from outside any viewer scope and outside another transaction scope,
 * or nested in a system transaction: then it is a savepoint of that one
 * (nestedSystemTx), for the same actor and create home only.
 */
export async function withSystemTx<T>(
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const outer = currentSystemTx();
  if (outer) return nestedSystemTx(outer, fn);
  // A request scope (W6a) writes through here: writes stay on the system
  // pool with their rule in the statement (plan 2.3), in a read request too
  // (a lazy backfill, a root folder made on first open).
  const inRequest = currentRequestMode() !== null;
  if ((!isSystemScope() && !inRequest) || currentScopeTx()) {
    throw new RuntimeFaultError(
      'withSystemTx: only outside a viewer scope and any other transaction',
    );
  }
  // Tests and development: a request scope's system transaction is one of
  // its writes (W6a fix round 2, L-c), pinned by the route sweep with the
  // file that opened it.
  if (inRequest) noteRequestSystemWrite('withSystemTx');
  // Arch A2a: the transaction runs as the current actor (actorClient sets
  // it first); none bound is a miss, logged only.
  checkActorBound('withSystemTx');
  // A scoped write (a login's, an Admin user's write request, an Admin
  // turn) runs on the write role when the gateway says so (arch A2b2b):
  // its scope, actor and create home set by one SET LOCAL with its first
  // statement. Else the system pool, as before.
  return onLoginWritePool({
    system: () => systemPoolTx(fn),
    write: (route) => writeRoleSystemTx(route, fn),
    join: (open) => joinedSystemTx(open, fn),
  });
}

/** A login's scope on the system pool (`ws` null: only its login). */
export type SystemPoolScope = {
  loginId: string | null;
  ws: readonly string[] | null;
  modWs: readonly string[] | null;
};

/** A write scope on a system-pool transaction (systemPoolTx,
 *  systemPoolTxInScope): its workspaces and login (mantle.scope_login,
 *  never mantle.login_id). The one text that sets them on the system pool;
 *  eslint-rules/scope-settings.mjs pins where the settings are named. */
function writeScopeSettings(scope: SystemPoolScope) {
  const ws = scope.ws === null ? '' : uuidArrayLiteral(scope.ws, 'write scope ws');
  const modWs = scope.modWs === null ? '' : uuidArrayLiteral(scope.modWs, 'write scope modWs');
  return sqlTag`select set_config('mantle.ws', ${ws}, true),
                       set_config('mantle.mod_ws', ${modWs}, true),
                       set_config('mantle.scope_login', ${checkedUuidOrEmpty(scope.loginId)}, true)`;
}

/** THE one system-pool transaction in a login's scope set by hand, for a
 *  workspace definer that asks the acting login (0307) where no request
 *  scope carries one. Each caller is pinned (eslint-rules/scope-settings.mjs):
 *  a new one fails the pin until it is reviewed. */
export function systemPoolTxInScope<T>(
  scope: SystemPoolScope,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  return getAdminDb().transaction(async (tx) => {
    await tx.execute(writeScopeSettings(scope));
    return fn(tx);
  });
}

/** A system transaction as before A2b2b, on the system pool. */
function systemPoolTx<T>(fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>): Promise<T> {
  // A login's write request on the system pool (no write pool in this
  // process; W6a fix round 1, M1, every login's since
  // F4): the login's scope on the transaction, so the database checks moves
  // (0241/0245), creates in a folder and deletes (0266) against its
  // workspaces, as before the write role. mantle.login_id is
  // left unset: the 0250 and 0269 stamps would otherwise mark trace, run,
  // chat and digest rows made in the same transaction as this login's, and
  // 0279's audit rows would name it, which nothing asks for. The login goes
  // in mantle.scope_login instead (arch A6 fix round 1, M1), which only the
  // scope's checks read (mantle_scope_login_id, 0291: the 0291 definers'
  // per-login item gate and mantle_scope_has_area), never a stamp or a row
  // rule, so the scope's checks answer for this login as in its own scope.
  const writeScope = requestWriteScope();
  // Where a create lands (W6b): the database's default home reads these.
  const home = currentCreateHome();
  const homeSettings = home
    ? [
        checkedUuidOrEmpty(home.createWs),
        checkedUuidOrEmpty(home.privateWs),
        home.stamp && Object.keys(home.stamp).length > 0 ? JSON.stringify(home.stamp) : '',
      ]
    : null;
  return openSystemTx(
    (run) =>
      getAdminDb().transaction(async (tx) => {
        if (writeScope) await tx.execute(writeScopeSettings(writeScope));
        if (homeSettings) {
          await tx.execute(
            sqlTag`select set_config('mantle.create_ws', ${homeSettings[0]}, true),
                          set_config('mantle.private_ws', ${homeSettings[1]}, true),
                          set_config('mantle.ingest_notify', ${home?.quiet ? 'off' : ''}, true),
                          set_config('mantle.create_stamp', ${homeSettings[2]}, true)`,
          );
        }
        return run(tx);
      }),
    fn,
  );
}

/** Run `fn` as the outermost system transaction that `open` opens: its own
 *  hooks and nest (withSystemTx's rules), its rollback hooks run when it
 *  fails, its commit hooks once it commits. */
async function openSystemTx<T>(
  open: (
    run: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
    saves: { n: number },
  ) => Promise<T>,
  fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const hooks = newTxHooks();
  const nest: SystemTxNest = { ...systemTxKeys(), busy: false, done: false, saves: { n: 0 } };
  let result: T;
  try {
    result = await open((tx) => runInSystemTx({ tx, hooks, nest }, () => fn(tx)), nest.saves);
  } catch (err) {
    nest.done = true;
    await runTxHooks(hooks.rollback, 'rollback');
    throw err;
  }
  nest.done = true;
  await runTxHooks(hooks.commit, 'commit');
  return result;
}

/**
 * login(rw | owner) for `loginId`, read as that login is NOW (arch A2a, plan
 * 4.1): deferred work done for a login (a run, a heartbeat, a pending call,
 * a turn) binds this when it runs, not what the login was when the work was
 * queued. A2a refuses nothing: a login disabled since (or gone) is still
 * bound and named in one warning. `entry` is the system reason of the entry
 * asking (worker:runs); a bad id gives system(entry).
 */
export async function loginActorNow(
  loginId: string,
  entry: string,
  mode: 'rw' | 'owner' = 'rw',
): Promise<Actor> {
  let actor: Actor;
  try {
    actor = loginActor(loginId, mode);
  } catch {
    return systemActor(entry);
  }
  // With the check off nothing reads the actor: no query (fix round, L1;
  // the owner's rule, no new query on a hot path while off).
  if (actorCheckMode() === 'off') return actor;
  try {
    const rows = (await runAsSystem(entry, () =>
      getAdminDb().execute(
        // The actor's own lookup: tagged (ACTOR_SQL_TAG).
        sqlTag`/* mantle:actor */ select disabled_at is not null as off from auth.users where id = ${loginId}::uuid`,
      ),
    )) as unknown as { off: boolean }[];
    if (!rows[0] || rows[0].off) {
      console.warn(`[${entry}] login ${loginId} is disabled now; the work runs as it anyway (A2a)`);
    }
  } catch (err) {
    console.warn(`[${entry}] could not read login ${loginId}: ${errorMessage(err)}`);
  }
  return actor;
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
    throw new RuntimeFaultError('withScope: already inside a scope');
  }
  // The one scope check (scopeProblem), in withScope's own words; unlike a
  // turn, a request scope may read no workspace (an empty list reads nothing).
  const problem = scopeProblem(scope, 'withScope', { needsWorkspace: false });
  if (problem) throw new Error(problem);
  const ws = uuidArrayLiteral(scope.ws, 'withScope ws');
  const mod = uuidArrayLiteral(scope.modWs, 'withScope modWs');
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
 * Without `writes` it only reads (a write meets the workspace role and is
 * refused); with it, a write goes through the login write gateway in this
 * scope (turnScopeWrites decides it for a turn).
 */
export async function withTurnScope<T>(
  scope: WorkspaceScope,
  fn: () => Promise<T>,
  opts: { writes?: boolean } = {},
): Promise<T> {
  const problem = turnScopeProblem(scope);
  if (problem) throw new Error(problem);
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

/**
 * Why withTurnScope refuses `scope`, or null: a login id or a workspace id
 * that is not a uuid, no workspace at all, or a Moderator workspace the
 * scope does not read. The one check: withTurnScope throws it, and the gate
 * (gate.ts) asks it before it lists or calls, so listing equals calling.
 */
export function turnScopeProblem(scope: WorkspaceScope): string | null {
  return scopeProblem(scope, 'withTurnScope', { needsWorkspace: true });
}

/**
 * The one scope check, worded for the function that asks it (`prefix`):
 * withTurnScope (turnScopeProblem, and the gate through it) and withScope.
 * `needsWorkspace`: no workspace at all is a problem (a turn); a request
 * scope (withScope) may read none.
 */
function scopeProblem(
  scope: WorkspaceScope,
  prefix: 'withTurnScope' | 'withScope',
  opts: { needsWorkspace: boolean },
): string | null {
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    return `${prefix}: loginId must be a uuid`;
  }
  for (const [ids, what] of [
    [scope.ws, `${prefix} ws`],
    [scope.modWs, `${prefix} modWs`],
  ] as const) {
    for (const id of ids) {
      if (!UUID_RE.test(id)) return `${what}: not a uuid: ${String(id).slice(0, 40)}`;
    }
  }
  if (opts.needsWorkspace && scope.ws.length === 0) {
    return `${prefix}: a turn reads at least one workspace`;
  }
  const inWs = new Set(scope.ws);
  if (scope.modWs.some((id) => !inWs.has(id))) return `${prefix}: modWs must be a subset of ws`;
  return null;
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
 * unscoped system work (the owner's paths) yes; a workspace scope when it holds
 * the Admin workspace (asked of the database once per scope). Fails closed:
 * an error reads as no.
 */
export async function scopeHoldsAdmin(): Promise<boolean> {
  const scope = currentWorkspaceScope();
  if (!scope) return noteUnscopedYes('scope-holds-admin', isUnscoped());
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
      return noteUnscopedYes('scope-has-area', true);
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

/** A login fact refused for a missing grant (42501) still answers no, but
 *  says so once per process: a lost EXECUTE grant shows in the log. */
let loginFactDeniedLogged = false;
function loginFactFailed(err: unknown): false {
  if (!loginFactDeniedLogged && sqlState(err) === '42501') {
    loginFactDeniedLogged = true;
    console.warn(`[db] a login fact was refused (42501), it answers no: ${errorMessage(err)}`);
  }
  return false;
}

/**
 * Whether `loginId` is a user of this brain's live Admin workspace now, its
 * login enabled (W7 integration fix 3, L1), never the admin role alone (a
 * login taken out of Admin keeps its role): mantle_login_is_admin (0304).
 * Fails closed. Admin pool.
 */
export async function loginHoldsAdmin(loginId: string): Promise<boolean> {
  if (!UUID_RE.test(loginId)) return false;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_login_is_admin"(${loginId}::uuid) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch (err) {
    return loginFactFailed(err);
  }
}

/**
 * Whether login `loginId` holds Admin `area` now, asked on the system pool
 * for a login other than the current caller (W7a fix round 3: the maker of
 * an API tool, when the tool's secret refs resolve at run time): the area
 * rule, mantle_area_rule (0304). Fails closed.
 */
export async function loginHasArea(loginId: string, area: ScopeArea): Promise<boolean> {
  if (!SCOPE_AREAS.includes(area) || !UUID_RE.test(loginId)) return false;
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_area_rule"(${loginId}::uuid, ${area}) as a`,
    )) as unknown as { a: boolean }[];
    return rows[0]?.a === true;
  } catch (err) {
    return loginFactFailed(err);
  }
}

/** The Admin areas `loginId` holds now, in SCOPE_AREAS order (mantle_login_areas,
 *  0304: the strict rule), on the system pool as loginHasArea. Fails closed. */
export async function loginAreas(loginId: string): Promise<ScopeArea[]> {
  if (!UUID_RE.test(loginId)) return [];
  try {
    const rows = (await getAdminDb().execute(
      sqlTag`select "public"."mantle_login_areas"(${loginId}::uuid) as a`,
    )) as unknown as { a: ScopeArea[] | null }[];
    return rows[0]?.a ?? [];
  } catch (err) {
    loginFactFailed(err);
    return [];
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
  // Nested in a system transaction (arch A2b, plan 20.2): the database
  // decides (mantle_lock_heads_nested, 0277): more heads where it holds
  // some (FOR UPDATE NOWAIT; a busy one fails with 55P03 and the outermost
  // call retries), else the first lock with its rules. Never a second
  // first lock.
  const nested = currentSystemTx() !== null;
  return withSystemTx(async (tx) => {
    if (nested) await tx.execute(sqlTag`select mantle_lock_heads_nested(${list}::uuid[], ${mode})`);
    else await tx.execute(sqlTag`select mantle_lock_heads(${list}::uuid[], ${mode})`);
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
    // A first lock: nested in a transaction that holds heads, the database
    // refuses it (55000, mantle_lock_heads); lock the subtree in the
    // outermost call (arch A2b, plan 20.2).
    await tx.execute(sqlTag`select mantle_lock_subtree_heads(${root}::uuid, ${list}::uuid[])`);
    return fn(tx);
  });
}

/** The open system transaction (it sees its own rows), else the system
 *  pool: where a heads helper reads which heads to take (arch A2b). */
function systemTxOrPool(): PostgresJsDatabase<typeof schema> {
  return (currentSystemTx()?.tx as PostgresJsDatabase<typeof schema> | undefined) ?? getAdminDb();
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
    const rows = (await systemTxOrPool().execute(
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
  const rows = (await systemTxOrPool().execute(
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
    throw new RuntimeFaultError('withSpaceRows: only inside a personal-space scope (withSpace)');
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
  // Inside an open system transaction (arch A2b, plan 20.2) a retry cannot
  // start afresh: the error goes to the outermost call, which retries.
  if (currentSystemTx()) return run();
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
          join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
         where u.login_id = ${loginId}::uuid), '{}') else '{}' end`,
    scopeModWs: sqlTag<string[]>`case when ${disabledAt} is null then coalesce((
        select array_agg(u.workspace_id::text order by u.workspace_id)
          from workspace_users u
          join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
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

/**
 * Which of `wsIds` `loginId` holds a Moderator seat in now (A8 fix round 1,
 * L5), for a turn's write (@mantle/tools moderator-seat.ts): one indexed
 * read of workspace_users, in the turn's scope (its seats are in its ws).
 */
export async function moderatorSeatsNow(
  loginId: string,
  wsIds: readonly string[],
): Promise<string[]> {
  if (!UUID_RE.test(loginId) || wsIds.length === 0) return [];
  if (!wsIds.every((w) => UUID_RE.test(w))) return [];
  const rows = (await db.execute(sqlTag`
    select workspace_id::text as ws from workspace_users
     where login_id = ${loginId}::uuid and moderator
       and workspace_id = any(${`{${wsIds.join(',')}}`}::uuid[])`)) as unknown as { ws: string }[];
  return rows.map((r) => r.ws);
}

/**
 * The fallback of a login's create home (docs/workspaces.md, "Where a new
 * item lands"; W6b): for a login outside the Admin workspace (`ownWork`;
 * 'auto' asks the database) its private workspace, made now when
 * `makePrivate` and it has none; with no workspace to make one in,
 * refused. An Admin user has no private fallback (null): the folder's home,
 * else Admin. Only createHomeIntent (create-home.ts, the one create-home
 * intent of arch A3c) calls it; not exported from the package.
 *
 * Admin pool: it names a place, it grants nothing (the database's create
 * checks still run).
 */
export async function createHomeFallback(
  loginId: string,
  o: { ownWork: boolean | 'auto'; makePrivate: boolean },
): Promise<{ privateWs: string | null } | { refused: 'no-workspace'; message: string }> {
  const admin = getAdminDb();
  const ownWork =
    o.ownWork === 'auto'
      ? !(
          (await admin.execute(sqlTag`
            select 1 from workspace_users u
              join workspaces w on w.id = u.workspace_id and w.is_admin and ${liveWorkspaceSql('w')}
             where u.login_id = ${loginId}::uuid limit 1`)) as unknown as unknown[]
        ).length
      : o.ownWork;
  if (!ownWork) return { privateWs: null };
  if (!o.makePrivate) {
    const own = (await admin.execute(sqlTag`
      select p.workspace_id::text as ws from private_workspaces p
        join workspaces w on w.id = p.workspace_id and ${liveWorkspaceSql('w')}
       where p.login_id = ${loginId}::uuid`)) as unknown as { ws: string }[];
    return { privateWs: ownPrivate(loginId, own[0]?.ws ?? null) };
  }
  // The definer makes only the acting login's own (0307):
  // the scope's login (mantle.scope_login, read by the scope's checks only)
  // is the login bound to this call, never the one asked for.
  const bound = boundLoginId();
  if (bound === null || bound !== loginId.toLowerCase()) {
    throw new RuntimeFaultError('createHomeFallback: the login asked for is not the one bound');
  }
  const rows = (await systemPoolTxInScope({ loginId: bound, ws: null, modWs: null }, (tx) =>
    tx.execute(sqlTag`select "public"."mantle_ws_private_workspace"(${loginId}::uuid)::text as ws`),
  )) as unknown as { ws: string | null }[];
  const privateWs = ownPrivate(loginId, rows[0]?.ws ?? null);
  if (!privateWs) {
    return { refused: 'no-workspace', message: 'You have no workspace to create in yet.' };
  }
  return { privateWs };
}

/** The live workspaces beyond Admin an app run reads through (AppRunFor):
 *  a brain app's holders from its grants. `{ team: true }`, an id that is
 *  not an app, and an app with no live holder beyond Admin read nothing
 *  (they read the built-in Team workspace until 0286 made it a normal one;
 *  no workspace stands in for "team rules" now). Admin pool. */
async function appRunHolders(app: AppRunFor): Promise<string[]> {
  if (!('id' in app)) return [];
  if (!UUID_RE.test(app.id)) throw new Error('withViewer: app must be a uuid');
  const [row] = (await getAdminDb().execute(
    sqlTag`select coalesce(array(
                    select w.id::text from workspaces w
                     where w.id = any(n.read_ws) and ${holderWorkspacesSql(sqlTag`array[w.id]`)}
                     order by w.id), '{}') as live
             from nodes n
            where n.id = ${app.id} and n.type = 'app'`,
  )) as unknown as { live: string[] }[];
  return row ? [...row.live] : [];
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
               join workspaces w on w.id = u.workspace_id and ${liveWorkspaceSql('w')}
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
               join workspaces w on w.id = a.workspace_id and ${liveWorkspaceSql('w')}
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
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`db.${String(prop)}`);
    const carried = carriedWriteScope();
    if (carried) return systemPoolProp(carried, prop);
    // A request scope (W6a, plan 2.3): a write leaves the scope's read pool
    // (a login's to the write role while it may route, else the system
    // pool); reads run in the scope. A transaction is
    // a write in a mutating request, and stays in the scope in a read
    // request (a search step that needs one transaction). A raw execute
    // always runs in the scope (fix round 1, M3): a raw write says so with
    // executeWrite.
    const mode = currentRequestMode();
    const write = prop === 'insert' || prop === 'update' || prop === 'delete';
    if (mode && !currentScopeTx()) {
      if (write || (prop === 'transaction' && mode.writes)) {
        noteRequestSystemWrite(String(prop));
        // Bound to the system handle (W6a fix round 2): drizzle's builders
        // read `this.session`, which on this proxy is the scope's session, so
        // an unbound method ran the write on the workspace role (a page's
        // block-id backfill failed with permission denied). The login write
        // gateway's handle when it may route (A2b2b): it sends a scoped
        // login write to the write role, anything else here as before.
        if (write) return typedWrite(prop, loginWritesMayRoute());
        const handle = systemWriteDb();
        const fn = Reflect.get(handle as object, prop) as (...args: unknown[]) => unknown;
        return fn.bind(handle);
      }
    }
    if (prop === 'select' || prop === 'selectDistinct' || prop === 'execute' || prop === 'query') {
      noteOwnRuleSystemRead(String(prop));
    }
    return Reflect.get(getDb() as object, prop);
  },
});

/** The system pool's `prop`, a transaction with `scope` set first
 *  (withSystemPoolInWriteScope, viewer.ts). */
function systemPoolProp(scope: WorkspaceScope, prop: string | symbol): unknown {
  const admin = getAdminDb();
  if (prop !== 'transaction') return Reflect.get(admin as object, prop);
  return <T>(fn: (tx: PostgresJsDatabase<typeof schema>) => Promise<T>) =>
    systemPoolTxInScope(scope, fn);
}

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
export class NotAWriteError extends RuntimeFaultError {
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
    return systemWriteDb().execute(query);
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
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`systemDb.${String(prop)}`);
    if (inTurnScope() && systemDbAccessChecked(prop)) assertSystemDbCaller();
    return Reflect.get(getAdminDb() as object, prop);
  },
});

/**
 * Work the runtime role may not do (arch A9): the workspaces switch runs
 * DDL (mantle_ws_migrate_locked, at the first owner and at boot). With
 * MANTLE_DB_RUNTIME_ROLE on it runs on the migrator's URL (DATABASE_URL,
 * the role that runs the migrations) in one transaction of its own, with
 * the actor bound now, on a connection opened for it and closed after.
 * Off, it runs on `db` as before. Only the switch calls it: every other
 * statement of the app runs as the runtime role (runtime-role.ts).
 */
export async function executeAsMigrator<T extends Record<string, unknown>>(
  query: SQL,
): Promise<T[]> {
  if (!runtimeRoleOn()) {
    return [...((await db.execute(query)) as unknown as T[])];
  }
  checkActorBound('executeAsMigrator');
  const { sql: text, params } = new PgDialect().sqlToQuery(query);
  const rows = await withMigratorConnection((conn) =>
    conn.begin(async (tx) => {
      const actor = actorParams();
      if (actor) await tx.unsafe(`${ACTOR_SQL_TAG} ${setActorSql(actor)}`);
      return [...(await tx.unsafe(text, params as never[]))];
    }),
  );
  return rows as unknown as T[];
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
