/**
 * ROUTE_POLICY (workspaces arch plan v2, section 7; A4 step 1): one row per
 * route of the manifest and method, the one place the HTTP pipeline reads
 * what a route is. The route loader builds the rows once, when it
 * registers a route; the gate middleware finds the row of a request once,
 * sets it on the request context and hands it to enterCall (@mantle/db
 * gate.ts). Every session guard and the API key checks (the gate's
 * gateAccessKey, the guard's accessKeyLogin) read the row
 * (currentRoute()), never the route lists.
 *
 * Step 1 is no behaviour change: each field is folded from the list that
 * decided it before, by the same functions, so every answer is what it
 * was (route-policy.test.ts pins each field against its list for every
 * route and method). Step 4 moves the lists' data into this table and
 * deletes them:
 *
 *  - class, scope, area: ROUTE_PREFIXES (routeClass), PUBLIC_PATHS, the
 *    /s link routes and the login lists;
 *  - effect: READ_POSTS (isReadRequest);
 *  - open, logins: MEMBER_OPEN_READS, MEMBER_OPEN_WRITES, ANY_LOGIN_ROUTES,
 *    CHAT_LOGIN_ROUTES, TELEGRAM_LOGIN_ROUTES and MEMBER_ROUTES;
 *  - creates, makesItems: CREATE_ROUTES and the item target (what
 *    requestCreatePolicy read);
 *  - item: ITEM_WRITE_PREFIXES, ITEM_REF_PREFIXES, ITEM_READ_WRITES and
 *    ITEM_MANAGE_WRITES (itemWriteTarget);
 *  - keyArea, aliasOf: API_V1_ROUTES and the v1 alias files.
 *
 * The content rows come from the kind registry (@mantle/client-types
 * kinds) through those lists: WORKSPACE_ITEM_PREFIXES, CREATE_ROUTES and
 * the member lists are generated from ITEM_KINDS.
 */
import type { WorkspaceArea } from '@mantle/client-types';
import { registerPolicySource, type GatePolicy, type PolicyRef } from '@mantle/db';
import type { AccessKeyArea } from '../access-keys';
import { API_V1_ROUTES, type KeyRoute } from '../api-v1';
import { getRequestContext } from '../../server/request-context';
import { PUBLIC_PATHS } from '../auth-constants';
import { ANY_LOGIN_ROUTES, CHAT_LOGIN_ROUTES, TELEGRAM_LOGIN_ROUTES } from './any-login-routes';
import { isMemberRoute } from './member-routes';
import {
  CREATE_ROUTES,
  isReadRequest,
  itemWriteTarget,
  memberMayRead,
  memberMayWrite,
  routeClass,
  type ItemRef,
  type ItemWriteNeed,
  type RouteClass,
} from './route-scope';

/** The class of a route (plan 7). */
export type RoutePolicyClass = 'public' | 'link' | 'render' | 'self' | 'area' | 'content';

/** Which login list opens a route to a login outside Admin: the owner
 *  routes a non-Admin login may call (MEMBER_OPEN_READS and
 *  MEMBER_OPEN_WRITES), the any-login routes, the chat routes, the Telegram
 *  pairing routes, the member routes. */
export type RouteLogins = 'owner' | 'any' | 'chat' | 'telegram' | 'member';

/** The item a write names (itemWriteTarget): what it needs of the item,
 *  how the id names it, and the path segment the id is in. */
export type RouteItem = Readonly<{ need: ItemWriteNeed; ref: ItemRef; seg: number }>;

