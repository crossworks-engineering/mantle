/**
 * What the session guard does with each owner route (workspaces W6a, plan
 * 2.4 and 11): the ONE table that decides whether a request reads in the
 * signed-in user's scope or runs as Admin management.
 *
 *  - `content`: brain items. A read (GET, HEAD, or a READ_POSTS entry)
 *    enters the login's scope for the rest of the request: the union of its
 *    workspaces, on the workspace role (mantle_view_user). An Admin user
 *    reads what is granted to the workspaces it is in, like anyone. A
 *    write, an Admin user's too, runs in the login's scope: its writes on
 *    the write role (mantle_write_user) while the actor check is not off,
 *    where the database checks each one. Only the Admin acts below
 *    (ADMIN_ACT_WRITES) and the item gate's two ADMIN_ACT returns (an Admin
 *    user's link close, an Admin user's act on a deleted app's trash;
 *    session.ts) run on the system pool.
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
import { isWorkspaceArea, type WorkspaceArea } from '@mantle/client-types/dto/workspaces';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';

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
  // The landing page of the login's current workspace (task d78e7bde): its
  // home app and the Built-in home's data, in the login's scope.
  ['/api/home', 'content'],
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
  if (isWorkspaceArea(tag)) return { kind: 'area', area: tag };
  return { kind: tag as 'content' | 'self' };
}

/** POST routes that only read: scoped like a GET. */
export const READ_POSTS: ReadonlySet<string> = new Set(['POST /api/formulas/:id/evaluate']);

/** GET routes that write (A4 step 3b must-do, the 3a audit's L5): a
 *  connector's OAuth callback stores the tokens it was given (the browser
 *  lands on it with a GET). Each runs as the login its guard names. Their
 *  HEAD runs the GET handler, so it writes too. */
export const WRITE_GETS: ReadonlySet<string> = new Set([
  'GET /api/mcp-connectors/oauth/callback',
  'GET /api/microsoft/oauth/callback',
]);

/** Whether `method pattern` only reads: GET, HEAD, or a READ_POSTS entry;
 *  never a WRITE_GETS route. */
export function isReadRequest(method: string, pattern: string | null): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') return pattern === null || !WRITE_GETS.has(`GET ${pattern}`);
  return pattern !== null && READ_POSTS.has(`${m} ${pattern}`);
}

/**
 * Whether a request writes the generic `api.write` audit row
 * (session.ts auditMutation) as a write: a mutating method, or a row whose
 * effect is a write (`effect`, the request's ROUTE_POLICY row inside a
 * routed request, else null). The row's effect adds the WRITE_GETS (a
 * connector's OAuth callback stores tokens on a GET or HEAD); a READ_POSTS
 * row keeps the audit row its method always wrote.
 */
export function auditsAsWrite(method: string, effect: 'read' | 'write' | null): boolean {
  const m = method.toUpperCase();
  const byMethod = m !== '' && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
  return byMethod || effect === 'write';
}

/**
 * The content prefixes of the workspace kinds (the kind registry,
 * @mantle/client-types/kinds, workspaces arch A1): a kind of the workspace
 * class with an item route. Each has the same five item routes: list, read,
 * create, edit (PATCH) and delete. Tasks, events, formulas and Recall maps
 * joined with the registry (owner decision D1): before A1 a member reached
 * them on MCP only (formulas: reads only).
 */
export const WORKSPACE_ITEM_PREFIXES: readonly string[] = ITEM_KIND_NAMES.flatMap((t) => {
  const spec = ITEM_KINDS[t];
  return spec.class === 'workspace' && spec.route.content ? [spec.route.content] : [];
});

const itemReads = (p: string) => [`GET ${p}`, `GET ${p}/:id`];
const itemWrites = (p: string) => [`POST ${p}`, `PATCH ${p}/:id`, `DELETE ${p}/:id`];

/**
 * The owner routes a non-Admin login may call since W6a: reads of brain
 * items in the login's scope (the row rules decide what it sees; drafts are
 * read only where the login may edit the item, W6b). Writes are
 * MEMBER_OPEN_WRITES; every other owner route still refuses a member
 * (403 member-login). The list and read routes of every workspace kind come
 * from the registry; the rest are named here.
 *
 * A file's list and detail (GET /api/files/files and /:id, generated) carry
 * its text; its bytes and thumbnail stay on /api/member/files/:id (?raw and
 * ?thumb answer a plain 401 here), a drawing's on /api/member/draws/:id/svg
 * or the cached SVG below (W6b and its fix round 1).
 */
