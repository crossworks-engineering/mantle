/**
 * ROUTE_POLICY (workspaces arch plan v2, section 7; A4 step 1): one row per
 * route of the manifest and method, the one place the HTTP pipeline reads
 * what a route is. The route loader builds the rows once, when it
 * registers a route; the gate middleware finds the row of a request once,
 * sets it on the request context and hands it to enterCall (@mantle/db
 * gate.ts). Every session guard and the API key checks (the gate's
 * gateAccessKey, the login lookup's findKeyLogin, both through keyOnRow)
 * read the row (currentRoute()), never the route lists.
 *
 * Step 1 is no behaviour change: each field is folded from the list that
 * decided it before, by the same functions, so every answer is what it
 * was (route-policy.test.ts pins each field against its list for every
 * route and method). Step 4 moves the lists' data into this table and
 * deletes them:
 *
 *  - class, scope, area: ROUTE_PREFIXES (routeClass), PUBLIC_PATHS, the
 *    /s link routes and the login lists;
 *  - effect: READ_POSTS and WRITE_GETS (isReadRequest);
 *  - open, logins: MEMBER_OPEN_READS, MEMBER_OPEN_WRITES, ANY_LOGIN_ROUTES,
 *    CHAT_LOGIN_ROUTES, TELEGRAM_LOGIN_ROUTES and MEMBER_ROUTES;
 *  - creates, makesItems: CREATE_ROUTES and the item target (what
 *    requestCreatePolicy read);
 *  - item: ITEM_WRITE_PREFIXES, ITEM_REF_PREFIXES, ITEM_READ_WRITES and
 *    ITEM_MANAGE_WRITES (itemWriteTarget);
 *  - keyArea, aliasOf: API_V1_ROUTES and the v1 alias files.
 *
 * Step 2 adds the pages of server/pages (the /s page, class 'link'; the
 * render surfaces, class 'render'): the loader registers them with their
 * rows (registerPages), so they run through enterCall too. The gate reads
 * a routed request's credential answers from its row (gateRouteView in the
 * gate middleware): `public`, the /s brokers' CORS (`cors`, was the gate's
 * SHARE_BROKER_RE) and the render cookie (`renderCookie`, was isRenderPath).
 *
 * The content rows come from the kind registry (@mantle/client-types
 * kinds) through those lists: WORKSPACE_ITEM_PREFIXES, CREATE_ROUTES and
 * the member lists are generated from ITEM_KINDS.
 */
import type { WorkspaceArea } from '@mantle/client-types';
import { registerPolicySource, systemActor, type GatePolicy, type PolicyRef } from '@mantle/db';
import type { AccessKeyArea, AccessKeyGrant } from '../access-keys';
import { API_V1_ROUTES, keyMayCall, type KeyRoute } from '../api-v1';
import { getRequestContext } from '../../server/request-context';
import { isPublicPath, isRenderAssetPath } from '../auth-constants';
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

/**
 * The class of a page of server/pages, as the page list says it when the
 * loader registers it (registerPages): the /s page is 'link', the render
 * surfaces (server/pages/print.ts PRINT_PAGES, the pages a render cookie
 * opens, each bound to the node the cookie names) are 'render'. No second
 * list of the render patterns: the page list is the one.
 */
export type PageClass = 'link' | 'render';

/**
 * The /s routes a client-origin page may call cross-origin (the share token
 * is the only credential): the app brokers, plus the view/rows pair. They
 * get the same CORS treatment as /api/** and ONLY they: the /s/<token> page
 * and the other sub-paths (a/, evaluate, draw, frame, code) are same-origin
 * surfaces with no CORS headers at all. Was the gate's SHARE_BROKER_RE.
 */
const LINK_CORS_PATTERNS: ReadonlySet<string> = new Set([
  '/s/:token/bundle',
  '/s/:token/bundle/css',
  '/s/:token/frame-ticket',
  '/s/:token/tool-broker',
  '/s/:token/db-broker',
  '/s/:token/view',
  '/s/:token/rows',
]);