/** One ROUTE_POLICY row: one method of one manifest pattern. */
export type RouteRow = Readonly<{
  /** `METHOD pattern`, the pattern as the manifest writes it. */
  key: string;
  method: string;
  pattern: string;
  /** The class (plan 7): what the route serves. A link route (/s) and a
   *  public one name no login; the others are the scope's. */
  class: RoutePolicyClass;
  /** What the owner session guard does with the route (routeClass): reads
   *  in the login's scope (content), the login's own things (self), or
   *  management of an area. Null: no owner guard serves it (one refuses it,
   *  unclassified). */
  scope: RouteClass | null;
  /** The Admin area the route manages, when it is one. */
  area: WorkspaceArea | null;
  /** The gate lets it in with no credential (PUBLIC_PATHS): the route
   *  judges its own (a token, a key, the OAuth bearer, or nobody). */
  public: boolean;
  /** Who may call it: a user of Admin only, or a login of another kind
   *  through `logins`. */
  open: 'admin' | 'login';
  logins: RouteLogins | null;
  effect: 'read' | 'write';
  /** It creates an item: ?ws= names where it lands. */
  creates: boolean;
  /** A write that may make an item (its private workspace may be made). */
  makesItems: boolean;
  item: RouteItem | null;
  /** The area an API key needs (an /api/v1 row of the key table): null
   *  for a route open only to a key with every area, or about the key
   *  itself (keySelf); absent off the key table. */
  keyArea?: AccessKeyArea | null;
  /** An /api/v1 row about the key itself (whoami, API_V1_ROUTES `self`):
   *  every key may call it, whatever its areas. Absent off the key table. */
  keySelf?: boolean;
  /** A v1 row: the route whose handler it re-exports (D3). */
  aliasOf: string | null;
  /** The system reason a public route that writes runs as. Null in step 1:
   *  every public write still runs as system(http:no-login), the request
   *  slot's first actor; step 3 names each (plan 7, 20.3). */
  actor: string | null;
}>;

/** A concrete path for `pattern`: param `i` is `{p<i>}`, a catch-all
 *  `{rest}`, so the item target's id names the segment it came from. */
function markedPath(pattern: string): string {
  let i = 0;
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, () => `{p${i++}}`).replace(/\*$/, '{rest}');
}

/** The client portal's routes, removed in workspaces W5c (and the client
 *  login with it, W8a): each is a stub that answers any login 410 gone
 *  (lib/gone.ts), about the login only. No other list names them. */
const CLIENT_PORTAL_GONE = '/api/client/';

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** The login list that opens `method pattern`; at most one does. */
function loginsOf(method: string, pattern: string): RouteLogins | null {
  const key = `${method} ${pattern}`;
  const found: RouteLogins[] = [];
  if (memberMayRead(method, pattern) || memberMayWrite(method, pattern)) found.push('owner');
  if (ANY_LOGIN_ROUTES.includes(key)) found.push('any');
  if (CHAT_LOGIN_ROUTES.includes(key)) found.push('chat');
  if (TELEGRAM_LOGIN_ROUTES.includes(key)) found.push('telegram');
  if (isMemberRoute(method, pattern)) found.push('member');
  if (found.length > 1) {
    throw new Error(`ROUTE_POLICY: ${key} is in more than one login list (${found.join(', ')})`);
  }
  return found[0] ?? null;
}

/** The v1 route a pattern and method name (HEAD as GET). */
function v1Route(method: string, pattern: string) {
  const m = method === 'HEAD' ? 'GET' : method;
  return API_V1_ROUTES.find((r) => r.method === m && r.pattern === pattern) ?? null;
}

/** A v1 row's base route (D3): the same method on the pattern without
 *  /v1 (files: /api/files/files), when the manifest serves it there and
 *  the v1 file has no handler of its own (API_V1_ROUTES `own`). The alias
 *  files re-export that handler (route-policy.test.ts reads them). */
function aliasOf(method: string, pattern: string, served: (key: string) => boolean): string | null {
  if (!pattern.startsWith('/api/v1/') || v1Route(method, pattern)?.own) return null;
  const base = pattern.startsWith('/api/v1/files')
    ? pattern.replace('/api/v1/files', '/api/files/files')
    : pattern.replace('/api/v1/', '/api/');
  const key = `${method} ${base}`;
  return served(key) ? key : null;
}

