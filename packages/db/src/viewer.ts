/**
 * The access adapter's viewer scope (member logins Phase 0b, plan section 2b).
 *
 * One idea: no permission check per tool. A limited caller's queries run as a
 * limited Postgres LOGIN role, and row level security drops every row that
 * role may not see. `db` (client.ts) reads the viewer from this
 * AsyncLocalStorage on every property access, so everything inside
 * `withViewer(level, fn)` is filtered with no code change.
 *
 * Rules:
 *  - No viewer = the admin pool, unchanged (today's behaviour everywhere).
 *  - The level only goes DOWN: a nested withViewer takes the lower of the
 *    current and the new level, so a team agent that invokes an admin agent
 *    still runs it at team level.
 *  - Real LOGIN roles, never a role switch on the superuser connection: a
 *    `SET ROLE` there is not a lock (`SET ROLE NONE` escapes it).
 *  - The role passwords are derived from MANTLE_MASTER_KEY (HKDF, fixed
 *    label), so there is no new secret and no compose or .env change.
 *    `ensureViewerRoles` (viewer-roles.ts) sets them at every migrate.
 *  - A `db.transaction` opened OUTSIDE a viewer scope keeps its admin
 *    connection: a withViewer inside that callback does not change `tx`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { hkdfSync } from 'node:crypto';
import { env } from '@mantle/config';

/** The four levels, lowest first (the ITEM rank: raising and lowering an
 *  item). Who reads what is not a chain at the bottom: since client logins
 *  C1 (decision 3) the client role reads client items only and the public
 *  role public items only, so client and public are siblings under team.
 *  `levelCovers` is that rule; `lowerLevel` builds on it. */
export const VIEWER_LEVELS = ['public', 'client', 'team', 'admin'] as const;
export type ViewerLevel = (typeof VIEWER_LEVELS)[number];
/** The levels that run on a limited role (admin runs on the admin pool). */
export type LimitedLevel = Exclude<ViewerLevel, 'admin'>;

const RANK: Record<ViewerLevel, number> = { public: 0, client: 1, team: 2, admin: 3 };

/** The item rank: whether an item at `a` sits above an item at `b`
 *  (admin > team > client > public). For raising and lowering ITEMS only;
 *  never to decide what a viewer scope reads (use `levelCovers`). */
export function itemLevelAbove(a: ViewerLevel, b: ViewerLevel): boolean {
  return RANK[a] > RANK[b];
}

/**
 * Whether a caller at `viewer` reads what sits at `level`: admin reads all,
 * team reads team, client and public, client reads client only, public
 * reads public only (mantle_viewer_audiences() in migration 0187).
 */
export function levelCovers(viewer: ViewerLevel, level: ViewerLevel): boolean {
  if (viewer === level || viewer === 'admin') return true;
  return viewer === 'team' && level !== 'admin';
}

/**
 * A scope at one level asked to run at another that it does not cover and
 * that does not cover it: a client scope meeting public, or a public scope
 * meeting client. There is no common level (neither role reads the other's
 * items), so the work is refused instead of widened.
 */
export class ViewerLevelConflictError extends Error {
  readonly code = 'viewer-level-conflict';
  constructor(
    readonly current: ViewerLevel,
    readonly requested: ViewerLevel,
  ) {
    super(
      `A ${current}-level caller cannot run ${requested}-level work: ` +
        'client and public read different items and neither covers the other.',
    );
    this.name = 'ViewerLevelConflictError';
  }
}

/** Whether two levels have a common level (every pair but client with
 *  public). */
export function levelsMeet(a: ViewerLevel, b: ViewerLevel): boolean {
  return levelCovers(a, b) || levelCovers(b, a);
}

/** The lower of two levels: the one the other covers. Throws
 *  ViewerLevelConflictError for client with public (fail closed: never
 *  widened to either). */
