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
  ['/api/contacts', 'content'],
  ['/api/events', 'content'],
  ['/api/recall', 'content'],
  ['/api/export', 'content'],
  ['/api/shares', 'content'],
  ['/api/docs', 'content'],
  ['/api/activity', 'content'],
  ['/api/v1', 'content'],
  // The Apps sidebar of older clients: the apps the login's scope reads
  // (W6a fix round 1, M2), with its own pins.
  ['/api/app-nav', 'content'],
  // The login's own things.
  ['/api/profile', 'self'],
  ['/api/push', 'self'],
  ['/api/assistant', 'self'],
  ['/api/auth', 'self'],
  ['/api/changelog', 'self'],
  ['/api/help', 'self'],
  ['/api/health', 'self'],
  ['/api/realtime', 'self'],
  ['/api/version', 'self'],
  // An Admin user's own private items (its personal space, until W6b).
  ['/api/admin', 'self'],
  // The member routes (W7e): every one that reads brain items runs in the
  // login's request scope ('content'), the member home too (it reads team
  // pages and apps); its own things (its MCP clients, push devices, the live
  // stream and the old shell) are the login's own, as an Admin user's
  // /api/push and /api/realtime are. Only these 'self' member routes still
  // hold their own rule (getMemberOr401).
  ['/api/member', 'content'],
  ['/api/member/mcp', 'self'],
  ['/api/member/push', 'self'],
  ['/api/member/realtime', 'self'],
  ['/api/member/shell', 'self'],
  // Management: settings.
  ['/api/onboarding', 'settings'],
  // The brain overview: counts over every store, telegram and mail included.
  ['/api/dashboard', 'settings'],
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
  // Who opened an app: login names and addresses, user management.
  ['/api/apps/:id/access-log', 'users'],
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
  // Mail (Admin-only items) with its accounts, sealed credentials included.
  ['/api/email', 'connectors'],
  ['/api/attachments', 'connectors'],
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
 * read only where the login may edit the item, W6b). Writes are
 * MEMBER_OPEN_WRITES; every other owner route still refuses a member
 * (403 member-login).
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
  // W6b: a member's own files are brain items now (their bytes and a
  // drawing's SVG through /api/member/files/:id and /api/member/draws/:id/svg).
  'GET /api/files/files',
  // W6b fix round 1: a file's detail (its text too), so a member opens it
  // and a /n link finds its folder. Its bytes and thumbnail stay on
  // /api/member/files/:id (?raw and ?thumb answer a plain 401 here).
  'GET /api/files/files/:id',
  'GET /api/files/folders',
  'GET /api/files/folders/:id',
  'GET /api/tree/:kind/marks',
  // W7e: a drawing's committed SVG (JSON, or ?raw=1 as an image), in the
  // login's scope: an image whose file the login does not read is taken
  // out. Never a render for a non-Admin login (the cache only).
  'GET /api/draws/:id/svg',
];

const MEMBER_OPEN: ReadonlySet<string> = new Set(MEMBER_OPEN_READS);

/**
 * The owner routes a non-Admin login may WRITE through since W6b (plan 15,
 * 21.8 row 7): create, edit and delete pages, notes, drawings, tables, files
 * and apps, their drafts and folders, in its own scope. The request runs in
 * the login's scope (writes on the system pool); an item the route names is
 * checked first (itemWriteTarget: mantle_may_edit, or mantle_may_manage for
 * a delete or a move), and the database checks the rest on the request's
 * system transactions (a create into a folder, a move, a delete: 0241,
 * 0245, 0266). A create lands in the request's workspace (?ws=) when the
 * login moderates it, else in the folder it is made in when the login may
 * edit that, else in the login's private workspace (mantle_default_home).
 * Not here: Admin-only kinds, app review and purge, bulk deletes, imports,
 * history and snapshot restores. The app runner routes are here since W7e
 * (the /api/member/apps runner routes are deprecated, kept this release).
 */
export const MEMBER_OPEN_WRITES: readonly string[] = [
  'POST /api/pages',
  'PATCH /api/pages/:id',
  'DELETE /api/pages/:id',
  'PUT /api/pages/:id/draft',
  'POST /api/pages/:id/commit',
  'POST /api/pages/:id/discard-draft',
  'POST /api/pages/:id/move',
  'POST /api/notes',
  'PATCH /api/notes/:id',
  'DELETE /api/notes/:id',
  'POST /api/draws',
  'PATCH /api/draws/:id',
  'DELETE /api/draws/:id',
  'PUT /api/draws/:id/draft',
  'POST /api/draws/:id/commit',
  'POST /api/draws/:id/discard-draft',
  'POST /api/tables',
  'PATCH /api/tables/:id',
  'DELETE /api/tables/:id',
  'PUT /api/tables/:id/draft',
  'POST /api/tables/:id/draft-ops',
  'POST /api/tables/:id/commit',
  'POST /api/tables/:id/discard-draft',
  'POST /api/files/files',
  'PATCH /api/files/files/:id',
  'DELETE /api/files/files/:id',
  'POST /api/files/folders',
  'PATCH /api/files/folders/:id',
  'DELETE /api/files/folders/:id',
  'POST /api/apps',
  'PATCH /api/apps/:id',
  'DELETE /api/apps/:id',
  'PUT /api/apps/:id/draft',
  'DELETE /api/apps/:id/draft',
  'POST /api/apps/:id/build',
  'POST /api/apps/:id/format',
  'POST /api/apps/:id/publish',
  'POST /api/tree/:kind/folders',
  'PATCH /api/tree/:kind/folders/:id',
  'DELETE /api/tree/:kind/folders/:id',
  'POST /api/tree/:kind/move',
  'POST /api/tree/items/:id/opened',
  'PUT /api/tree/items/:id/pin',
  // W7e: running an app, for every login in its scope (lib/app-runner.ts):
  // the frame ticket, the app's own database and its declared tools. A
  // non-Admin login runs the PUBLISHED build at the team rules; an app it
  // does not read is a 404 (never the item-workspace 403).
  'POST /api/apps/:id/frame-ticket',
  'POST /api/apps/:id/db-broker',
  'POST /api/apps/:id/tool-broker',
];