/** Whether a pattern is one of the /s routes with CORS (any method: the
 *  gate answers their preflight). */
export function linkCors(pattern: string): boolean {
  return LINK_CORS_PATTERNS.has(pattern);
}

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

/** Whose answer the pipeline gives before a handler (RouteRow.caller): the
 *  guard of that kind, run once by the gate (session.ts answerRouteCaller).
 *  'owner': the owner guard's (getOwnerOr401WithLogin), on the owner rows;
 *  'member': the member guard's (getMemberOr401), on the member list;
 *  'login': the any-login guard's (getLoginOr401), on the any-login list;
 *  'chat': the chat guard's (getChatLoginOr401), on the chat and Telegram
 *  lists (A4 step 3b part 5). */
export type RouteCaller = 'owner' | 'member' | 'login' | 'chat';

/** The login lists whose rows each caller kind's guard serves (null: the
 *  owner rows open to Admin only). The owner guard serves the owner rows
 *  and the members' open reads and writes of them; each other guard its
 *  own list. */
const CALLER_LOGINS: Readonly<Record<RouteCaller, ReadonlyArray<RouteLogins | null>>> = {
  owner: [null, 'owner'],
  member: ['member'],
  login: ['any'],
  chat: ['chat', 'telegram'],
};

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
  /** A /s route a client-origin page may call cross-origin (linkCors). */
  cors: boolean;
  /** The render cookie (kind 'r') opens it: a render page or a byte route
   *  a render page loads, GET only (the HEAD row does not). */
  renderCookie: boolean;
  /** A page of server/pages (registerPages), not a handler of the
   *  manifest: it runs in an actor slot of its own, with no request slot
   *  (no session guard fills one). */
  page: boolean;
  /** The system reason the request's actor slot starts as, before the
   *  session guard, the share gate or the render guard names the caller:
   *  http:no-login for a manifest route, http:share-page for the /s page,
   *  http:render for a render page. */
  startsAs: string;
  /** Whose answer the pipeline gives before the handler (arch A4 step 3b):
   *  the guard of that kind (RouteCaller), run once by the gate from this
   *  row (session.ts answerRouteCaller) and refused with there; the handler
   *  reads it (ownerCaller(), memberCaller(), loginCaller(),
   *  chatLoginCaller()) and calls no guard. Set where the route file's
   *  handler for the method reads it (the manifest's `reads`, from the
   *  code: scripts/route-callers.ts); a HEAD row has its GET's. Null: the
   *  handler's own guard answers, as before. */
  caller: RouteCaller | null;
  /** A retired route's 410 stub (lib/gone.ts `gone(kind)`, A4 hand batch
   *  A): its handler reads the caller of the stub's kind and answers 410.
   *  The gate answers that kind's guard on it, whatever list the row is in:
   *  the guard the stub called before (the member guard on a retired member
   *  route no member list names any more, the any-login guard on the
   *  client portal's). The answer is the guard's own function, so it is the
   *  stub's as before; the any-login answer writes no audit row on a stub
   *  (none was written: getLoginOr401 without `audit`). */
  gone: boolean;
  /** The system reason a public route that writes runs as (plan 7, 20.3),
   *  null on every other row (it runs as its caller). A4 step 3a names the
   *  actor each runs as today: the request slot's first actor,
   *  system(http:no-login), until a guard or a share gate names a caller
   *  (signup, invite accept, sign in, the token routes, OAuth, the /s
   *  brokers). The OAuth callbacks of a connector and the onboarding seed
   *  are not public: they run as the login their guard names. The gate's
   *  step 3 binds it (routeGatePolicy) and the request slot starts as it. */
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

/** The class of the login's own things (route-scope.ts `self`). */
const SELF_SCOPE: RouteClass = Object.freeze({ kind: 'self' });

