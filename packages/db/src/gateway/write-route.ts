/**
 * The login write gateway's route: whether a write that runs now goes to
 * the write role (loginWriteRoute) and the one SET it carries there
 * (writeRoleSettingsSql), the write scope with the login's own private
 * workspace, the gateway's runner (a statement outside a transaction as one
 * pipelined transaction on the write role, a transaction, a join), and the
 * client and drizzle handle behind scoped writes (loginWriteClient). One
 * owner for the private workspaces read and the handle's cache.
 */
import { is } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PgTable } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import * as schema from '../schema/index';
import { UUID_RE } from '@mantle/std';
import {
  currentCreateHome,
  requestWriteScope,
  runTxHooks,
  type CreateHome,
  type WorkspaceScope,
} from '../viewer';
import { actorCheckMode, actorSetting, currentActor, writeModeOf, type Actor } from '../actor';
import { permissionGapOf } from '../pg-error';
import { WRITE_ROLE_TABLES } from '../access-matrix';
import { noteScopedSystemWrite, tableNameOf } from '../fail-open-sites';
import { ACTOR_SQL_TAG, firstModeReadNow } from './check-mode';
import {
  MORE_STATEMENTS,
  runsOutsideTransaction,
  setActorSql,
  settingsFirst,
  statementBody,
} from './actor-sql';
import { adminSql, getAdminDb, loginWritePoolOpen, onCloseDb } from './pools';
import {
  boundedBegin,
  boundedReserve,
  JoinedWriteEndedError,
  joinableWriteTx,
  joinWriteTx,
  lazyQuery,
  levelEnded,
  newWriteTx,
  noteWriteRoleDenial,
  openWriteTx,
  sendIn,
  watchTx,
  type LoginWriteRoute,
  type QueryMode,
  type WriteTx,
} from './role-tx';

type PgSql = ReturnType<typeof postgres>;

// ── The login write gateway (workspaces arch A2b2b, plan 20.1) ─────────────

/** The actors whose scoped writes go to the write role (plan 20.1):
 *  everything but system work and a peer(share), which writes nothing. */
const WRITE_ROLE_ACTORS: ReadonlySet<Actor['kind']> = new Set([
  'login',
  'assistant',
  'link',
  'contact',
]);

/** The tables the write role writes, as `schema.table` (WRITE_ROLE_TABLES). */
const WRITE_ROLE_TABLE_SET: ReadonlySet<string> = new Set(WRITE_ROLE_TABLES);

/** Whether a drizzle table is one the write role writes: a typed write to
 *  any other table goes to the system pool, decided before it is sent
 *  (no failed attempt). */
function isWriteRoleTable(table: unknown): boolean {
  return is(table, PgTable) && WRITE_ROLE_TABLE_SET.has(tableNameOf(table));
}

/** The table a single INSERT, UPDATE or DELETE writes, as `schema.table`
 *  (an unqualified name is public's), or null: another statement, a WITH,
 *  more than one statement, a name it cannot read. Exported for
 *  actor-client.test.ts only (not in index.ts). */
