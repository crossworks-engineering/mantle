/**
 * The system transaction (withSystemTx): the outermost one on the system
 * pool or on the write role, a nested call as a savepoint of the open one,
 * a call joined to an open login write transaction, a write scope set by
 * hand on the system pool (systemPoolTxInScope), and brokerLockTx, the one
 * short transaction outside every caller's. One owner for the write paths'
 * handle and its cache (writeTxOpen, writeTxDb).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../schema/index';
import { RuntimeFaultError } from '@mantle/std';
import {
  currentCreateHome,
  currentRequestMode,
  currentScopeTx,
  currentSystemTx,
  isSystemScope,
  newTxHooks,
  noteRequestSystemWrite,
  requestWriteScope,
  runInSystemTx,
  runTxHooks,
  type SystemTxNest,
} from '../viewer';
import { actorSetting, checkActorBound, currentActor, writeModeOf } from '../actor';
import { adminSql, getAdminDb, onCloseDb, rawAdminSql } from './pools';
import {
  levelEnded,
  NESTED_SAVEPOINT_WARN,
  currentWriteTx,
  type LoginWriteRoute,
  type WriteTx,
} from './role-tx';
import { joinedBegin, writeRoleBegin } from './role-runner';
import { checkedUuidOrEmpty, onLoginWritePool, uuidArrayLiteral } from './write-route';
import { gatewaySettings } from './narrow-route';

type PgSql = ReturnType<typeof postgres>;

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
  const onRole = currentWriteTx();
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
  // The actor's write mode too, in every check mode: a definer's read-only
  // refusal reads mantle.write_mode (mantle_ws_archive), and with the check
  // off nothing else sets it on this path.
  const actor = currentActor();
  const writeMode = actor ? writeModeOf(actor) : '';
  return sqlTag`select set_config('mantle.ws', ${ws}, true),
                       set_config('mantle.mod_ws', ${modWs}, true),
                       set_config('mantle.scope_login', ${checkedUuidOrEmpty(scope.loginId)}, true),
                       set_config('mantle.write_mode', ${writeMode}, true)`;
}

/** Send a write scope's SET (writeScopeSettings) on a system-pool
 *  transaction: the gateway's own, so on the narrow route it may name the
 *  scope's settings (narrow-route.ts gatewaySettings). */
async function sendWriteScope(
  tx: PostgresJsDatabase<typeof schema>,
  scope: SystemPoolScope,
): Promise<void> {
  await gatewaySettings(async () => {
    await tx.execute(writeScopeSettings(scope));
  });
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
    await sendWriteScope(tx, scope);
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
        if (writeScope) await sendWriteScope(tx, writeScope);
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
