/**
 * The handles: db (the content handle, its pool picked per access by the
 * scope) and systemDb (the infrastructure handle, always the system pool),
 * both behind the TypeScript actor check (STATEMENT_PROPS); executeWrite (a
 * raw write, said so) and executeAsMigrator (the workspaces switch on the
 * migrator's connection).
 */
import { type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type * as schema from '../schema/index';
import { RuntimeFaultError } from '@mantle/std';
import { runtimeRoleOn } from '../runtime-role';
import {
  assertSystemDbCaller,
  carriedWriteScope,
  currentRequestMode,
  currentScopeTx,
  inTurnScope,
  noteOwnRuleSystemRead,
  noteRequestSystemWrite,
  systemDbAccessChecked,
  systemDbOnSpot,
  type WorkspaceScope,
} from '../viewer';
import { checkActorBound } from '../actor';
import { sqlCode } from '../sql-text';
import { withMigratorConnection } from '../migrator-connection';
import { ACTOR_SQL_TAG } from './check-mode';
import { actorParams, setActorSql } from './actor-sql';
import { getAdminDb, getNarrowDb } from './pools';
import { loginWritesMayRoute, systemWriteDb, typedWrite } from './write-route';
import { systemPoolTxInScope } from './system-tx';
import { getDb } from './scope';

// ── The actor on the system pool ────────────────────────────────────────────

/** The handle properties that send a statement: the TypeScript actor check
 *  runs on each access. drizzle's own reads (session, dialect) do
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
 * Content handle. A Proxy that defers initialisation until the first property
 * access, and picks the pool per access: inside a workspace scope it is the
 * workspace role's pool, so row level security applies.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`db.${String(prop)}`);
    const carried = carriedWriteScope();
    if (carried) return systemPoolProp(carried, prop);
    // A request scope: a write leaves the scope's read pool
    // (a login's to the write role while it may route, else the system
    // pool); reads run in the scope. A transaction is
    // a write in a mutating request, and stays in the scope in a read
    // request (a search step that needs one transaction). A raw execute
    // always runs in the scope: a raw write says so with
    // executeWrite.
    const mode = currentRequestMode();
    const write = prop === 'insert' || prop === 'update' || prop === 'delete';
    if (mode && !currentScopeTx()) {
      if (write || (prop === 'transaction' && mode.writes)) {
        noteRequestSystemWrite(String(prop));
        // Bound to the system handle: drizzle's builders read
        // `this.session`, which on this proxy is the scope's session, so an
        // unbound method would run the write on the workspace role (and
        // fail with permission denied). The login write gateway's handle
        // when it may route: it sends a scoped login write to the write
        // role, anything else to the system pool.
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
 * Whether a raw statement writes: a leading write verb, or a write clause
 * anywhere (a data-modifying CTE, a row lock). It never routes a request
 * scope's raw statements (a read it took for a write would run unscoped);
 * executeWrite uses it to refuse a statement that does
 * not write.
 */
export function isWriteSql(text: string): boolean {
  // Read on the text's code (sql-text.ts): comments, strings and dollar
  // quotes blanked as Postgres's lexer reads them, so a verb in a value is
  // no write and a comment never hides one. Text that never closes is no
  // statement Postgres runs, and text Postgres may read otherwise (a
  // backslash before a quote in a plain string, a U& name) is no statement
  // this reader can vouch for: neither is a write (executeWrite refuses it).
  const { code: body, unterminated, ambiguous } = sqlCode(text);
  if (unterminated || ambiguous) return false;
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
 * A raw WRITE, said so. Inside a request scope
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
 * may use it (assertSystemDbCaller).
 */
export const systemDb = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_t, prop) {
    if (STATEMENT_PROPS.has(prop)) checkActorBound(`systemDb.${String(prop)}`);
    const inScope = inTurnScope();
    if (inScope && systemDbAccessChecked(prop)) assertSystemDbCaller();
    // Inside a turn or request scope its infrastructure
    // writes (traces, spills, counters, logs) run on the narrow route;
    // outside every scope (workers, boot) it is system work and runs full.
    // At a full-route spot (onFullSystemRoute) the system pool, as the
    // spot's other statements.
    const handle = inScope && !systemDbOnSpot() ? getNarrowDb() : getAdminDb();
    return Reflect.get(handle as object, prop);
  },
});

/** A check `executeAsMigrator` runs first, in the same transaction: a
 *  select whose first row's `ok` must be true, else it throws `refusal`
 *  and the query never runs (the transaction rolls back). */
export type MigratorGuard = { readonly sql: SQL; readonly refusal: string };

/**
 * Work the runtime role may not do: DDL. With
 * MANTLE_DB_RUNTIME_ROLE on it runs on the migrator's URL (DATABASE_URL,
 * the role that runs the migrations) in one transaction of its own, with
 * the actor bound now, on a connection opened for it and closed after.
 * Off, it runs on `db` in a transaction of its own, which sends the actor
 * bound now first, as every transaction does: the workspaces switch is a
 * bare select, which outside a transaction goes with no actor (only a
 * write does), and the check on refuses the rows it writes (a fresh
 * install's first owner was never served). `guard`, when given, runs first
 * in that same transaction (MigratorGuard).
 *
 * Its callers: the workspaces switch (mantle_ws_migrate_locked, at boot,
 * at the terminal wizard's first owner, and inside the first owner's exit,
 * first-owner-exit.ts, with its brain check as the guard), and
 * server/web/scripts/backfill-conversation.ts (ALTER TABLE ... DISABLE and
 * ENABLE TRIGGER, which run in a transaction). Every other statement of the
 * app runs as the runtime role (runtime-role.ts). Both paths run in a
 * transaction, so a statement that may not (CREATE INDEX CONCURRENTLY,
 * VACUUM) fails through it with the role off as well as on; no caller
 * sends one (concurrent-indexes.ts runs its own).
 */
export async function executeAsMigrator<T extends Record<string, unknown>>(
  query: SQL,
  guard?: MigratorGuard,
): Promise<T[]> {
  if (!runtimeRoleOn()) {
    return (await db.transaction((tx) =>
      guarded((q: SQL) => tx.execute(q), query, guard),
    )) as unknown as T[];
  }
  checkActorBound('executeAsMigrator');
  const dialect = new PgDialect();
  const rows = await withMigratorConnection((conn) =>
    conn.begin(async (tx) => {
      const actor = actorParams();
      if (actor) await tx.unsafe(`${ACTOR_SQL_TAG} ${setActorSql(actor)}`);
      return guarded(
        async (q) => {
          const { sql: text, params } = dialect.sqlToQuery(q);
          return [...(await tx.unsafe(text, params as never[]))];
        },
        query,
        guard,
      );
    }),
  );
  return rows as unknown as T[];
}

/** `guard` (when given) then `query`, each through `run`, in the caller's
 *  one transaction: a refused guard throws and the query never runs. */
async function guarded(
  run: (q: SQL) => Promise<readonly unknown[]>,
  query: SQL,
  guard: MigratorGuard | undefined,
): Promise<unknown[]> {
  if (guard) {
    const [g] = (await run(guard.sql)) as { ok?: unknown }[];
    if (g?.ok !== true) throw new RuntimeFaultError(guard.refusal);
  }
  return [...(await run(query))];
}

export type Db = PostgresJsDatabase<typeof schema>;