export function lowerLevel(a: ViewerLevel, b: ViewerLevel): ViewerLevel {
  if (levelCovers(a, b)) return b;
  if (levelCovers(b, a)) return a;
  throw new ViewerLevelConflictError(a, b);
}

export function isViewerLevel(v: unknown): v is ViewerLevel {
  return typeof v === 'string' && (VIEWER_LEVELS as readonly string[]).includes(v);
}

/** A stored level as a level: anything unknown reads as admin (fail closed). */
export function asViewerLevel(v: unknown): ViewerLevel {
  return isViewerLevel(v) ? v : 'admin';
}

/**
 * A personal-space scope (member logins Phase 2, plan section 2b): the code
 * inside acts for ONE space, on the space role (`mantle_view_space`).
 */
export type SpaceScope = {
  spaceId: string;
  /** The login acting (the member, or the owner an agent works for). */
  loginId: string;
};

/**
 * A workspace scope (workspaces W1, plan section 2.1): the code inside reads
 * what the workspaces in `ws` hold, on the workspace role
 * (`mantle_view_user`), and may edit as a Moderator of `modWs`. `kind` says
 * who the work is for: a signed-in user, an assistant turn (its own
 * workspace only), or a public link.
 */
export type ScopeKind = 'user' | 'assistant' | 'link';
export type WorkspaceScope = {
  kind: ScopeKind;
  /** The login acting (the user, or the user an assistant answers). */
  loginId: string | null;
  /** The workspaces this work reads. */
  ws: readonly string[];
  /** The workspaces where the login is a Moderator (a subset of `ws`). */
  modWs: readonly string[];
};

/** What the current code runs as: system work (no scope), a level scope
 *  (the tier model, until it is retired), or a workspace scope. */
export type CurrentScope =
  | { kind: 'system' }
  | { kind: 'level'; level: LimitedLevel }
  | ({ kind: ScopeKind } & WorkspaceScope);

/**
 * Asked for a viewer LEVEL inside a workspace scope (plan S2): levels have no
 * meaning there, and the old answer ('admin' when unset) would widen a
 * workspace scope to everything. Callers move to `currentScope()`.
 */
export class ScopeLevelError extends Error {
  readonly code = 'scope-level';
  constructor(what: string) {
    super(`${what}: a workspace scope has no viewer level; use currentScope()`);
    this.name = 'ScopeLevelError';
  }
}

/** `tx`: a scope that must run in one transaction (its settings are
 *  transaction-local) carries it here; `db` returns it for every query. */
type Scope = {
  level: ViewerLevel;
  space?: SpaceScope;
  ws?: WorkspaceScope;
  tx?: unknown;
  hooks?: TxHooks;
  /** A turn scope (workspaces W4b): no transaction of its own; every query
   *  opens a short one on the workspace role (client.ts). */
  perQuery?: true;
};

/** Work a scope's transaction owes the world outside the database, run once
 *  it ends: `commit` after a commit, `rollback` after a rollback. */
export type TxHooks = { commit: (() => unknown)[]; rollback: (() => unknown)[] };

export function newTxHooks(): TxHooks {
  return { commit: [], rollback: [] };
}

/** Run hooks in order. Each is best effort: the transaction has already
 *  ended, so a failing hook is logged, never thrown. */