export function rawWriteTarget(query: string): string | null {
  const body = statementBody(query, false);
  if (MORE_STATEMENTS.test(body)) return null;
  const m =
    /^(?:insert\s+into|update(?:\s+only)?|delete\s+from(?:\s+only)?)\s+(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?=[\s(;]|$)/i.exec(
      body,
    );
  if (!m) return null;
  return `${(m[1] ?? 'public').toLowerCase()}.${m[2]!.toLowerCase()}`;
}

/** db.insert, update or delete of a scoped write (the db proxy): the
 *  gateway's handle for a write-role table, the system pool's for any
 *  other (arch A2b2b). */
export function typedWrite(prop: 'insert' | 'update' | 'delete', gateway: boolean): unknown {
  return (table: unknown, ...rest: unknown[]) => {
    const toWriteRole = gateway && isWriteRoleTable(table);
    if (gateway && !toWriteRole) noteScopedSystemWrite('typed-write', table, WRITE_ROLE_ACTORS);
    const handle = toWriteRole ? loginWriteDb() : getAdminDb();
    const fn = Reflect.get(handle as object, prop) as (...args: unknown[]) => unknown;
    return fn.call(handle, table, ...rest);
  };
}

/**
 * The login write gateway's one decision (arch A2b2b; plan v3 S3): the
 * settings a write that runs now takes on the write role, or null for the
 * system pool. The write role when all hold, in every check mode (the mode
 * decides whether a check refuses or reports, never the pool; it rides in
 * the SET as mantle.actor_check):
 *  - this process opened it (openLoginWritePool: web, api, the runs
 *    worker and the stdio MCP server);
 *  - the actor is a login, an assistant, a link or a contact;
 *  - the write carries a scope its reads use too (requestWriteScope: a
 *    login's mutating request scope, an Admin user's too since F4, an
 *    Admin turn). asSystem masks it, and a named repair or an Admin area
 *    route binds a system actor: both stay on the system pool.
 */
function loginWriteRoute(): LoginWriteRoute | null {
  if (!loginWritePoolOpen()) return null;
  const actor = currentActor();
  if (!actor || !WRITE_ROLE_ACTORS.has(actor.kind)) return null;
  const scope = requestWriteScope();
  if (!scope) return null;
  // The actor's settings in every mode, off too: the write role's checks
  // read the actor (a contact's app-data rule, 0294) and the mode.
  const params: [string, string, string] = [
    actorSetting(actor),
    writeModeOf(actor),
    actorCheckMode(),
  ];
  const home = currentCreateHome();
  const writeScope = writeScopeWithPrivate(scope, home);
  return {
    setSql: writeRoleSettingsSql(writeScope, params, home),
    actor: params[0],
    scope: writeScope,
  };
}

/** loginWriteRoute, after the pool's first mode read when it is still out
 *  (the startup race: a first write never carries off on a warn box). */
async function loginWriteRouteNow(): Promise<LoginWriteRoute | null> {
  const waitFor = firstModeReadNow();
  if (waitFor && loginWritePoolOpen() && currentActor() && actorCheckMode() === 'off') {
    await waitFor;
  }
  return loginWriteRoute();
}

/** Whether a write handed out now may go to the write role (decided again
 *  when it runs). False: this process opened no write pool, the system
 *  handle as before. */
export function loginWritesMayRoute(): boolean {
  return loginWritePoolOpen();
}

/** A settings value as a quoted literal: the same rule as setActorSql's. */
function settingLiteral(v: string): string {
  if (v.includes('\0')) throw new Error('write role setting: NUL');
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * The one statement that sets a write-role transaction's scope, actor and
 * create home, transaction-local (SET LOCAL as set_config(..., true)),
 * sent pipelined with the transaction's first statement. Never a session
 * SET: a scope left on a pooled connection would be a stale access right.
 * Values inlined as checked literals (uuids, the actor's shapes, the stamp
 * as JSON), so it goes out in one step (see setActorSql).
 * `mantle.login_id` is the scope's login: the write role reads a login's
 * own rows by it, and the write check holds a fact of no item to it.
 * Exported for actor-client.test.ts only (not in index.ts).
 */
export function writeRoleSettingsSql(
  scope: WorkspaceScope,
  params: [string, string, string],
  home: CreateHome | null,
): string {
  if (scope.loginId !== null && !UUID_RE.test(scope.loginId)) {
    throw new Error('write role setting: login');
  }
  const set = (name: string, v: string) => `set_config('${name}', ${settingLiteral(v)}, true)`;
  const parts = [
    set('mantle.ws', uuidArrayLiteral(scope.ws, 'write role ws')),
    set('mantle.mod_ws', uuidArrayLiteral(scope.modWs, 'write role modWs')),
    set('mantle.login_id', scope.loginId?.toLowerCase() ?? ''),
  ];
  if (home) {
    parts.push(
      set('mantle.create_ws', checkedUuidOrEmpty(home.createWs)),
      set('mantle.private_ws', checkedUuidOrEmpty(home.privateWs)),
      set('mantle.ingest_notify', home.quiet ? 'off' : ''),
      set(
        'mantle.create_stamp',
        home.stamp && Object.keys(home.stamp).length > 0 ? JSON.stringify(home.stamp) : '',
      ),
    );
  }
  return `${ACTOR_SQL_TAG} ${setActorSql(params)}, ${parts.join(', ')}`;
}

// ── The gateway's runner ────────────────────────────────────────────────────

/** How one kind of write runs through the gateway. */
type GatewayPaths<T> = {
  /** The system pool: no write pool in this process, no login actor, or
   *  no write scope. */
  system: () => Promise<T>;
  /** On the write role. */
  write: (route: LoginWriteRoute) => Promise<T>;
  /** Inside an open write transaction of the same route (M2). */
  join: (open: WriteTx) => Promise<T>;
};

/**
 * Run a write through the gateway (arch A2b2b): `system` when
 * loginWriteRoute says the system pool; inside an open write transaction
 * of the same route, `join`; else `write` on the write role. Every error,
 * a denial included, is the caller's: nothing runs again (plan v3 S3).
 */
export async function onLoginWritePool<T>(paths: GatewayPaths<T>): Promise<T> {
  const route = await loginWriteRouteNow();
  if (!route) return paths.system();
  const open = joinableWriteTx(route);
  if (open) return paths.join(open);
  // A write of the same route left running inside a transaction that has
  // ended (round 3, A): refused, never sent on a connection of its own.
  const store = openWriteTx.getStore();
  if (store && store.route.setSql === route.setSql && levelEnded(store)) {
    throw new JoinedWriteEndedError();
  }
  return paths.write(route);
}

/**
 * One write outside a transaction on the write role: BEGIN, the settings,
 * the statement and COMMIT pipelined on one reserved connection (one round
 * trip, as a turn scope's read). A failing statement aborts the
 * transaction, the COMMIT then rolls back, and the first error is thrown.
 */
async function writeRoleStatement(
  route: LoginWriteRoute,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  const lease = await boundedReserve();
  try {
    const conn = lease.sql;
    // BEGIN and COMMIT are the gateway's own, tagged as the actor's
    // (a2a-round-trips.db.test.ts counts them apart). Sent in this order,
    // each watched (a connection error marks the lease gone).
    const begin = lease.watch(sendIn(conn.unsafe(`${ACTOR_SQL_TAG} begin`), 'rows'));
    const set = lease.watch(sendIn(conn.unsafe(route.setSql), 'rows'));
    const main = lease.watch(sendIn(conn.unsafe(query, (args ?? []) as never[]), mode));
    const commit = lease.watch(sendIn(conn.unsafe(`${ACTOR_SQL_TAG} commit`), 'rows'));
    const out = await Promise.allSettled([begin, set, main, commit]);
    const failed = out.find((r) => r.status === 'rejected');
    if (failed) {
      const err = (failed as PromiseRejectedResult).reason;
      const what = permissionGapOf(err);
      if (what) noteWriteRoleDenial(route, what);
      throw err;
    }
    return (out[2] as PromiseFulfilledResult<unknown>).value;
  } finally {
    lease.release();
  }
}

/**
 * Run `work` as the outermost login write transaction `begin` opens: its
 * client watched (watchTx) behind the one SET (settingsFirst), open to
 * writes that join it while `work` runs (openWriteTx). The hooks of a
 * withSystemTx joined to it run once it commits or rolls back.
 */
async function writeTxOf(
  tx: WriteTx,
  setSql: string,
  begin: (work: (t: PgSql) => Promise<unknown>) => Promise<unknown>,
  work: (t: PgSql) => unknown,
): Promise<unknown> {
  let out: unknown;
  try {
    // Open to joins only while its work runs: the connection is taken
    // outside (checkNestedAcquire sees the caller's context, not this).
    out = await begin((t) =>
      openWriteTx.run(tx, async () => {
        const client = settingsFirst(watchTx(t, tx, tx), () => setSql);
        tx.t = client;
        try {
          const value = await work(client);
          // Joins left running (not awaited) finish inside it.
          await tx.joins;
          return value;
        } catch (err) {
          // Ended first (round 3, A): what it left running settles,
          // refused before the driver, before postgres.js sends the
          // ROLLBACK and hands the connection back.
          tx.done = true;
          // Uncapped (round 5, N5): a capped wait let postgres.js send a
          // late `rollback to` on a connection already handed on.
          await tx.joins;
          throw err;
        } finally {
          tx.done = true;
        }
      }),
    );
  } catch (err) {
    tx.done = true;
    await runTxHooks(tx.hooks.rollback, 'rollback');
    throw err;
  }
  await runTxHooks(tx.hooks.commit, 'commit');
  return out;
}

/** A transaction on the write role (begin's arguments, the last one its
 *  work): its settings go with its first statement, so they cost no round
 *  trip. */
export function writeRoleBegin(
  route: LoginWriteRoute,
  args: unknown[],
  saves?: { n: number },
): Promise<unknown> {
  const work = args[args.length - 1] as (t: PgSql) => unknown;
  const tx = newWriteTx(route, null, saves);
  return writeTxOf(tx, route.setSql, (w) => boundedBegin(args.slice(0, -1), w), work);
}

/** A transaction (begin's arguments) joined to an open write transaction
 *  (M2): a savepoint of it, watched as it is (joinWriteTx). */
export function joinedBegin(open: WriteTx, args: unknown[]): Promise<unknown> {
  return joinWriteTx(open, args[args.length - 1] as (t: PgSql) => unknown);
}

/** One statement joined to an open write transaction (M2), in a savepoint
 *  of its own: a statement that fails leaves the transaction as it was, as
 *  on a connection of its own. */
function joinedStatement(
  open: WriteTx,
  query: string,
  args: unknown[] | undefined,
  mode: QueryMode,
): Promise<unknown> {
  return joinedBegin(open, [
    (sp: PgSql) => sendIn(sp.unsafe(query, (args ?? []) as never[]), mode),
  ]);
}

/**
 * The client behind the gateway's drizzle handle (loginWriteDb): what a
 * scoped write that `db` sends to the system pool (insert, update, delete,
 * a mutating request's transaction, executeWrite) runs on. Each statement
 * and each transaction asks the gateway when it runs; the system path is
 * exactly the system pool's client.
 */
function loginWriteClient(): PgSql {
  const run = (query: string, args: unknown[] | undefined, mode: QueryMode) => {
    const system = () => sendIn(adminSql().unsafe(query, args as never[]), mode);
    if (runsOutsideTransaction(query)) return system();
    // A single write to a table the write role holds no right on goes to
    // the system pool before it is sent (no failed attempt).
    const target = rawWriteTarget(query);
    if (target !== null && !WRITE_ROLE_TABLE_SET.has(target)) {
      noteScopedSystemWrite('raw-write', target, WRITE_ROLE_ACTORS);
      return system();
    }
    return onLoginWritePool({
      system,
      write: (route) => writeRoleStatement(route, query, args, mode),
      join: (open) => joinedStatement(open, query, args, mode),
    });
  };
  const client = {
    get options() {
      return adminSql().options;
    },
    unsafe(query: string, args?: unknown[]) {
      return lazyQuery((mode) => run(query, args, mode));
    },
    begin(...args: unknown[]) {
      return onLoginWritePool({
        system: () => (adminSql().begin as (...a: unknown[]) => Promise<unknown>)(...args),
        write: (route) => writeRoleBegin(route, args),
        join: (open) => joinedBegin(open, args),
      });
    },
  };
  return client as unknown as PgSql;
}

let loginWriteDbCache: PostgresJsDatabase<typeof schema> | null = null;
onCloseDb(() => {
  loginWriteDbCache = null;
});

/** The gateway's drizzle handle (loginWriteClient), one per process. */
function loginWriteDb(): PostgresJsDatabase<typeof schema> {
  return (loginWriteDbCache ??= drizzle(loginWriteClient(), { schema }));
}

/** The handle a scoped write goes to: the gateway's when it may route,
 *  else the system pool's, as before A2b2b. */
export function systemWriteDb(): PostgresJsDatabase<typeof schema> {
  return loginWritesMayRoute() ? loginWriteDb() : getAdminDb();
}

/** A uuid, checked, or '' for none. */
export function checkedUuidOrEmpty(id: string | null): string {
  if (id === null) return '';
  if (!UUID_RE.test(id)) throw new Error('create home: not a uuid');
  return id.toLowerCase();
}

/** A Postgres uuid[] literal from validated ids. */
export function uuidArrayLiteral(ids: readonly string[], what: string): string {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`${what}: not a uuid: ${String(id).slice(0, 40)}`);
  }
  return `{${[...new Set(ids)].sort().join(',')}}`;
}

