/**
 * The login write gateway's route: whether a write that runs now goes to
 * the write role (loginWriteRoute) and the one SET it carries there
 * (writeRoleSettingsSql), the write scope with the login's own private
 * workspace, the gateway's runner (a statement outside a transaction as one
 * pipelined transaction on the write role, a transaction, a join), and the
 * client and drizzle handle behind scoped writes (loginWriteClient). One
 * owner for the private workspaces read and the handle's cache.
 */
import { getTableName, is } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import * as schema from '../schema/index';
import { UUID_RE } from '@mantle/std';
import {
  currentCreateHome,
  requestWriteScope,
  SystemWorkRequiredError,
  type CreateHome,
  type WorkspaceScope,
} from '../viewer';
import { actorCheckMode, actorSetting, currentActor, writeModeOf, type Actor } from '../actor';
import { SCOPED_SYSTEM_WRITE, WRITE_ROLE_TABLES } from '../access-matrix';
import { ACTOR_SQL_TAG, firstModeReadNow } from './check-mode';
import { runsOutsideTransaction, setActorSql } from './actor-sql';
import { adminSql, getAdminDb, loginWritePoolOpen, onCloseDb } from './pools';
import {
  JoinedWriteEndedError,
  joinableWriteTx,
  lazyQuery,
  levelEnded,
  currentWriteTx,
  sendIn,
  type LoginWriteRoute,
  type QueryMode,
  type WriteTx,
} from './role-tx';
import { joinedBegin, joinedStatement, writeRoleBegin, writeRoleStatement } from './role-runner';

type PgSql = ReturnType<typeof postgres>;

// ── The login write gateway ────────────────────────────────────────────────

/** The actors whose scoped writes go to the write role:
 *  everything but system work and a peer(share), which writes nothing. */
const WRITE_ROLE_ACTORS: ReadonlySet<Actor['kind']> = new Set([
  'login',
  'assistant',
  'link',
  'contact',
]);

/** The tables the write role writes, as `schema.table` (WRITE_ROLE_TABLES). */
const WRITE_ROLE_TABLE_SET: ReadonlySet<string> = new Set(WRITE_ROLE_TABLES);

/** `schema.table` of a drizzle table (an unqualified one is public's), or
 *  '?' for anything else. */
function tableNameOf(table: unknown): string {
  if (!is(table, PgTable)) return '?';
  return `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`;
}

/** Whether a drizzle table is one the write role writes: a typed write to
 *  any other table goes to the system pool, decided before it is sent
 *  (no failed attempt). */
function isWriteRoleTable(table: unknown): boolean {
  return is(table, PgTable) && WRITE_ROLE_TABLE_SET.has(tableNameOf(table));
}

/**
 * Refuse a scoped write the write role holds no right on: the system pool is for system work, never the caller's
 * scoped write. Scoped is loginWriteRoute's test (an actor the write role
 * takes and a write scope), so system work, which binds a system actor, is
 * never refused. A login's write to a table whose matrix row names
 * scopedSystemWrite (SCOPED_SYSTEM_WRITE, its reason) still goes there:
 * every reason names the caller's login as whose row it is, so an
 * assistant's, a link's or a contact's write to it is refused too.
 */
function refuseScopedSystemWrite(table: unknown): void {
  const actor = currentActor();
  if (!actor || !WRITE_ROLE_ACTORS.has(actor.kind)) return;
  if (!requestWriteScope()) return;
  const name = tableNameOf(table);
  if (actor.kind === 'login' && Object.hasOwn(SCOPED_SYSTEM_WRITE, name)) return;
  throw new SystemWorkRequiredError(`a scoped ${actor.kind} write to ${name}, a system table`);
}

/** db.insert, update or delete of a scoped write (the db proxy): the
 *  gateway's handle for a write-role table, the system pool's for any
 *  other, which refuses a scoped write. */
export function typedWrite(prop: 'insert' | 'update' | 'delete', gateway: boolean): unknown {
  return (table: unknown, ...rest: unknown[]) => {
    const toWriteRole = gateway && isWriteRoleTable(table);
    if (gateway && !toWriteRole) refuseScopedSystemWrite(table);
    const handle = toWriteRole ? loginWriteDb() : getAdminDb();
    const fn = Reflect.get(handle as object, prop) as (...args: unknown[]) => unknown;
    return fn.call(handle, table, ...rest);
  };
}

/**
 * The login write gateway's one decision: the
 * settings a write that runs now takes on the write role, or null for the
 * system pool. The write role when all hold, in every check mode (the mode
 * decides whether a check refuses or reports, never the pool; it rides in
 * the SET as mantle.actor_check):
 *  - this process opened it (openLoginWritePool: web, api, the runs
 *    worker, the Telegram poller and the stdio MCP server; every process
 *    entry that binds a login opens it, eslint-rules/process-entries.test.ts);
 *  - the actor is a login, an assistant, a link or a contact;
 *  - the write carries a scope its reads use too (requestWriteScope: a
 *    login's mutating request scope, an Admin user's too, an Admin
 *    turn). asSystem masks it, and a named repair or an Admin area
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
  /** Inside an open write transaction of the same route. */
  join: (open: WriteTx) => Promise<T>;
};

/**
 * Run a write through the gateway: `system` when
 * loginWriteRoute says the system pool; inside an open write transaction
 * of the same route, `join`; else `write` on the write role. Every error,
 * a denial included, is the caller's: nothing runs again.
 */
export async function onLoginWritePool<T>(paths: GatewayPaths<T>): Promise<T> {
  const route = await loginWriteRouteNow();
  if (!route) return paths.system();
  const open = joinableWriteTx(route);
  if (open) return paths.join(open);
  // A write of the same route left running inside a transaction that has
  // ended: refused, never sent on a connection of its own.
  const store = currentWriteTx();
  if (store && store.route.setSql === route.setSql && levelEnded(store)) {
    throw new JoinedWriteEndedError();
  }
  return paths.write(route);
}

/**
 * The client behind the gateway's drizzle handle (loginWriteDb): what a
 * scoped write that `db` sends to the system pool (insert, update, delete,
 * a mutating request's transaction, executeWrite) runs on. Each statement
 * and each transaction asks the gateway when it runs (loginWriteRoute: the
 * actor and the write scope, never the statement's text); the system path
 * is exactly the system pool's client. A statement on the write role that
 * names a table the role holds no right on is refused by Postgres.
 */
function loginWriteClient(): PgSql {
  const run = (query: string, args: unknown[] | undefined, mode: QueryMode) => {
    const system = () => sendIn(adminSql().unsafe(query, args as never[]), mode);
    if (runsOutsideTransaction(query)) return system();
    // Every scoped statement goes to the write role, whatever its text
    // names: Postgres refuses a table the role holds no right on (fail
    // closed). No table is read from the text here.
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
 *  else the system pool's. */
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
 * system pool: the login write gateway adds it to a write
 * scope that does not hold it yet (writeScopeWithPrivate). A login's scope
 * is read once per request or turn, often before its first create made the
 * private workspace, and the write role needs its Moderator seat in
 * mantle.mod_ws. Only a pair read here counts, never a create home's word
 * alone.
 *
 * Process-global and never cleared, on purpose: one
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
