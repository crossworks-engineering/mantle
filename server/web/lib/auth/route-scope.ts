/**
 * What the session guard does with each owner route (workspaces W6a, plan
 * 2.4 and 11): the ONE table that decides whether a request reads in the
 * signed-in user's scope or runs as Admin management.
 *
 *  - `content`: brain items. A read (GET, HEAD, or a READ_POSTS entry)
 *    enters the login's scope for the rest of the request: the union of its
 *    workspaces, on the workspace role (mantle_view_user). An Admin user
 *    reads what is granted to the workspaces it is in, like anyone. An
 *    Admin user's write stays on the system pool, as before W6a.
 *  - an area (`settings`, `users`, `assistants`, `connectors`, `keys`):
 *    management (plan 2.4). The login must hold the area (requireArea:
 *    the Admin workspace and its limits); the route then runs on the
 *    system pool, as management always did.
 *  - `self`: the login's own things (its profile, push devices, its chat
 *    with the Admin assistant, pairing a phone, the version and help). An
 *    Admin login only, on the system pool.
 *
 * Every owner route pattern matches one prefix below (route-scope.test.ts
 * walks the manifest), so a new route is classified before it ships.
 * MEMBER_OPEN_READS lists the owner routes a non-Admin login may call
 * since W6a (reads only, in its scope); every other owner route still
 * refuses it.
 */
import type { WorkspaceArea } from '@mantle/client-types';

export type RouteClass =
  { kind: 'content' } | { kind: 'self' } | { kind: 'area'; area: WorkspaceArea };

type Tag = 'content' | 'self' | WorkspaceArea;

/** Prefixes, longest match wins. A prefix matches the pattern itself or
 *  the pattern followed by '/'. */
export const ROUTE_PREFIXES: ReadonlyArray<readonly [string, Tag]> = [
  // Brain items: scoped reads.
  ['/api/pages', 'content'],
  ['/api/notes', 'content'],
  ['/api/draws', 'content'],
  ['/api/tables', 'content'],
  ['/api/files', 'content'],
  ['/api/tree', 'content'],
  ['/api/apps', 'content'],
  ['/api/nodes', 'content'],
  ['/api/search', 'content'],
  ['/api/mentions', 'content'],
  ['/api/formulas', 'content'],
  ['/api/tasks', 'content'],
  ['/api/entities', 'content'],
  ['/api/journal', 'content'],
  ['/api/email', 'content'],
  ['/api/contacts', 'content'],
  ['/api/events', 'content'],
  ['/api/recall', 'content'],
  ['/api/export', 'content'],
  ['/api/shares', 'content'],
  ['/api/docs', 'content'],
  ['/api/activity', 'content'],
  ['/api/dashboard', 'content'],
  ['/api/attachments', 'content'],
  ['/api/v1', 'content'],
  // The login's own things.
  ['/api/profile', 'self'],
  ['/api/push', 'self'],
  ['/api/assistant', 'self'],
  ['/api/app-nav', 'self'],
  ['/api/auth', 'self'],
  ['/api/changelog', 'self'],
  ['/api/help', 'self'],
  ['/api/health', 'self'],
  ['/api/realtime', 'self'],
  ['/api/version', 'self'],
  // An Admin user's own private items (its personal space, until W6b).
  ['/api/admin', 'self'],
  // Management: settings.
  ['/api/onboarding', 'settings'],
  ['/api/settings', 'settings'],
  ['/api/appearance', 'settings'],
  ['/api/config', 'settings'],
  ['/api/services', 'settings'],
  ['/api/updates', 'settings'],
  ['/api/backups', 'settings'],
  ['/api/audit', 'settings'],
  ['/api/debug', 'settings'],
  ['/api/dev-tools', 'settings'],
  ['/api/metrics', 'settings'],
  ['/api/network', 'settings'],
  ['/api/tailscale', 'settings'],
  ['/api/embedding', 'settings'],
  ['/api/ai-workers', 'settings'],
  ['/api/models', 'settings'],
  ['/api/model-combos', 'settings'],
  ['/api/model-context', 'settings'],
  ['/api/model-pools', 'settings'],
  ['/api/runners', 'settings'],
  ['/api/runs', 'settings'],
  ['/api/traces', 'settings'],
  ['/api/sandboxes', 'settings'],
  ['/api/pending', 'settings'],
  ['/api/mcp-status', 'settings'],
  ['/api/mcp-settings', 'settings'],
  ['/api/mcp-clients', 'settings'],
  ['/api/docs/collections', 'settings'],
  // Management: users.
  ['/api/users', 'users'],
  ['/api/team-admin', 'users'],
  ['/api/access', 'users'],
  ['/api/mcp-logins', 'users'],
  // Management: assistants.
  ['/api/agents', 'assistants'],
  ['/api/skills', 'assistants'],
  ['/api/tools', 'assistants'],
  ['/api/tool-groups', 'assistants'],
  ['/api/studio', 'assistants'],
  ['/api/heartbeats', 'assistants'],
  // Management: connectors.
  ['/api/mcp-connectors', 'connectors'],
  ['/api/openapi-connectors', 'connectors'],
  ['/api/microsoft', 'connectors'],
  ['/api/peers', 'connectors'],
  ['/api/federation', 'connectors'],
  ['/api/telegram', 'connectors'],
  // Calendar feeds: accounts with their feed secrets, management.
  ['/api/calendar', 'connectors'],
  ['/api/email/accounts', 'connectors'],
  ['/api/email/discover', 'connectors'],
  ['/api/email/contact-gate', 'connectors'],
  // Management: keys.
  ['/api/keys', 'keys'],
  ['/api/secrets', 'keys'],
  ['/api/pdf-passwords', 'keys'],
];