export const MEMBER_OPEN_READS: readonly string[] = [
  ...WORKSPACE_ITEM_PREFIXES.flatMap(itemReads),
  'GET /api/pages/:id/backlinks',
  'GET /api/pages/:id/descendant-count',
  'GET /api/tables/:id/rows',
  'GET /api/tree/:kind',
  'GET /api/tree/:kind/search',
  'GET /api/tree/:kind/tags',
  'GET /api/nodes/:id',
  'GET /api/search',
  'GET /api/mentions/search',
  'GET /api/tree/:kind/marks',
  // W7e: a drawing's committed SVG (JSON, or ?raw=1 as an image), in the
  // login's scope: an image whose file the login does not read is taken
  // out. Never a render for a non-Admin login (the cache only).
  'GET /api/draws/:id/svg',
  // A1 (D1): a formula's calculator (a READ_POSTS entry), a Recall card and
  // a map's revision log, in the login's scope.
  'POST /api/formulas/:id/evaluate',
  'GET /api/recall/maps/:id/cards/:card',
  'GET /api/recall/maps/:id/revisions',
  // The landing page of the current workspace (task d78e7bde): every login
  // lands on it, in its own scope.
  'GET /api/home',
];

const MEMBER_OPEN: ReadonlySet<string> = new Set(MEMBER_OPEN_READS);

/**
 * The owner routes a non-Admin login may WRITE through since W6b (plan 15,
 * 21.8 row 7): create, edit and delete the workspace kinds (the create,
 * PATCH and DELETE routes of WORKSPACE_ITEM_PREFIXES), their drafts and
 * folders, in its own scope. The request runs in the login's scope (its
 * writes on the write role while the actor check is not off); the handler
 * reads the item the route names in the login's scope first and the
 * database checks the write (0278, 0266, and for a create into a folder, a
 * move and a delete 0241, 0245, 0266) or the handler asks its right
 * (assertItemRight) before any side effect. A create lands in the
 * request's workspace (?ws=) when the login moderates it, else in the
 * folder it is made in when the login may edit that, else in the login's
 * private workspace (mantle_default_home).
 * Not here: Admin-only kinds, app review and purge, bulk deletes, imports,
 * history and snapshot restores, the formula library seed. The app runner
 * routes are here since W7e (the /api/member/apps runner routes are
 * deprecated, kept this release).
 */
export const MEMBER_OPEN_WRITES: readonly string[] = [
  ...WORKSPACE_ITEM_PREFIXES.flatMap(itemWrites),
  'PUT /api/pages/:id/draft',
  'POST /api/pages/:id/commit',
  'POST /api/pages/:id/discard-draft',
  'POST /api/pages/:id/move',
  'PUT /api/draws/:id/draft',
  'POST /api/draws/:id/commit',
  'POST /api/draws/:id/discard-draft',
  'PUT /api/tables/:id/draft',
  'POST /api/tables/:id/draft-ops',
  'POST /api/tables/:id/commit',
  'POST /api/tables/:id/discard-draft',
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
  // A1 (D1): a Recall map's cards where the login may edit the map
  // (the edit check, 0281). The owner's acts among them (a prompt confirm, a
  // reorder, a revision restore, publish, a slug change, a map delete) are
  // refused to a login outside Admin by the handler (recallActorOf: an
  // editor writes as 'agent'), as those tools are owner-only on MCP.
  'POST /api/recall/maps/:id/cards',
  'PUT /api/recall/maps/:id/cards/:card',
  'DELETE /api/recall/maps/:id/cards/:card',
  'POST /api/recall/maps/:id/cards/reorder',
  'POST /api/recall/maps/:id/cards/:card/prompt',
  'POST /api/recall/revisions/:id/restore',
];

const MEMBER_WRITE: ReadonlySet<string> = new Set(MEMBER_OPEN_WRITES);

/** Whether a non-Admin login may write through `method pattern` (W6b). */
export function memberMayWrite(method: string, pattern: string | null): boolean {
  if (pattern === null) return false;
  return MEMBER_WRITE.has(`${method.toUpperCase()} ${pattern}`);
}

/** The routes that create an item (W6b): ?ws= names where it lands. The
 *  create route of every workspace kind (the registry, A1), and a folder of
 *  any tree kind. */
export const CREATE_ROUTES: ReadonlySet<string> = new Set([
  ...WORKSPACE_ITEM_PREFIXES.map((p) => `POST ${p}`),
  'POST /api/tree/:kind/folders',
]);

/** Whether a non-Admin login may call `method pattern` (HEAD as GET). */
export function memberMayRead(method: string, pattern: string | null): boolean {
  if (pattern === null) return false;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return MEMBER_OPEN.has(`${m} ${pattern}`);
}

