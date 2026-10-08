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

/** `tx`: a scope that must run in one transaction (its settings are
 *  transaction-local) carries it here; `db` returns it for every query. */
type Scope = { level: ViewerLevel; space?: SpaceScope; tx?: unknown; hooks?: TxHooks };

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

/** The level the current code runs at: 'admin' outside any viewer scope. A
 *  personal-space scope runs at its login's level ('team' for an admin or a
 *  member, 'client' for a client), so everything that refuses a limited
 *  caller (enqueue, admin agents) refuses it too. */
export function currentViewerLevel(): ViewerLevel {
  return store.getStore()?.level ?? 'admin';
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
  return currentViewerLevel() === 'admin' || currentSpaceScope() !== null;
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
    next = lowerLevel(currentViewerLevel(), level);
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
  const level = lowerLevel(currentViewerLevel(), scope.level) as LimitedLevel;
  return store.run({ ...scope, level }, fn);
}

/**
 * Run `fn` on an ADMIN-pool transaction's own connection: every `db` query
 * inside uses `tx`, so work that holds a row lock in `tx` never needs a
 * second connection from the pool (team apps M3 re-audit: a member's
 * parallel app writes each held one connection for the lock and took more
 * for the work, and could empty the pool). Only from outside any viewer
 * scope, with a transaction the caller opened on the admin pool.
 */
export function runInSystemTx<T>(tx: unknown, fn: () => Promise<T>): Promise<T> {
  if (store.getStore()) {
    return Promise.reject(new Error('runInSystemTx: only outside a viewer scope'));
  }
  return store.run({ level: 'admin', tx }, fn);
}

/**
 * Run `fn` OUTSIDE any viewer scope, on the admin pool: the escape hatch for
 * the rare WRITE a limited caller needs (team_request_create files an
 * admin-level task on the member's behalf). Never for reads. Few call sites,
 * each one audited; grep for `asSystem(` to list them.
 */
export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return store.exit(fn);
}

/**
 * Refuse to hand work to another process from inside a viewer scope. A job
 * runs later in a worker that does not inherit this scope, so it would run at
 * admin: "the level only goes down" breaks across the queue. No job type
 * carries a level yet, so every enqueue helper calls this first and a limited
 * turn cannot queue work at all (plan section 2b).
 */
export function assertNoViewer(what: string): void {
  const level = currentViewerLevel();
  if (level !== 'admin') {
    throw new Error(
      `${what} leaves this process and would run at admin, but the caller runs at '${level}'. ` +
        'A limited-level turn cannot queue work.',
    );
  }
}

/** A limited pool: one per level, plus the personal-space role. */
export type PoolRole = LimitedLevel | 'space';

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

/** The connection URL for a limited level: the admin URL with the user and
 *  password swapped. Host, port, database and options stay. */
export function viewerDatabaseUrl(adminUrl: string, level: PoolRole, password: string): string {
  const u = new URL(adminUrl);
  u.username = viewerRoleName(level);
  u.password = password; // base64url: nothing to escape
  return u.toString();
}
