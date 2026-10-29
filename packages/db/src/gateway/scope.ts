/**
 * The workspace scopes: withScope (one short transaction on the workspace
 * role with the scope set), withTurnScope (an assistant turn, every query
 * in its own short transaction: the turn-scope client), the one scope check
 * (scopeProblem, turnScopeProblem), readTransaction, and getDb, the handle
 * for the current scope.
 */
import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import * as schema from '../schema/index';
import { RuntimeFaultError, UUID_RE } from '@mantle/std';
import {
  currentScopeTx,
  currentSpaceScope,
  currentWorkspaceScope,
  inTurnScope,
  newTxHooks,
  runInTurnScope,
  runInWorkspaceTx,
  runTxHooks,
  type WorkspaceScope,
} from '../viewer';
import { withLease } from '../reserved';
import { workResult } from './actor-sql';
import { getAdminDb, getViewerDb, turnScopedDbOnce } from './pools';
import { uuidArrayLiteral } from './write-route';

/**
 * A turn's scope was looked for at query time and is gone:
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
  // reserved connection: one round trip, not three (`begin` waits for
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
      // literals, entities.ts graph paths) works in a scope too.
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
        return workResult(fn(t as unknown as PgSql));
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
export function getDb(): PostgresJsDatabase<typeof schema> {
  const tx = currentScopeTx();
  if (tx) return tx as PostgresJsDatabase<typeof schema>;
  if (inTurnScope()) return getTurnScopedDb();
  return getAdminDb();
}

/**
 * Run `fn` in ONE workspace scope: a short
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
 * Run `fn` as an assistant TURN in one workspace scope: every `db` query inside, after any await, runs on the workspace role
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
  // An Admin turn (`writes`): the Admin assistant and the Admin MCP
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
 * A transaction that only READS: in a turn or request scope it runs
 * on the workspace role with the scope set, even where `db.transaction` is
 * a write (a mutating request, an Admin turn) and goes to the system pool.
 * A vector search's settings transaction (withHnswPool) uses it, so a scoped
 * search never reads past the scope. Anywhere else it is `db.transaction`.
 */
export function readTransaction<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}