const MEMBER_WRITE: ReadonlySet<string> = new Set(MEMBER_OPEN_WRITES);

/** Whether a non-Admin login may write through `method pattern` (W6b). */
export function memberMayWrite(method: string, pattern: string | null): boolean {
  if (pattern === null) return false;
  return MEMBER_WRITE.has(`${method.toUpperCase()} ${pattern}`);
}

/** The routes that create an item (W6b): ?ws= names where it lands. */
export const CREATE_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/pages',
  'POST /api/notes',
  'POST /api/draws',
  'POST /api/tables',
  'POST /api/files/files',
  'POST /api/files/folders',
  'POST /api/apps',
  'POST /api/tree/:kind/folders',
]);

/** Whether a non-Admin login may call `method pattern` (HEAD as GET). */
export function memberMayRead(method: string, pattern: string | null): boolean {
  if (pattern === null) return false;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return MEMBER_OPEN.has(`${m} ${pattern}`);
}

/**
 * The owner item routes whose write is checked against the item's
 * workspaces (W6a): the path segment right after the prefix (the `:id` of
 * the pattern) names the item. An Admin user's write still runs on the
 * system pool, but only on an item its scope may edit (plan S1: an item
 * homed in a workspace it is not in needs it to add itself first).
 */
export const ITEM_WRITE_PREFIXES: readonly string[] = [
  '/api/pages',
  '/api/notes',
  '/api/draws',
  '/api/tables',
  '/api/apps',
  '/api/files/files',
  '/api/files/folders',
  '/api/tree/:kind/folders',
  '/api/tree/items',
  '/api/v1/pages',
  '/api/v1/tables',
  // W6a fix round 1 (M1): the other workspace kinds with an item route.
  '/api/formulas',
  '/api/tasks',
  '/api/events',
  '/api/v1/tasks',
  '/api/recall/maps',
];

/**
 * Item routes whose `:id` is not the item's own id (W6a fix round 1, M1):
 * the guard finds the item through it. A share names its item
 * (shares.node_id); a recall revision its map (recall_maps.node_id); a
 * deleted app is gone, and its last snapshot names the workspace it was
 * homed in (meta.homeWs, the Admin workspace for a snapshot from before).
 */
export type ItemRef = 'node' | 'share' | 'recall-revision' | 'deleted-app';

const ITEM_REF_PREFIXES: ReadonlyArray<readonly [string, ItemRef]> = [
  ['/api/shares', 'share'],
  ['/api/recall/revisions', 'recall-revision'],
  ['/api/apps/deleted', 'deleted-app'],
];

/** Item writes that only need the item to be readable: the login's own
 *  marks, and running or copying an app (its data has its own rules). */
const ITEM_READ_WRITES: ReadonlySet<string> = new Set([
  'POST /api/apps/:id/opened',
  'POST /api/apps/:id/frame-ticket',
  'POST /api/apps/:id/db-broker',
  'POST /api/apps/:id/tool-broker',
  'POST /api/apps/:id/duplicate',
  'POST /api/tree/items/:id/opened',
  'PUT /api/tree/items/:id/pin',
]);

/** Item writes that manage the item (delete, move): Moderators of its home
 *  (mantle_may_manage), as the grant rules say (0241). */
const ITEM_MANAGE_WRITES: ReadonlySet<string> = new Set(['POST /api/pages/:id/move']);

/** What an item write needs of the item: to read it, to edit it
 *  (mantle_may_edit), or to manage it (mantle_may_manage). */
export type ItemWriteNeed = 'read' | 'edit' | 'manage';

/** The item a write request touches and what it needs, or null when the
 *  route names no item (a create, a list, a move by body). */
export function itemWriteTarget(
  method: string,
  pattern: string,
  path: string,
): { id: string; need: ItemWriteNeed; ref: ItemRef } | null {
  const m = method.toUpperCase();
  for (const [prefix, ref] of ITEM_REF_PREFIXES) {
    const head = `${prefix}/:id`;
    if (pattern !== head && !pattern.startsWith(`${head}/`)) continue;
    const id = path.split('/')[prefix.split('/').length];
    if (!id) return null;
    // A share is a link (manage, 0241); a revision restore edits the map;
    // a deleted app's purge and restore manage it.
    const need: ItemWriteNeed = ref === 'share' || ref === 'deleted-app' ? 'manage' : 'edit';
    return { id, need, ref };
  }
  for (const prefix of ITEM_WRITE_PREFIXES) {
    const head = `${prefix}/:id`;
    if (pattern !== head && !pattern.startsWith(`${head}/`)) continue;
    const id = path.split('/')[prefix.split('/').length];
    if (!id) return null;
    const key = `${m} ${pattern}`;
    const need: ItemWriteNeed = ITEM_READ_WRITES.has(key)
      ? 'read'
      : ITEM_MANAGE_WRITES.has(key) || (m === 'DELETE' && pattern === head)
        ? 'manage'
        : 'edit';
    return { id, need, ref: 'node' };
  }
  return null;
}