/**
 * Rows open to every Admin user though their prefix names an Admin area: a
 * named carve-out, the login's own (`self`). The owner's decision of
 * 2026-10-14 (docs/actors.md, A4 step 3b part 4): the cached update banner,
 * GET /api/updates/check (and its HEAD), stays open to every Admin user,
 * while GET /api/updates/status and POST /api/updates/check need the
 * settings area their rows name.
 */
export const ADMIN_OPEN_ROWS: ReadonlySet<string> = new Set(['GET /api/updates/check']);

/**
 * What the row serves (its scope): its pattern's prefix (routeClass), but
 * the Telegram chat rows (TELEGRAM_LOGIN_ROUTES, and the HEAD their GET
 * handler answers) are the login's own chats, `self`, whatever their prefix
 * says (A4 step 3b must-do, the 3a audit's L5). They are open to every
 * login and served by their own gate (getChatLoginOr401), which never asks
 * an Admin area, like the assistant chat rows: classed in the connectors
 * area, the gate's area check would refuse an Admin user without that area
 * while letting a member in. And the named carve-outs open to every Admin
 * user (ADMIN_OPEN_ROWS). `classLogins` is the login list of the row's
 * class (GET's for a HEAD).
 */
function rowScope(
  method: string,
  pattern: string,
  classLogins: RouteLogins | null,
): RouteClass | null {
  if (classLogins === 'telegram') return SELF_SCOPE;
  if (ADMIN_OPEN_ROWS.has(`${method === 'HEAD' ? 'GET' : method} ${pattern}`)) return SELF_SCOPE;
  return routeClass(pattern);
}

/**
 * The row of `method pattern`, from the lists (step 1). `served` says
 * which `METHOD pattern` keys the manifest serves (the v1 aliases).
 */
export function buildRouteRow(
  method: string,
  pattern: string,
  served: (key: string) => boolean = () => false,
  opts: { page?: PageClass; reads?: RouteCaller | null; gone?: boolean } = {},
): RouteRow {
  const m = method.toUpperCase();
  const key = `${m} ${pattern}`;
  // The gate's spelling test of the pattern, compiled here so a pattern it
  // cannot spell fails when the rows are built (at boot).
  compileSpelling(pattern);
  // HEAD is answered by the GET handler, so it has GET's class and GET's
  // logins (the owner's decision of 2026-10-14, 2a, the open question M3):
  // a login outside Admin that may GET a row may HEAD it, under the same
  // rule (the any-login, chat and Telegram lists: its own scope, not the
  // system pool). The owner routes' HEAD always had it (memberMayRead
  // reads HEAD as GET); the lists name GET only.
  const logins = loginsOf(m === 'HEAD' ? 'GET' : m, pattern);
  const classLogins = logins;
  const scope = rowScope(m, pattern, classLogins);
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
  const listed: RoutePolicyClass | null = pattern.startsWith('/s/')
    ? 'link'
    : (scope?.kind ??
      (isPublic
        ? 'public'
        : classLogins || pattern.startsWith(CLIENT_PORTAL_GONE)
          ? 'self'
          : null));
  // A page's class is its list's (registerPages). A link page is an /s
  // pattern; a render page is one no list classes, so it can never shadow
  // a route the lists know. Nothing else is mounted outside the manifest.
  const pageClass = opts.page ?? null;
  if (pageClass !== null && listed !== (pageClass === 'link' ? 'link' : null)) {
    throw new Error(
      `ROUTE_POLICY: ${key} is a page of class ${pageClass}; the lists class it ${listed ?? 'not at all'}`,
    );
  }
  const cls = pageClass ?? listed;
  // A route no list names is refused here, so a new route is classed
  // before it ships (route-policy.test.ts builds every row).
  if (cls === null) throw new Error(`ROUTE_POLICY: ${key} has no class`);
  const page = pageClass !== null;
  const v1 = v1Route(m, pattern);
  // The pipeline answers a kind's caller only on a row that kind's guard
  // serves (CALLER_LOGINS): the owner guard a session route of the owner
  // (self, content or area), open to Admin or to the owner lists (a
  // member's open reads and writes are the owner guard's too); the member,
  // any-login and chat guards the rows of their own lists (A4 step 3b part
  // 5). A public, link or render row judges its own credential. The owner
  // guard serves only a row its prefix classes (scope); the others read no
  // scope of the row.
  const caller: RouteCaller | null = opts.reads ?? null;
  // A gone row (a retired route's stub) is answered by the guard its stub
  // called, whatever list the row is in now (RouteRow.gone).
  const gone = opts.gone === true;
  if (gone && !caller) throw new Error(`ROUTE_POLICY: ${key} is a gone stub with no caller kind`);
  if (
    caller &&
    (pageClass !== null ||
      isPublic ||
      (caller === 'owner' && scope === null) ||
      (!gone && !CALLER_LOGINS[caller].includes(classLogins)))
  ) {
    throw new Error(
      `ROUTE_POLICY: ${key} reads the ${caller} caller, but the ${caller} guard does not serve its row`,
    );
  }
  // A catch-all route also matches its bare prefix, where the loader may
  // answer 404 before the handler (route-loader.ts): the gate's answer
  // would come first there. Such a route keeps its guard (the hand batch).
  if (caller && pattern.endsWith('*')) {
    throw new Error(`ROUTE_POLICY: ${key} is a catch-all: it keeps its guard (hand batch)`);
  }
  const startsAs =
    pageClass === 'render'
      ? 'http:render'
      : pageClass === 'link'
        ? 'http:share-page'
        : 'http:no-login';
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
    cors: linkCors(pattern),
    renderCookie: m === 'GET' && (cls === 'render' || isRenderAssetPath(path)),
    page,
    caller,
    gone,
    startsAs,
    actor: isPublic && effect === 'write' ? startsAs : null,
  });
}