const AREAS: ReadonlySet<string> = new Set([
  'settings',
  'users',
  'assistants',
  'connectors',
  'keys',
]);

/** The class of an owner route pattern, or null when no prefix matches (a
 *  route nobody classified: the guard refuses it, the test fails). */
export function routeClass(pattern: string): RouteClass | null {
  let best: (typeof ROUTE_PREFIXES)[number] | null = null;
  for (const entry of ROUTE_PREFIXES) {
    const prefix = entry[0];
    if (pattern !== prefix && !pattern.startsWith(`${prefix}/`)) continue;
    if (!best || prefix.length > best[0].length) best = entry;
  }
  if (!best) return null;
  const tag = best[1];
  if (AREAS.has(tag)) return { kind: 'area', area: tag as WorkspaceArea };
  return { kind: tag as 'content' | 'self' };
}

/** POST routes that only read: scoped like a GET. */
export const READ_POSTS: ReadonlySet<string> = new Set(['POST /api/formulas/:id/evaluate']);

/** Whether `method pattern` only reads: GET, HEAD, or a READ_POSTS entry. */
export function isReadRequest(method: string, pattern: string | null): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' || (pattern !== null && READ_POSTS.has(`${m} ${pattern}`));
}

/**
 * The owner routes a non-Admin login may call since W6a: reads of brain
 * items in the login's scope (the row rules decide what it sees; drafts are
 * never read). Writes and every other owner route still refuse a member or
 * a client (403 member-login / client-login): members write through their
 * own routes (/api/member/*, the grants and workspace routes) until the
 * write rule moves onto the item routes.
 */
export const MEMBER_OPEN_READS: readonly string[] = [
  'GET /api/pages',
  'GET /api/pages/:id',
  'GET /api/pages/:id/backlinks',
  'GET /api/pages/:id/descendant-count',
  'GET /api/notes',
  'GET /api/notes/:id',
  'GET /api/draws',
  'GET /api/draws/:id',
  'GET /api/tables',
  'GET /api/tables/:id',
  'GET /api/tables/:id/rows',
  'GET /api/files/files',
  'GET /api/files/files/:id',
  'GET /api/files/folders',
  'GET /api/files/folders/:id',
  'GET /api/tree/:kind',
  'GET /api/tree/:kind/search',
  'GET /api/tree/:kind/tags',
  'GET /api/apps',
  'GET /api/apps/:id',
  'GET /api/nodes/:id',
  'GET /api/search',
  'GET /api/mentions/search',
  'GET /api/formulas',
  'GET /api/formulas/:id',
];

const MEMBER_OPEN: ReadonlySet<string> = new Set(MEMBER_OPEN_READS);

/** Whether a non-Admin login may call `method pattern` (HEAD as GET). */
export function memberMayRead(method: string, pattern: string | null): boolean {
  if (pattern === null) return false;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return MEMBER_OPEN.has(`${m} ${pattern}`);
}