/**
 * The row of `method pattern`, from the lists (step 1). `served` says
 * which `METHOD pattern` keys the manifest serves (the v1 aliases).
 */
export function buildRouteRow(
  method: string,
  pattern: string,
  served: (key: string) => boolean = () => false,
): RouteRow {
  const m = method.toUpperCase();
  const key = `${m} ${pattern}`;
  const scope = routeClass(pattern);
  const logins = loginsOf(m, pattern);
  const effect = isReadRequest(m, pattern) ? 'read' : 'write';
  if (memberMayRead(m, pattern) && effect !== 'read') {
    throw new Error(`ROUTE_POLICY: ${key} is a member read that writes`);
  }
  if (memberMayWrite(m, pattern) && effect !== 'write') {
    throw new Error(`ROUTE_POLICY: ${key} is a member write that reads`);
  }
  const path = markedPath(pattern);
  const target = itemWriteTarget(m, pattern, path);
  let item: RouteItem | null = null;
  if (target) {
    const seg = path.split('/').indexOf(target.id);
    if (seg < 0) throw new Error(`ROUTE_POLICY: ${key} names its item outside a path param`);
    item = Object.freeze({ need: target.need, ref: target.ref, seg });
  }
  const isPublic = isPublicPath(path);
  // HEAD is answered by the GET handler, so it has GET's class. Its
  // `logins` stay what the lists say of HEAD (none name it: an any-login
  // GET's HEAD is not an any-login route today), so such a HEAD row is
  // class 'self' with logins null and open 'admin': a login outside Admin
  // gets the GET's answer refused on HEAD. OPEN OWNER QUESTION for A4 step
  // 4 (fix round 1, M3): should HEAD take GET's logins too? Step 1 keeps
  // today's answer; route-policy.test.ts pins it, so a change is
  // deliberate.
  const classLogins = m === 'HEAD' ? loginsOf('GET', pattern) : logins;
  const cls: RoutePolicyClass | null = pattern.startsWith('/s/')
    ? 'link'
    : (scope?.kind ??
      (isPublic
        ? 'public'
        : classLogins || pattern.startsWith(CLIENT_PORTAL_GONE)
          ? 'self'
          : null));
  // A route no list names is refused here, so a new route is classed
  // before it ships (route-policy.test.ts builds every row).
  if (cls === null) throw new Error(`ROUTE_POLICY: ${key} has no class`);
  const v1 = v1Route(m, pattern);
  return Object.freeze({
    key,
    method: m,
    pattern,
    class: cls,
    scope,
    area: scope?.kind === 'area' ? scope.area : null,
    public: isPublic,
    open: logins ? 'login' : 'admin',
    logins,
    effect,
    creates: CREATE_ROUTES.has(key),
    makesItems: !(m === 'DELETE' || target?.need === 'read'),
    item,
    // A v1 pattern the key table does not list has none: no key calls it
    // (api-v1.test.ts pins the table to the route files).
    ...(pattern.startsWith('/api/v1/') && v1
      ? { keyArea: v1.area, keySelf: v1.self === true }
      : {}),
    aliasOf: aliasOf(m, pattern, served),
    actor: null,
  });
}

/** The manifest shape the table is built from. */
export type RouteManifestEntry = Readonly<{ pattern: string; methods: readonly string[] }>;

/** The methods a manifest entry is called with: its own, and HEAD where
 *  it serves GET (Hono answers HEAD with the GET handler). */
export function servedMethods(entry: RouteManifestEntry): string[] {
  const methods = entry.methods.map((m) => m.toUpperCase());
  return methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods;
}

