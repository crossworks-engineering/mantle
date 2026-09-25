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

/** The four levels, lowest first. A caller sees an item when the caller's
 *  level is at or above the item's level. */
export const VIEWER_LEVELS = ['public', 'client', 'team', 'admin'] as const;
export type ViewerLevel = (typeof VIEWER_LEVELS)[number];
/** The levels that run on a limited role (admin runs on the admin pool). */
export type LimitedLevel = Exclude<ViewerLevel, 'admin'>;

const RANK: Record<ViewerLevel, number> = { public: 0, client: 1, team: 2, admin: 3 };

/** The lower of two levels. */
export function lowerLevel(a: ViewerLevel, b: ViewerLevel): ViewerLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

export function isViewerLevel(v: unknown): v is ViewerLevel {
  return typeof v === 'string' && (VIEWER_LEVELS as readonly string[]).includes(v);
}

const store = new AsyncLocalStorage<{ level: LimitedLevel }>();

/** The level the current code runs at: 'admin' outside any viewer scope. */
export function currentViewerLevel(): ViewerLevel {
  return store.getStore()?.level ?? 'admin';
}

/**
 * Run `fn` at `level` (or lower, if the caller already runs lower). Every
 * `db` query inside, including after awaits, uses that level's limited pool.
 * `withViewer('admin', fn)` never raises a lower scope back to admin.
 */
export function withViewer<T>(level: ViewerLevel, fn: () => Promise<T>): Promise<T> {
  const next = lowerLevel(currentViewerLevel(), level);
  if (next === 'admin') return fn();
  return store.run({ level: next }, fn);
}

/** The Postgres LOGIN role for a limited level. Not `mantle_team`: that name
 *  is already the team visitor cookie. */
export function viewerRoleName(level: LimitedLevel): string {
  return `mantle_view_${level}`;
}

/**
 * The role's password: HKDF-SHA256 over the master key with a fixed label per
 * level. Deterministic, so every process of a box derives the same value and
 * `ensureViewerRoles` can (re)set it at each migrate, after a restore, and
 * after a master-key change.
 */
export function viewerRolePassword(masterKey: string, level: LimitedLevel): string {
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
export function viewerDatabaseUrl(adminUrl: string, level: LimitedLevel, password: string): string {
  const u = new URL(adminUrl);
  u.username = viewerRoleName(level);
  u.password = password; // base64url: nothing to escape
  return u.toString();
}