/**
 * Each login's private workspace as createHomeFallback last read it on the
 * system pool (arch A2b2b): the login write gateway adds it to a write
 * scope that does not hold it yet (writeScopeWithPrivate). A login's scope
 * is read once per request or turn, often before its first create made the
 * private workspace, and the write role needs its Moderator seat in
 * mantle.mod_ws. Only a pair read here counts, never a create home's word
 * alone.
 *
 * Process-global and never cleared, on purpose (A2b2b fix round 1, L3): one
 * entry per login that made or read its private workspace in this process
 * (logins are few: a brain's people, never per request), each a pair of
 * ids. A stale pair grants nothing: it counts only when the write's own
 * create home, read afresh by createHomeFallback (which rewrites the pair),
 * names the same workspace, and the database still checks the create.
 */
const privateWorkspaces = new Map<string, string>();

/** Note the login's private workspace as read (see privateWorkspaces). */
export function ownPrivate(loginId: string, ws: string | null): string | null {
  if (ws) privateWorkspaces.set(loginId.toLowerCase(), ws.toLowerCase());
  return ws;
}

/**
 * The scope a write runs in on the write role: `scope`, with the login's
 * own private workspace added (as a workspace and a Moderator one: it is
 * the login's alone, and it moderates it) when the write's create home
 * lands there and createHomeFallback read that pair. The scope refreshed
 * after the private workspace was made, with no query on the write's path.
 */
function writeScopeWithPrivate(scope: WorkspaceScope, home: CreateHome | null): WorkspaceScope {
  const priv = home?.privateWs?.toLowerCase();
  if (!priv || !scope.loginId) return scope;
  if (privateWorkspaces.get(scope.loginId.toLowerCase()) !== priv) return scope;
  if (scope.modWs.includes(priv) && scope.ws.includes(priv)) return scope;
  return {
    ...scope,
    ws: [...new Set([...scope.ws, priv])],
    modWs: [...new Set([...scope.modWs, priv])],
  };
}