export async function runTxHooks(list: (() => unknown)[], what: string): Promise<void> {
  for (const fn of list) {
    try {
      await fn();
    } catch (err) {
      console.error(`[db] ${what} hook failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Run `fn` once the current scope's transaction COMMITS (a personal space:
 * `withSpace` is one transaction, and `db.transaction` inside it is only a
 * savepoint). Outside such a scope there is no open transaction to wait for,
 * so `fn` runs now. For effects outside the database that must never outrun
 * the rows they belong to, such as unlinking a deleted item's bytes: a later
 * failure rolls the delete back and the bytes are still there.
 */
export async function afterCommit(fn: () => unknown): Promise<void> {
  const hooks = store.getStore()?.hooks;
  if (hooks) hooks.commit.push(fn);
  else await fn();
}

/**
 * Run `fn` if the current scope's transaction ROLLS BACK: cleanup for bytes
 * written next to rows that never commit (a create inside a personal space).
 * Outside such a scope the write has already committed, so this does nothing.
 */
export function afterRollback(fn: () => unknown): void {
  store.getStore()?.hooks?.rollback.push(fn);
}

const store = new AsyncLocalStorage<Scope>();

/**
 * @deprecated Workspaces plan S2: no product code reads this (the
 * level-reads sweep fails on it; W8 deletes it). Use currentScope() and
 * handle every kind, or scopeHasArea() for an "Admin only" check.
 * 'admin' outside any viewer scope; throws ScopeLevelError inside a
 * workspace scope.
 */
export function currentViewerLevel(): ViewerLevel {
  return levelOfScope(currentScope());
}

/** What the current code runs as (see CurrentScope). Never 'system' inside
 *  a level scope or a workspace scope (plan T4). A personal-space scope
 *  runs at its login's level ('team' for an admin or a member, 'client' for
 *  a client), so everything that refuses a limited caller refuses it too. */
export function currentScope(): CurrentScope {
  const scope = store.getStore();
  if (!scope) return { kind: 'system' };
  if (scope.ws) return { ...scope.ws };
  if (scope.level === 'admin') return { kind: 'system' };
  return { kind: 'level', level: scope.level as LimitedLevel };
}

/**
 * The tier level a scope runs at, for the tier-model code that remains while
 * the bridge keeps grants equal to levels (W5b1): 'admin' for system work,
 * the level of a level scope. A workspace scope has no level (ScopeLevelError),
 * and an unknown kind is refused the same way (fails closed, plan S2).
 */
export function levelOfScope(scope: CurrentScope): ViewerLevel {
  switch (scope.kind) {
    case 'system':
      return 'admin';
    case 'level':
      return scope.level;
    default:
      throw new ScopeLevelError(`a '${String(scope.kind)}' scope`);
  }
}

/** Whether the current code runs in a level scope at exactly `level` (a
 *  personal space counts, at its login's level). */
export function inLevelScope(level: LimitedLevel): boolean {
  const scope = currentScope();
  return scope.kind === 'level' && scope.level === level;
}

/** Whether the current code is system work: outside every level, space and
 *  workspace scope (a system transaction counts, as it did as 'admin'). */
export function isSystemScope(): boolean {
  return currentScope().kind === 'system';
}

/** The areas an Admin workspace user manages (plan 2.4). Equal to
 *  WORKSPACE_AREAS in @mantle/client-types (a test pins it). */
export const SCOPE_AREAS = ['settings', 'users', 'assistants', 'connectors', 'keys'] as const;
export type ScopeArea = (typeof SCOPE_AREAS)[number];

/** The workspace scope the current code runs in, if any. */
export function currentWorkspaceScope(): WorkspaceScope | null {
  return store.getStore()?.ws ?? null;
}

/** The personal-space scope the current code runs in, if any. */
export function currentSpaceScope(): SpaceScope | null {
  return store.getStore()?.space ?? null;
}

/**
 * Whether the current code may read draft columns: the admin pool, or a
 * personal-space scope (the member's own working copy). Every other limited
 * scope reads published columns only; the draft columns are never granted to
 * the level roles, so a read that forgets this fails loudly (42501).
 */
export function readsDrafts(): boolean {
  // A workspace scope reads published columns only (they are all the
  // workspace role is granted).
  if (store.getStore()?.ws) return false;
  return isSystemScope() || currentSpaceScope() !== null;
}

/**
 * Whether the current code runs unlimited: the system pool, outside every
 * level, space and workspace scope. Never throws (unlike
 * levelOfScope inside a workspace scope): for the checks that only ask
 * "is this the owner's unlimited path?".
 */
export function isUnscoped(): boolean {
  const scope = store.getStore();
  if (!scope) return true;
  return !scope.ws && !scope.space && !scope.tx && scope.level === 'admin';
}

/** Whether the current code runs in a turn scope (per-query transactions). */
export function inTurnScope(): boolean {
  return store.getStore()?.perQuery === true;
}

/** The transaction the current scope runs in, if it carries one. */
export function currentScopeTx(): unknown {
  return store.getStore()?.tx ?? null;
}

/**
 * Run `fn` at `level` (or lower, if the caller already runs lower). Every
 * `db` query inside, including after awaits, uses that level's limited pool.
 * A client scope asked for public work (or a public scope for client work)
 * rejects with ViewerLevelConflictError: the two read different items, so
 * there is no lower level to run at.
 * `withViewer('admin', fn)` changes nothing: it never raises a lower scope
 * back to admin and never leaves a scope's transaction. Any lower level
 * starts a plain scope at that level: from inside a member's space request,
 * `withViewer('team', …)` reads the brain's Library on the team pool.
 */
export function withViewer<T>(level: ViewerLevel, fn: () => Promise<T>): Promise<T> {
  let next: ViewerLevel;
  try {
    next = lowerLevel(levelOfScope(currentScope()), level);
  } catch (err) {
    // A client scope meeting public work (or the reverse): refused, as a
    // rejected promise like any other failure of `fn`.
    return Promise.reject(err);
  }
  if (level === 'admin' || next === 'admin') return fn();
  return store.run({ level: next }, fn);
}

/** Enter a scope that runs in one transaction at `level` (or lower). Only
 *  client.ts calls this, with the transaction it opened on the right pool.
 *  Throws ViewerLevelConflictError for client with public (a client's space
 *  opened from a public scope). */
export function runInTxScope<T>(
  scope: { level: LimitedLevel; space?: SpaceScope; tx: unknown; hooks?: TxHooks },
  fn: () => Promise<T>,
): Promise<T> {
  const level = lowerLevel(levelOfScope(currentScope()), scope.level) as LimitedLevel;
  return store.run({ ...scope, level }, fn);
}

/** Enter a workspace scope that runs in one transaction on the workspace
 *  role. Only client.ts calls this (`withScope`), with the transaction it
 *  opened and whose settings it set. */
export function runInWorkspaceTx<T>(
  scope: { ws: WorkspaceScope; tx: unknown; hooks: TxHooks },
  fn: () => Promise<T>,
): Promise<T> {
  if (store.getStore()) {
    return Promise.reject(new Error('runInWorkspaceTx: only outside any other scope'));
  }
  // `level` is never read inside (levelOfScope throws); 'public' is the
  // narrowest value, should anything read the field directly.
  return store.run({ level: 'public', ws: scope.ws, tx: scope.tx, hooks: scope.hooks }, fn);
}

/**
 * Enter a TURN scope (workspaces W4b): `fn` and everything it awaits read on
 * the workspace role, each query in its own short transaction that sets the
 * scope (client.ts). No transaction is held across the turn, so an LLM call
 * inside never holds one. Nested: the same scope runs `fn` as is; any other
 * scope (another workspace scope, a level scope, a personal space, a
 * transaction) is refused, so a scope is never widened or swapped. Only
 * client.ts calls this (`withTurnScope`), with a validated, frozen scope.
 */
export function runInTurnScope<T>(ws: WorkspaceScope, fn: () => Promise<T>): Promise<T> {
  const open = store.getStore();
  if (open) {
    if (open.perQuery && open.ws && sameWorkspaceScope(open.ws, ws)) return fn();
    return Promise.reject(new Error('withTurnScope: already inside another scope'));
  }
  return store.run({ level: 'public', ws, perQuery: true }, fn);
}

/** Two workspace scopes that read and write exactly the same. */
export function sameWorkspaceScope(a: WorkspaceScope, b: WorkspaceScope): boolean {
  const eqList = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  return (
    a.kind === b.kind && a.loginId === b.loginId && eqList(a.ws, b.ws) && eqList(a.modWs, b.modWs)
  );
}

/**
 * Who a turn's rows belong to (workspaces W4b, R3): the workspace and the
 * login a run, a trace or a tool result is stamped with. Inside a turn scope
 * it is the scope's (one workspace); the Admin assistant, which stays on the
 * system pool until W6a, carries it here. Null = system work (Admin by the
 * stamp trigger's NULL rule).
 */
export type TurnStamp = { workspaceId: string; loginId: string | null };

const stampStore = new AsyncLocalStorage<TurnStamp>();

/** Run `fn` with `stamp` as the turn's stamp (the system-pool assistant). */
export function withTurnStamp<T>(stamp: TurnStamp, fn: () => Promise<T>): Promise<T> {
  return stampStore.run({ ...stamp }, fn);
}

/** The current turn's stamp: the turn scope's, else the carried one. */
export function currentTurnStamp(): TurnStamp | null {
  const ws = store.getStore()?.ws;
  if (ws) {
    return ws.ws.length === 1 ? { workspaceId: ws.ws[0]!, loginId: ws.loginId } : null;
  }
  return stampStore.getStore() ?? null;
}

/**
 * Run `fn` on an ADMIN-pool transaction's own connection: every `db` query
 * inside uses `tx`, so work that holds a row lock in `tx` never needs a
 * second connection from the pool (team apps M3 re-audit: a member's
 * parallel app writes each held one connection for the lock and took more
 * for the work, and could empty the pool). With the transaction's `hooks`:
 * `afterCommit` and `afterRollback` inside wait for it to end (follow-up
 * low 1), never run early. Only client.ts calls this (`withSystemTx`).
 */
export function runInSystemTx<T>(
  scope: { tx: unknown; hooks: TxHooks },
  fn: () => Promise<T>,
): Promise<T> {
  if (store.getStore()) {
    return Promise.reject(new Error('runInSystemTx: only outside a viewer scope'));
  }
  return store.run({ level: 'admin', tx: scope.tx, hooks: scope.hooks }, fn);
}

/**
 * Why code inside a TURN scope may leave it for the system pool (workspaces
 * W4b fix round 1, M4). A turn scope fails closed: every `db` query runs on
 * the workspace role. There are two doors out to the admin pool: `asSystem`,
 * which inside a turn must name one of these reasons (each logged once per
 * process), and `systemDb`, the infrastructure handle (tool results, pending
 * calls, traces, logs), which inside a turn only the modules of
 * SYSTEM_DB_MODULES may use (assertSystemDbCaller, fix round 2). Keep both
 * lists small: a new entry is a new way out of the scope and needs review.
 *
 *  - `agent-workspace`: the workspace row and membership an assistant runs
 *    in (agent-viewer.ts), read before the scope is entered or re-entered.
 *  - `connector-binding`: a connector group's binding or OAuth config
 *    (dispatch.ts), infrastructure like its keys; the scope's own rule
 *    (connectorScopeRefused) decides whether the call runs.
 *  - `connector-call`: the remote MCP call, which reads and refreshes the
 *    connector's own credentials (api_keys); no brain content is read.
 *  - `workspace-resources`: the workspace_resources rows of a connector
 *    (external-access.ts); the rule is in the query.
 *  - `runs-scope-check`: enqueue checks the runs it names carry the scope
 *    (runs boss.ts); the rule is in the query.
 *  - `member-request`: team_request_create files a task on the member's
 *    behalf (builtins-team.ts), the one write a member turn makes.
 *  - `own-space`: the my_* tools leave the turn to enter the login's own
 *    personal space (withSpace), checked against the scope's login.
 *  - `heartbeat-own-row`: a heartbeat's control tools change the row of the
 *    heartbeat that is firing, and only that one (heartbeats/tools.ts).
 *  - `client-sourced-check`: the client-sourced taint checks and the
 *    conversation mark (client-sourced.ts, client-sourced-rules.ts): yes or
 *    no over admin tables, fail closed, no content returned.
 */
export const AS_SYSTEM_TURN_REASONS = [
  'agent-workspace',
  'connector-binding',
  'connector-call',
  'workspace-resources',
  'runs-scope-check',
  'member-request',
  'own-space',
  'heartbeat-own-row',
  'client-sourced-check',
] as const;
export type AsSystemReason = (typeof AS_SYSTEM_TURN_REASONS)[number];

/** asSystem was called inside a turn scope without an allowlisted reason,
 *  or systemDb used there by a module off SYSTEM_DB_MODULES (`message`). */
export class TurnScopeExitError extends Error {
  readonly code = 'turn-scope-exit';
  constructor(reason: string | undefined, message?: string) {
    super(
      message ??
        `asSystem inside a turn scope needs an allowlisted reason (AS_SYSTEM_TURN_REASONS); got ${
          reason ? `'${reason}'` : 'none'
        }. A turn never leaves its scope for the system pool unnamed.`,
    );
    this.name = 'TurnScopeExitError';
  }
}

const loggedTurnExits = new Set<string>();

/** Whether an unnamed exit from a turn scope throws: in tests and local
 *  development. In production it is logged and allowed for now (W4b fix
 *  round 1: about 80 call sites, not every one reached by a test yet). */
function strictTurnExits(): boolean {
  const mode = env('NODE_ENV');
  return mode === 'test' || mode === 'development';
}

/**
 * Run `fn` OUTSIDE any viewer scope, on the admin pool: the escape hatch for
 * the rare WRITE a limited caller needs (team_request_create files an
 * admin-level task on the member's behalf). Never for reads. Few call sites,
 * each one audited; grep for `asSystem(` to list them.
 *
 * Inside a turn scope (W4b) the call must name its `reason` from
 * AS_SYSTEM_TURN_REASONS (logged once per reason). Without one it throws
 * TurnScopeExitError in tests and development, and is logged (once per
 * reason) in production.
 */
export function asSystem<T>(fn: () => Promise<T>, reason?: AsSystemReason): Promise<T> {
  if (store.getStore()?.perQuery) {
    const listed =
      reason !== undefined && (AS_SYSTEM_TURN_REASONS as readonly string[]).includes(reason);
    if (!listed) {
      if (strictTurnExits()) return Promise.reject(new TurnScopeExitError(reason));
      const key = `unlisted:${reason ?? ''}`;
      if (!loggedTurnExits.has(key)) {
        loggedTurnExits.add(key);
        console.error(`[db] ${new TurnScopeExitError(reason).message} Allowed in production.`, {
          stack: new Error().stack,
        });
      }
    } else if (!loggedTurnExits.has(reason)) {
      loggedTurnExits.add(reason);
      console.info(`[db] a turn scope leaves for the system pool: ${reason}`);
    }
  }
  return store.exit(fn);
}

/**
 * The modules that may use `systemDb` (workspaces W4b fix round 2): the same
 * list as eslint-rules/system-db-allowlist.mjs, which refuses the import
 * anywhere else (viewer.test.ts keeps the two equal). Test files may too.
 */
export const SYSTEM_DB_MODULES: readonly string[] = [
  'packages/db/src/',
  'packages/tracing/src/store.ts',
  'packages/tools/src/tool-results.ts',
  'packages/turn-stream/src/publish.ts',
  'packages/turn-stream/src/replay.ts',
  'packages/embeddings/src/index.ts',
  'packages/content/src/team-messages.ts',
  'packages/content/src/app-access-log.ts',
  'packages/content/src/share-access-log.ts',
  'packages/content/src/team-access-log.ts',
  'packages/content/src/member-turn-ledger.ts',
  'packages/runtime/src/agent/tool-loop/execute-call.ts',
  'server/web/lib/audit.ts',
  'packages/api-keys/src/index.ts',
];

/** The file that touched `systemDb`, from a stack taken in its proxy: the
 *  first frame outside this module, client.ts, a dependency (drizzle reads
 *  `this.session` on the proxy inside its own methods) and node's own code.
 *  Null when none names a file. */
export function systemDbCallerOf(stack: string): string | null {
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?[^\s()]+?):\d+:\d+\)?\s*$/.exec(line.trim());
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\//, '').replace(/\\/g, '/');
    if (
      file.endsWith('packages/db/src/viewer.ts') ||
      file.endsWith('packages/db/src/client.ts') ||
      file.includes('/node_modules/') ||
      file.startsWith('node:')
    ) {
      continue;
    }
    return file;
  }
  return null;
}

/** The drizzle internals read on `systemDb` itself while a query it was
 *  asked for runs: `this.session` and `this.dialect`, and `this.authToken`,
 *  which `execute` reads only when the query is awaited, from a frame with
 *  no caller file. The check already ran when the caller touched the
 *  method, so these skip it (W5a audit W3): one stack per call, not
 *  several, in a turn. Nothing else: `$client` (the raw pool) and `_` stay
 *  checked, so code handed systemDb cannot reach the pool unchecked (fix
 *  round 2, L-2). */
const SYSTEM_DB_INTERNAL_PROPS: ReadonlySet<PropertyKey> = new Set([
  'session',
  'dialect',
  'authToken',
]);

/** Whether an access of `prop` on `systemDb` inside a turn scope is checked
 *  (assertSystemDbCaller): every one but drizzle's internals. */
export function systemDbAccessChecked(prop: PropertyKey): boolean {
  return !SYSTEM_DB_INTERNAL_PROPS.has(prop);
}

/** Whether `file` is one of SYSTEM_DB_MODULES (or a test file). */
export function isSystemDbModule(file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return true;
  return SYSTEM_DB_MODULES.some((p) => file.includes(`/${p}`) || file.startsWith(p));
}

/**
 * `systemDb` inside a turn scope (workspaces W4b fix round 2): the second
 * door out of the scope, so only SYSTEM_DB_MODULES may use it there (the
 * eslint rule holds the import; this holds the call, whatever path the
 * handle took). Anything else throws TurnScopeExitError in tests and local
 * development, and is logged once per calling file in production, as asSystem
 * does (M4). Outside a turn scope: nothing. client.ts calls it on every
 * access to `systemDb` in a turn scope; `stack` is for tests.
 */
export function assertSystemDbCaller(stack?: string): void {
  if (!store.getStore()?.perQuery) return;
  const caller = systemDbCallerOf(stack ?? new Error().stack ?? '');
  if (caller && isSystemDbModule(caller)) return;
  const message =
    `systemDb inside a turn scope is for the infrastructure modules of SYSTEM_DB_MODULES only; ` +
    `used from ${caller ?? 'an unknown file'}. A turn never reads past its scope on the admin pool.`;
  if (strictTurnExits()) throw new TurnScopeExitError(undefined, message);
  const key = `system-db:${caller ?? ''}`;
  if (!loggedTurnExits.has(key)) {
    loggedTurnExits.add(key);
    console.error(`[db] ${message} Allowed in production.`, { stack: new Error().stack });
  }
}

/**
 * Refuse to hand work to another process from inside a viewer scope. A job
 * runs later in a worker that does not inherit this scope, so it would run at
 * admin: "the level only goes down" breaks across the queue. No job type
 * carries a level yet, so every enqueue helper calls this first and a limited
 * turn cannot queue work at all (plan section 2b).
 */
export function assertNoViewer(what: string): void {
  if (store.getStore()?.ws) {
    // A workspace scope never hands work on without carrying it (plan 5.4,
    // U5): a caller that carries it checks with assertScopeCarried instead.
    throw new Error(
      `${what} leaves this process and would run unscoped, but the caller runs in a workspace scope. ` +
        'Work queued from a workspace scope must carry that scope.',
    );
  }
  const scope = currentScope();
  if (scope.kind !== 'system') {
    const level = scope.kind === 'level' ? scope.level : scope.kind;
    throw new Error(
      `${what} leaves this process and would run at admin, but the caller runs at '${level}'. ` +
        'A limited-level turn cannot queue work.',
    );
  }
}

/** A limited pool: one per level, the personal-space role, and the
 *  workspace role (workspaces W1). */
export type PoolRole = LimitedLevel | 'space' | 'user';

/** The Postgres LOGIN role for a limited pool. Not `mantle_team`: that name
 *  is already the team visitor cookie. `mantle_view_space` is the
 *  personal-space role: it sees only the space its transaction names. */
export function viewerRoleName(level: PoolRole): string {
  return `mantle_view_${level}`;
}

/**
 * The role's password: HKDF-SHA256 over the master key with a fixed label per
 * level. Deterministic, so every process of a box derives the same value and
 * `ensureViewerRoles` can (re)set it at each migrate, after a restore, and
 * after a master-key change.
 */
export function viewerRolePassword(masterKey: string, level: PoolRole): string {
  if (!masterKey) throw new Error('MANTLE_MASTER_KEY must be set to derive viewer role passwords');
  const key = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from('mantle-viewer-roles', 'utf8'),
    Buffer.from(`viewer-role:${level}`, 'utf8'),
    32,
  );
  return Buffer.from(key).toString('base64url');
}

/**
 * Per-database viewer logins (MANTLE_VIEWER_ROLES_PER_DATABASE=1), for a
 * brain on a Postgres cluster that other brains share (throwaway and e2e
 * brains on the workstation). The four shared roles are cluster objects with
 * ONE password each, derived from one brain's master key: a second brain that
 * reset them broke the first ("password authentication failed for user
 * mantle_view_space"). In this mode the brain logs in as its own role,
 * `mantle_view_<level>_<database>`, whose only power is to become the shared
 * role (`SET role` at login, viewer-roles.ts). So `current_user`, the grants
 * and the row policies are the shared role's, as on a box with one brain.
 * That power is cluster-wide; what keeps it to its own brain is CONNECT: a
 * per-database brain's database admits only its own logins. Off (the
 * default) = the shared names, unchanged.
 *
 * The database name such a role carries: anything else fails loudly, since a
 * name that had to be mangled could collide with another brain's.
 */
export function viewerRoleDatabase(database: string): string {
  if (!/^[a-z0-9_]{1,40}$/.test(database)) {
    throw new Error(
      `per-database viewer roles need a database name of 1 to 40 characters from [a-z0-9_]; got "${database}"`,
    );
  }
  return database;
}

/** The role a limited pool logs in as: the shared role, or with `database`
 *  the brain's own per-database role (MANTLE_VIEWER_ROLES_PER_DATABASE). */
export function viewerLoginRoleName(level: PoolRole, database: string | null): string {
  return database === null
    ? viewerRoleName(level)
    : `${viewerRoleName(level)}_${viewerRoleDatabase(database)}`;
}

/** The connection URL for a limited level: the admin URL with the user and
 *  password swapped. Host, port, database and options stay. `perDatabase`
 *  logs in as the brain's own role for the URL's database. */
export function viewerDatabaseUrl(
  adminUrl: string,
  level: PoolRole,
  password: string,
  perDatabase = false,
): string {
  const u = new URL(adminUrl);
  u.username = viewerLoginRoleName(
    level,
    perDatabase ? decodeURIComponent(u.pathname.replace(/^\//, '')) : null,
  );
  u.password = password; // base64url: nothing to escape
  return u.toString();
}