/*
 * The owner item routes whose write the HTTP gate checked against the
 * item's workspaces (W6a, ITEM_WRITE_PREFIXES) are all gone (the pre-check
 * removal part 2, docs/actors.md), family by family: the node kinds,
 * notes, drawings, Recall maps, pages, tables, files and folders, and last
 * the apps and the tree's items. Each write's handler reads its item in
 * the caller's scope first (the 404 of none, the same for a hidden item)
 * and the database's checks (0278, 0266, F4's lockAppRow) or the
 * handler's assertItemRight refuse what the scope may not do, before any
 * side effect.
 */

/**
 * Item routes whose `:id` is not the item's own id (W6a fix round 1, M1):
 * the guard finds the item through it. A share names its item
 * (shares.node_id); a recall revision its map (recall_maps.node_id); a
 * deleted app is gone, and its last snapshot names the workspace it was
 * homed in (meta.homeWs, the Admin workspace for a snapshot from before).
 */
export type ItemRef = 'node' | 'share' | 'deleted-app';

const ITEM_REF_PREFIXES: ReadonlyArray<readonly [string, ItemRef]> = [
  ['/api/shares', 'share'],
  ['/api/apps/deleted', 'deleted-app'],
];

/** The writes that make no item (route-policy's `makesItems` is false):
 *  the login's own marks, and running or copying an app (its data has its
 *  own rules). They were the gate's read writes (ITEM_READ_WRITES) until
 *  the pre-check removal part 2: the handler's scoped read of the app or
 *  item is their read check now. A member's mark or run never makes it a
 *  private workspace (w6b-fix1.db.test.ts). */
export const NO_ITEM_WRITES: ReadonlySet<string> = new Set([
  'POST /api/apps/:id/opened',
  'POST /api/apps/:id/frame-ticket',
  'POST /api/apps/:id/db-broker',
  'POST /api/apps/:id/tool-broker',
  'POST /api/apps/:id/duplicate',
  'POST /api/tree/items/:id/opened',
  'PUT /api/tree/items/:id/pin',
]);

/** What an item write needs of the item: to read it, to edit it
 *  (mantle_may_edit), or to manage it (mantle_may_manage). */
export type ItemWriteNeed = 'read' | 'edit' | 'manage';

/** The item a write request touches and what it needs, or null when the
 *  route names no item (a create, a list, a move by body). */
export function itemWriteTarget(
  _method: string,
  pattern: string,
  path: string,
): { id: string; need: ItemWriteNeed; ref: ItemRef } | null {
  for (const [prefix, ref] of ITEM_REF_PREFIXES) {
    const head = `${prefix}/:id`;
    if (pattern !== head && !pattern.startsWith(`${head}/`)) continue;
    const id = path.split('/')[prefix.split('/').length];
    if (!id) return null;
    // A share is a link: opening, changing and closing it needs edit of its
    // item (docs/workspaces.md; an app's link needs manage, which the gate
    // asks once it knows the item's type). A deleted app's purge and
    // restore manage it.
    const need: ItemWriteNeed = ref === 'deleted-app' ? 'manage' : 'edit';
    return { id, need, ref };
  }
  return null;
}

/**
 * Admin acts on the system pool (F4 fix round 1): the write routes on which
 * an Admin user's request runs on the system pool with no scope, its reads
 * and its transactions, after the guard's Admin check (the login is an
 * Admin user: enterLoginWrite with admin set; a member never reaches them,
 * none is in MEMBER_OPEN_WRITES, and they refuse it as every other owner
 * route does). Each one's tables are ones no workspace scope reads, or its
 * rule is the brain's and not the caller's workspaces:
 *  - a contact's sharing (its code: contact_share_codes, never granted to
 *    the workspace role), sharing an item with contacts (the code rows,
 *    locked FOR SHARE, and the item read whatever its home: docs/
 *    workspaces.md, "Share it with one contact: to be an Admin user, its
 *    home is not checked") and Revoke all of a contact's shares (every live
 *    share of the contact, items outside the user's workspaces included);
 *  - merging two entities: the entity graph is Admin's (0265), and every
 *    fact of the duplicate moves, a fact of an item outside the user's
 *    workspaces included (facts.entity_id is ON DELETE SET NULL: a fact the
 *    scope did not move would lose its entity when the duplicate goes).
 */
export const ADMIN_ACT_WRITES: ReadonlySet<string> = new Set([
  'POST /api/contacts/:id/sharing',
  'DELETE /api/contacts/:id/shares',
  'POST /api/shares/contacts',
  'POST /api/entities/merge',
]);

/** Whether an Admin user's write through `method pattern` is an Admin act
 *  on the system pool (ADMIN_ACT_WRITES). */
export function adminActWrite(method: string, pattern: string): boolean {
  return ADMIN_ACT_WRITES.has(`${method.toUpperCase()} ${pattern}`);
}