/** The manifest shape the table is built from: `reads`, each method whose
 *  handler reads the caller the pipeline answers, to the caller kind its
 *  reader reads (RouteRow.caller). */
export type RouteManifestEntry = Readonly<{
  pattern: string;
  methods: readonly string[];
  reads?: Readonly<Record<string, RouteCaller>>;
  /** Each method exported as a retired route's 410 stub (gone rows). */
  gone?: readonly string[];
}>;

/** The methods a manifest entry is called with: its own, and HEAD where
 *  it serves GET (Hono answers HEAD with the GET handler). */
export function servedMethods(entry: RouteManifestEntry): string[] {
  const methods = entry.methods.map((m) => m.toUpperCase());
  return methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods;
}

/** ROUTE_POLICY over a manifest (or, `page`, over a list of pages of
 *  server/pages, all of that class): `METHOD pattern` to its row. */
export function buildRoutePolicy(
  manifest: readonly RouteManifestEntry[],
  opts: { page?: PageClass } = {},
): ReadonlyMap<string, RouteRow> {
  const keys = new Set(manifest.flatMap((e) => servedMethods(e).map((m) => `${m} ${e.pattern}`)));
  const served = (key: string) => keys.has(key);
  const table = new Map<string, RouteRow>();
  for (const entry of manifest) {
    const reads = entry.reads ?? {};
    const gone = new Set(entry.gone ?? []);
    for (const m of servedMethods(entry)) {
      // HEAD is answered by the GET handler: it reads what GET reads.
      const as = m === 'HEAD' && !entry.methods.includes('HEAD') ? 'GET' : m;
      const read = reads[as] ?? null;
      const row = buildRouteRow(m, entry.pattern, served, {
        ...opts,
        reads: read,
        gone: gone.has(as),
      });
      table.set(row.key, row);
    }
  }
  return table;
}

const spelledRe = new Map<string, RegExp>();