/** ROUTE_POLICY over a manifest: `METHOD pattern` to its row. */
export function buildRoutePolicy(
  manifest: readonly RouteManifestEntry[],
): ReadonlyMap<string, RouteRow> {
  const keys = new Set(manifest.flatMap((e) => servedMethods(e).map((m) => `${m} ${e.pattern}`)));
  const served = (key: string) => keys.has(key);
  const table = new Map<string, RouteRow>();
  for (const entry of manifest) {
    for (const m of servedMethods(entry)) {
      const row = buildRouteRow(m, entry.pattern, served);
      table.set(row.key, row);
    }
  }
  return table;
}

// ── The gate's route source and the stored row ──────────────────────────────

/** A row's declared policy (the gate's step 3). The Admin step names the
 *  row's area; in step 1 the HTTP caller's Admin view is not resolved yet
 *  (null: the session guard still runs requireArea), so the guard decides,
 *  as before. */
export function routeGatePolicy(row: RouteRow): GatePolicy {
  return Object.freeze({
    effect: row.effect,
    scope: row.area ? { area: row.area } : 'any',
    creates: row.creates,
    makesItems: row.makesItems,
    fields: Object.freeze({
      route: row.key,
      class: row.class,
      open: row.open,
      ...(row.keyArea !== undefined ? { keyArea: row.keyArea } : {}),
      ...(row.keySelf ? { keySelf: true } : {}),
    }),
  });
}

/** The gate's ref for a row: the row rides along, so step 3 does not look
 *  it up again. */
export function routeRef(row: RouteRow): PolicyRef {
  return Object.freeze({ kind: 'route', name: row.key, row });
}

function routeSource(ref: PolicyRef): GatePolicy | null {
  const row = ref.row as RouteRow | undefined;
  return row && row.key === ref.name ? routeGatePolicy(row) : null;
}

/** Register the gate's `route` source (the same function again is a
 *  no-op). The gate middleware does, when the app is built: the only
 *  caller of enterCall with a route ref. Not at import, so a module that
 *  only reads the stored row (the session guards) registers nothing. */
export function registerRouteSource(): void {
  registerPolicySource('route', routeSource);
}

/** The ROUTE_POLICY row of the current request, as the gate middleware
 *  found it and set it on the request context (fix round 1, M1: on the
 *  request, not the bound caller, so a call nested inside the request with
 *  a caller of its own still reads it); null outside a routed request (a
 *  test calling a handler, a worker). The session guards read this, and
 *  refuse a request slot that has no row (session.ts guardRoute). */
export function currentRoute(): RouteRow | null {
  return getRequestContext()?.route ?? null;
}

/** What an API key is held to on a row (keyMayCall): the v1 table's entry
 *  as the row carries it, or null off the table (not part of the API a key
 *  can call). The row's effect is the table's access (route-policy.test.ts). */
export function rowKeyRoute(row: RouteRow | null): KeyRoute | null {
  if (!row || row.keyArea === undefined) return null;
  return {
    access: row.effect,
    area: row.keyArea,
    ...(row.keySelf ? { self: true as const } : {}),
  };
}

/** The item a write request names, from its row and path (what
 *  itemWriteTarget answers), or null. */
export function routeItemTarget(
  row: RouteRow,
  path: string,
): { id: string; need: ItemWriteNeed; ref: ItemRef } | null {
  if (!row.item) return null;
  const id = path.split('/')[row.item.seg];
  if (!id) return null;
  return { id, need: row.item.need, ref: row.item.ref };
}

/** A login outside Admin may read through this owner route
 *  (memberMayRead). */
export function memberOpenRead(row: RouteRow): boolean {
  return row.logins === 'owner' && row.effect === 'read';
}

/** A login outside Admin may write through this owner route
 *  (memberMayWrite). */
export function memberOpenWrite(row: RouteRow): boolean {
  return row.logins === 'owner' && row.effect === 'write';
}

/** An any-login route: the any-login, chat and Telegram lists
 *  (isAnyLoginRoute). */
export function anyLoginRow(row: RouteRow): boolean {
  return row.logins === 'any' || row.logins === 'chat' || row.logins === 'telegram';
}