/**
 * The spelling matcher of `pattern` (spellsPattern), compiled once: each
 * static segment literally, a param as one segment, a trailing `*` as the
 * rest. It throws on a pattern it cannot spell (an optional param). The
 * rows of a pattern compile it when they are built (buildRouteRow), and
 * the route loader compiles every pattern it registers (registerRoutes,
 * registerPages), so such a pattern fails at boot, never on a request.
 */
export function compileSpelling(pattern: string): RegExp {
  let re = spelledRe.get(pattern);
  if (!re) {
    const star = pattern.endsWith('/*');
    const segs = (star ? pattern.slice(0, -2) : pattern).split('/');
    const body = segs
      .map((seg) => {
        if (/^:[A-Za-z0-9_]+\?$/.test(seg)) {
          throw new Error(`spellsPattern: an optional param is not spelled here (${pattern})`);
        }
        return /^:[A-Za-z0-9_]+$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    re = new RegExp(`^${body}${star ? '(?:/.*)?' : ''}$`);
    spelledRe.set(pattern, re);
  }
  return re;
}

/**
 * Whether `path`, as the request sent it, spells `pattern`
 * (compileSpelling). The router matches the path with its percent-escapes
 * decoded; the gate's credential checks always read it as sent. A request
 * whose path spells a static segment with escapes (`/s/x/%76iew`) is
 * routed, but the gate answers it by the path checks, as before (arch A4
 * step 2), and a key is not in the API there (requestKeyRoute). The one
 * place that answers whether the raw path spells a row's pattern.
 */
export function spellsPattern(pattern: string, path: string): boolean {
  return compileSpelling(pattern).test(path);
}

// ── The gate's route source and the stored row ──────────────────────────────

/** A row's declared policy (the gate's step 3). The Admin step names the
 *  row's area. The gate refuses with it on a row whose handler reads the
 *  pipeline's caller (A4 step 3b part 4: the HTTP caller carries an Admin
 *  login's view of the area); elsewhere the HTTP caller is unscoped
 *  (`admin: null`) and the session guard decides from the Admin view the
 *  gate resolved (adminRouteGate), as before. A public row that writes
 *  names the actor it runs as. */
export function routeGatePolicy(row: RouteRow): GatePolicy {
  return Object.freeze({
    effect: row.effect,
    ...(row.actor ? { actor: systemActor(row.actor) } : {}),
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

/**
 * What an API key is held to on a request: the row's (rowKeyRoute), where
 * the RAW path spells the row's pattern (spellsPattern), else null (not in
 * the API: the 404). Hono decodes the path before routing, so an encoded
 * spelling (`/api/v1/%73earch`) finds the search row; before A4 a key was
 * judged on the raw path, where such a spelling names no v1 route, and
 * that answer stays. The raw path only filters the row: it never picks
 * another (docs/actors.md, "the routed row is the request's only row").
 * The gate (gateAccessKey) and the login lookup (findKeyLogin) both ask
 * this, through keyOnRow.
 */
export function requestKeyRoute(row: RouteRow | null, rawPath: string): KeyRoute | null {
  return row && spellsPattern(row.pattern, rawPath) ? rowKeyRoute(row) : null;
}

/**
 * The one judgment of an API key on a request's row (arch A4 step 3a):
 * keyMayCall on what the row holds a key to where the raw path spells its
 * pattern (requestKeyRoute). The gate (gateAccessKey) answers its refusal;
 * the login lookup (session.ts findKeyLogin) lets a key's login in only
 * where it passes. A row off the key table, or a path that is not its
 * spelling, is not in the API ('not-in-api'), and so is every path off
 * /api/v1 (only /api/v1 rows are on the table).
 */
export function keyOnRow(
  grant: Pick<AccessKeyGrant, 'access' | 'areas'>,
  row: RouteRow | null,
  rawPath: string,
): ReturnType<typeof keyMayCall> {
  return keyMayCall(grant, requestKeyRoute(row, rawPath));
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
