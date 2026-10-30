/**
 * ROUTE_POLICY: one row per
 * route of the manifest and method, the one place the HTTP pipeline reads
 * what a route is. The route loader builds the rows once, when it
 * registers a route; the gate middleware finds the row of a request once,
 * sets it on the request context and hands it to enterCall (@mantle/db
 * gate.ts). Every session guard and the API key checks (the gate's
 * gateAccessKey, the login lookup's findKeyLogin, both through keyOnRow)
 * read the row (currentRoute()).
 *
 * A row's policy is its route file's declaration (`policy = routePolicy({
 * ... })`, route-declaration.ts): its class, area, who it
 * opens to, an effect exception, what it creates, the item a write names,
 * its own audit, the named caller it reads, its key area on /api/v1, its
 * limits and an /api/v1 alias's base, read into the manifest by the
 * generator and checked at boot (declaredFacts). The rows are held to
 * __snapshots__/route-policy.rows.json.
 *
 * The pages of server/pages (the /s page, class 'link'; the render
 * surfaces, class 'render') have no route file: the loader registers them
 * with their rows (registerPages, pageFacts), so they run through enterCall
 * too. The gate reads a routed request's credential answers from its row
 * (gateRouteView in the gate middleware): `public`, the /s brokers' CORS
 * (`cors`) and the render cookie (`renderCookie`). What stays a list, each
 * for a request a row does not answer alone: PUBLIC_PATHS (the gate's
 * answer for a path no row answers, auth-constants.ts), the asset paths
 * (isAssetPath, isRenderAssetPath, ASSET_V1_PATTERNS: the gate reads them
 * on the raw path too), LINK_CORS_PATTERNS (a preflight has no row) and
 * the page lists.
 */
import type { WorkspaceArea } from '@mantle/client-types';
import { TELEGRAM_POLICY_OFF_MESSAGE, env, feature, telegramAllowed } from '@mantle/config';
import { registerPolicySource, systemActor, type GatePolicy, type PolicyRef } from '@mantle/db';
import type { AccessKeyArea, AccessKeyGrant } from '../access-keys';
import { keyMayCall, type KeyRoute } from '../api-v1';
import { RATE_LIMITS, isRateLimitName, type RateLimitName, type RouteGates } from '../route-limits';
import type { RouteSwitch } from './route-switches';
import {
  ALIAS_COPIES,
  ALIAS_OWN,
  DECLARED_KEYS,
  isDeclaredMethod,
  methodEffect,
  splitRouteKey,
  validateMethodPolicy,
  validateRoutePolicy,
  type MethodPolicy,
  type NamedCaller,
  type RoutePolicyDeclaration,
} from './route-declaration';
import { getRequestContext } from '../../server/request-context';
import { isAssetPath, isPublicPath, isRenderAssetPath } from '../auth-constants';
import { auditsAsWrite, type RouteClass } from './route-scope';

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
 * surfaces with no CORS headers at all.
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

/** The class of a route. */
export type RoutePolicyClass = 'public' | 'link' | 'render' | 'self' | 'area' | 'content';

/** Whom a route opens to beyond Admin (a declaration's `open`): the owner
 *  routes a non-Admin login may call in its scope ('owner'), the any-login
 *  routes, the chat routes, the Telegram pairing routes, the member
 *  routes. */
export type RouteLogins = 'owner' | 'any' | 'chat' | 'telegram' | 'member';

/** Whose answer the pipeline gives before a handler (RouteRow.caller): the
 *  guard of that kind, run once by the gate (session.ts answerRouteCaller).
 *  'owner': the owner guard's (getOwnerOr401WithLogin), on the owner rows;
 *  'member': the member guard's (getMemberOr401), on the member list;
 *  'login': the any-login guard's (getLoginOr401), on the any-login list;
 *  'chat': the chat guard's (getChatLoginOr401), on the chat and Telegram
 *  lists; 'session': the session user's (getSessionUser: any Admin user,
 *  or null, never a refusal), on the rows open to every Admin user (a
 *  declared `caller: 'session'`).
 *
 *  And the kinds each read only on rows named for them:
 *  - the asset answers, on the byte routes a browser-native src opens
 *    (a `?at=` asset token, the render cookie): 'ownerAsset'
 *    (getOwnerForAsset) and 'readerAsset' (getReaderForAsset) on owner rows,
 *    and 'loginAsset' (getLoginForAsset: any login, by its session or its
 *    own `?at=` token) on the any-login photo rows;
 *  - 'frame': the `?t=` frame ticket of a sandbox frame document, verified
 *    (a declared `caller: 'frame'`), no login and never a refusal;
 *  - the answers taken at the read (ANSWERED_AT_READ): the gate binds the
 *    kind's answer and the handler's first read runs it, once, so what the
 *    handler does first (a public
 *    row's own checks, an /api/v1 key rule) still comes first: 'publicLogin'
 *    (getLoginOr401) and 'cookieUpgrade' (getCookieUpgradeLoginOr401) on a
 *    public row that reads the login, which never refuse (a public row
 *    judges its own credential: no login reads as null), and 'ownerAtRead'
 *    (the owner guard) on an owner row whose handler runs a key's checks
 *    before it, whose refusal the gate answers at the read. */
export type RouteCaller =
  | 'owner'
  | 'member'
  | 'login'
  | 'chat'
  | 'session'
  | 'ownerAsset'
  | 'readerAsset'
  | 'loginAsset'
  | 'frame'
  | 'publicLogin'
  | 'cookieUpgrade'
  | 'ownerAtRead';

/** The caller kinds whose answer the gate binds and the handler's first
 *  read runs: the handler runs code that answers before
 *  it reads (a public row's checks, an /api/v1 key rule), and that order
 *  stays. Every other kind is answered before the handler. */
export const ANSWERED_AT_READ: ReadonlySet<RouteCaller> = new Set([
  'publicLogin',
  'cookieUpgrade',
  'ownerAtRead',
]);

/**
 * The caller kinds the gate's step 5 (the Admin step) answers an area row
 * for (the area check is the gate's, not a guard's): the owner
 * guard and its asset form, each with the Admin view of the row's area of
 * the login it answers as (session.ts resolveHttpLogin; on an asset row
 * the login an `?at=` token or the render cookie names). An area row that
 * is not public reads one of them, or the boot refuses it (buildRouteRow):
 * no area row is left to a guard's own check.
 */
export const ADMIN_STEP_CALLERS: ReadonlySet<RouteCaller> = new Set(['owner', 'ownerAsset']);

/** The kinds a public row may read (and no other row): the login a public
 *  row reads judging its own credential, never refused at the gate. */
const PUBLIC_CALLERS: ReadonlySet<RouteCaller> = new Set(['publicLogin', 'cookieUpgrade']);

/** The kinds answered by the owner guard or its asset forms: they serve an
 *  owner row only where its prefix classes it (a scope). */
const OWNER_GUARDED: ReadonlySet<RouteCaller> = new Set([
  'owner',
  'ownerAsset',
  'readerAsset',
  'ownerAtRead',
]);

/** The login lists whose rows each caller kind's guard serves (null: the
 *  owner rows open to Admin only). The owner guard serves the owner rows
 *  and the members' open reads and writes of them; each other guard its
 *  own list. */
const CALLER_LOGINS: Readonly<Record<RouteCaller, ReadonlyArray<RouteLogins | null>>> = {
  owner: [null, 'owner'],
  member: ['member'],
  login: ['any'],
  chat: ['chat', 'telegram'],
  // The session user's guard serves only the named carve-outs open to
  // every Admin user (a declared `caller: 'session'`, callerServes).
  session: [],
  // The asset guards serve the owner rows a byte src opens (an Admin user,
  // and a member on the reads open to it: getReaderForAsset).
  ownerAsset: [null, 'owner'],
  readerAsset: [null, 'owner'],
  // Any login's byte src on an any-login row (a person's photo).
  loginAsset: ['any'],
  // The frame documents (a declared `caller: 'frame'`, callerServes).
  frame: [],
  // Public rows only (PUBLIC_CALLERS, checked in buildRouteRow).
  publicLogin: [],
  cookieUpgrade: [],
  ownerAtRead: [null, 'owner'],
};

/** The asset caller kinds: answered from a `?at=` asset token or the render
 *  cookie as well as a login, read only on an asset row (assetRow). */
const ASSET_CALLERS: ReadonlySet<RouteCaller> = new Set([
  'ownerAsset',
  'readerAsset',
  'loginAsset',
]);

/** The /api/v1 rows that run an asset row's handler: the alias of the file
 *  bytes and the download wrapper. */
const ASSET_V1_PATTERNS: ReadonlySet<string> = new Set([
  '/api/v1/files/:id',
  '/api/v1/files/:id/download',
]);

/** Whether a row is an asset row: a GET,
 *  or a HEAD, of a byte route the gate takes an asset token on
 *  (isAssetPath, auth-constants.ts), or an /api/v1 row that runs one
 *  (ASSET_V1_PATTERNS). An asset caller is read nowhere else, so a token
 *  minted for a byte src can never answer a write or another read. */
function assetRow(method: string, pattern: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return isAssetPath(path) || ASSET_V1_PATTERNS.has(pattern);
}

/**
 * The query GET /api/v1/files/:id/download hands the bytes handler of
 * /api/files/files/:id: `?raw=1` and nothing else. Its route file sets it
 * from here, and the gate answers the asset reader from it
 * (ASSET_QUERY_AS_HANDED): one source, so the two cannot drift (the
 * route's own test drives it).
 */
export const V1_DOWNLOAD_QUERY = '?raw=1';

/**
 * The asset rows whose handler is handed a request with another query than
 * the one sent: each to the query its route file sets, read from the same
 * constant. GET /api/v1/files/:id/download runs the bytes handler of
 * /api/files/files/:id with V1_DOWNLOAD_QUERY alone, so a `?at=` sent to it
 * never reaches the handler. The gate answers the asset caller from the
 * request as the handler is handed it, so the gate and the handler agree.
 */
export const ASSET_QUERY_AS_HANDED: ReadonlyMap<string, string> = new Map([
  ['GET /api/v1/files/:id/download', V1_DOWNLOAD_QUERY],
]);

/** The query an asset row's handler is handed in place of the one sent
 *  (ASSET_QUERY_AS_HANDED; a HEAD the GET handler answers takes its GET's),
 *  or null: the request as sent. */
export function assetQueryAsHanded(row: Pick<RouteRow, 'method' | 'pattern'>): string | null {
  const m = row.method === 'HEAD' ? 'GET' : row.method;
  return ASSET_QUERY_AS_HANDED.get(`${m} ${row.pattern}`) ?? null;
}

/** One ROUTE_POLICY row: one method of one manifest pattern. */
export type RouteRow = Readonly<{
  /** `METHOD pattern`, the pattern as the manifest writes it. */
  key: string;
  method: string;
  pattern: string;
  /** The class: what the route serves. A link route (/s) and a
   *  public one name no login; the others are the scope's. */
  class: RoutePolicyClass;
  /** What the owner session guard does with the route (its class): reads
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
  /** The write logs its own audit event: the session guards' generic
   *  `api.write` row is not written for it (session.ts auditMutation reads
   *  this). 'own' only where the declaration says `audit: 'own'` and the
   *  row audits as a write (route-scope.ts auditsAsWrite); null
   *  elsewhere. */
  audit: 'own' | null;
  /** The area an API key needs (an /api/v1 row of the key table): null
   *  for a route open only to a key with every area, or about the key
   *  itself (keySelf); absent off the key table. */
  keyArea?: AccessKeyArea | null;
  /** An /api/v1 row about the key itself (whoami, its declaration's `keyArea: 'self'`):
   *  every key may call it, whatever its areas. Absent off the key table. */
  keySelf?: boolean;
  /** A v1 row: the route whose handler it re-exports. */
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
  /** Whose answer the pipeline gives before the handler:
   *  the guard of that kind (RouteCaller), run once by the gate from this
   *  row (session.ts answerRouteCaller) and refused with there; the handler
   *  reads it (ownerCaller(), memberCaller(), anyLoginCaller(),
   *  chatCaller()) and calls no guard. Set where the route file's
   *  handler for the method reads it (the manifest's `reads`, from the
   *  code: scripts/route-callers.ts); a HEAD row has its GET's. Null: the
   *  handler's own guard answers. */
  caller: RouteCaller | null;
  /** A retired route's 410 stub (lib/gone.ts `gone(kind)`): its handler
   *  reads the caller of the stub's kind and answers 410. The gate answers
   *  that kind's guard on it, whatever list the row is in (the member guard
   *  on a retired member route no member list names, the any-login guard on
   *  the client portal's). The answer is the guard's own function; the
   *  any-login answer writes no audit row on a stub (getLoginOr401 without
   *  `audit`). */
  gone: boolean;
  /** What a login the box password rule holds still reaches here (its
   *  declaration's `passwordHold`, password-hold.ts): null, nothing. */
  passwordHold: 'change-step' | 'sign-out' | null;
  /** The switch the route is served under, as its route file declares it
   *  (`routeSwitches`, route-switches.ts): while it is off
   *  the gate answers the route's own off answer before the login's
   *  (routeSwitchedOff). Null: always served. */
  switch: RouteSwitch | null;
  /** The login-CSRF refusal the gate answers before the row's limits and
   *  its handler (refuseCrossSiteAuthPost; its declaration's `limits`): a
   *  public auth post that sets or uses the session cookie. Null: none. */
  crossSite: 'json' | 'origin' | null;
  /** The row's rate limits, by name (route-limits.ts RATE_LIMITS),
   *  taken by the gate once the caller is answered, or, on a public row
   *  that reads its login at the read, a login's limit when the handler
   *  reads it. Answered with the one 429 (rateLimitedResponse). Empty:
   *  none. */
  rateLimit: readonly RateLimitName[];
  /** The system reason a public route that writes runs as (signup, invite
   *  accept, sign in, the token routes, OAuth, the /s brokers), null on
   *  every other row (it runs as its caller): the named actor such a route
   *  runs as until a guard or a share gate names a caller, in place of the
   *  request slot's generic system(http:no-login). The OAuth callbacks of
   *  a connector and the onboarding seed are not public: they run as the
   *  login their guard names. The gate's step 3 binds it (routeGatePolicy)
   *  and the request slot starts as it. */
  actor: string | null;
}>;

/** A concrete path for `pattern`: param `i` is `{p<i>}`, a catch-all
 *  `{rest}`, so the item target's id names the segment it came from. */
function markedPath(pattern: string): string {
  let i = 0;
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, () => `{p${i++}}`).replace(/\*$/, '{rest}');
}

/**
 * The caller kinds whose answer names the login a login limit counts
 * (session.ts answeredLimitLogin): the guards answered before the handler,
 * and the public login read at the read (its limit is taken there).
 */
const LIMIT_LOGIN_CALLERS: ReadonlySet<RouteCaller> = new Set([
  'owner',
  'member',
  'login',
  'chat',
  'readerAsset',
  'loginAsset',
  'publicLogin',
]);

/** The row's gates (its declaration's `limits`, an alias's its base's),
 *  checked against the row. */
function gatesOf(
  key: string,
  gates: RouteGates,
  row: Readonly<{ caller: RouteCaller | null; catchAll: boolean; page: boolean }>,
) {
  const rateLimit = gates.rateLimit ?? [];
  if ((rateLimit.length || gates.crossSite) && (row.catchAll || row.page)) {
    throw new Error(`ROUTE_POLICY: ${key} is a catch-all or a page: the gate checks nothing first`);
  }
  for (const name of rateLimit) {
    if (!isRateLimitName(name)) throw new Error(`ROUTE_POLICY: ${key} takes ${name}, no limit`);
    const spec = RATE_LIMITS[name];
    if (spec.per === 'login' && !(row.caller && LIMIT_LOGIN_CALLERS.has(row.caller))) {
      throw new Error(
        `ROUTE_POLICY: ${key} takes the login limit ${name}, but reads no caller that names a login`,
      );
    }
  }
  return { crossSite: gates.crossSite ?? null, rateLimit: Object.freeze([...rateLimit]) };
}

/** The class of the login's own things (route-scope.ts `self`). */
const SELF_SCOPE: RouteClass = Object.freeze({ kind: 'self' });

/**
 * The switches a route is served under: the switch is answered FIRST, so
 * while it is off every credential that reaches the route gets the route's
 * off answer, whatever its guard would say. The gate answers it
 * (routeSwitchedOff, the gate middleware) before the login's answer and
 * the Admin step, so the handler can read the caller first: a member, a
 * revoked token or an Admin user without the row's area still gets the off
 * answer while the switch is off. Each to its check and its off answer, the
 * handler's words.
 *
 * A route declares its switch in its own file (`routeSwitches`,
 * route-switches.ts), read into the manifest by the generator, so the
 * declaration moves with the handler; buildRoutePolicy refuses one that
 * names a method the route does not serve, or no switch here.
 */
export type { RouteSwitch } from './route-switches';
const SWITCHES: Readonly<
  Record<
    RouteSwitch,
    Readonly<{ on: () => boolean; status: 403 | 404; error: string; code?: string }>
  >
> = {
  // MANTLE_TURN_STREAMING (on unless set off): the streamed turn's stream
  // and its cancel do not exist while it is off.
  'turn-streaming': { on: () => feature('turnStreaming'), status: 404, error: 'not found' },
  // A dev tool: never in production.
  'not-production': {
    on: () => env('NODE_ENV') !== 'production',
    status: 404,
    error: 'not available in production',
  },
  // The box policy switches Telegram off (MANTLE_POLICY_TELEGRAM=off,
  // docs/policy.md): every Telegram settings route says so, for every
  // credential. Nothing is removed while it is off (DELETE included).
  'telegram-policy': {
    on: telegramAllowed,
    status: 403,
    error: TELEGRAM_POLICY_OFF_MESSAGE,
    code: 'policy_telegram_off',
  },
};

/** The off answer of a row whose switch is off now, else null. */
export function routeSwitchedOff(
  row: Pick<RouteRow, 'switch'>,
): Readonly<{ status: number; body: { error: string; code?: string } }> | null {
  if (!row.switch) return null;
  const s = SWITCHES[row.switch];
  if (s.on()) return null;
  return { status: s.status, body: s.code ? { error: s.error, code: s.code } : { error: s.error } };
}

/**
 * Whether the guard of `caller` serves a row (buildRouteRow): a public row
 * reads only a public kind and no other row does, each kind only on the
 * public rows that declare it (`caller`); an asset kind only an asset row
 * (assetRow: a GET or HEAD of a byte route); the owner taken at the read
 * only the rows that declare it; a gone row takes its stub's kind whoever
 * it opens to; the session user's guard serves the rows that declare it
 * (the carve-outs open to every Admin user), the frame answer the frame
 * documents (`caller: 'frame'`); the owner guard and its asset and at-read
 * forms a row with a scope, the at-read form none that manages an Admin
 * area (the gate's Admin step comes before the handler); every other kind
 * the rows it opens to (CALLER_LOGINS). The asset and at-read kinds are
 * each read on rows named for them, as the frame answer and the session
 * user's are: a class of rows is never enough.
 */
function callerServes(
  caller: RouteCaller,
  row: Readonly<{
    key: string;
    pattern: string;
    isPublic: boolean;
    asset: boolean;
    scope: RouteClass | null;
    classLogins: RouteLogins | null;
    gone: boolean;
    /** Whether the row is named for `kind` (a kind of NAMED_CALLERS): its
     *  list's entry (listNamed), or its declaration's `caller`. */
    named: (kind: NamedCaller) => boolean;
  }>,
): boolean {
  if (PUBLIC_CALLERS.has(caller)) {
    return row.isPublic && !row.gone && row.named(caller as NamedCaller);
  }
  if (row.isPublic) return false;
  if (ASSET_CALLERS.has(caller) && !row.asset) return false;
  if (caller === 'ownerAtRead' && !row.named('ownerAtRead')) return false;
  if (OWNER_GUARDED.has(caller) && row.scope === null) return false;
  if (caller === 'ownerAtRead' && row.scope?.kind === 'area') return false;
  if (caller === 'session') return row.named('session');
  if (caller === 'frame') return row.named('frame');
  return row.gone || CALLER_LOGINS[caller].includes(row.classLogins);
}

/**
 * Whether the gate finds no login for `row` (session.ts resolveHttpLogin):
 * a sandbox frame document's row, whose caller is the frame ticket and
 * whose handler reads no login: its declaration's `caller: 'frame'`
 * (callerServes holds the declared and the read kind to one).
 */
export function findsNoLogin(row: Pick<RouteRow, 'caller'>): boolean {
  return row.caller === 'frame';
}

/** What a row's policy says, from its declaration (a page's: pageFacts);
 *  the rest of the row (its caller, switch, gone stub, page) comes from the
 *  manifest. */
type RowFacts = Readonly<{
  scope: RouteClass | null;
  /** The class before a page's own (buildRouteRow), null where none. */
  listed: RoutePolicyClass | null;
  isPublic: boolean;
  logins: RouteLogins | null;
  effect: 'read' | 'write';
  creates: boolean;
  makesItems: boolean;
  key: Readonly<{ keyArea: AccessKeyArea | null; keySelf: boolean }> | null;
  alias: string | null;
  gates: RouteGates;
  audit: 'own' | null;
  passwordHold: 'change-step' | 'sign-out' | null;
  /** Whether the row is named for a caller kind (callerServes). */
  named: (kind: NamedCaller) => boolean;
  /** The named caller kind a declaration states (`caller`), read from
   *  its checked copy; null on a page, which states none. */
  declaredCaller: NamedCaller | null;
}>;

/**
 * The facts of a page's row (server/pages: no route file, so no
 * declaration): a page names no login list, no item, no key area, no limit and
 * no audit of its own; it is public where the gate lets its path in with
 * no credential (PUBLIC_PATHS: the /s page), and a page under /s is a link
 * row. A render page is classed by its list alone (buildRouteRow).
 */
function pageFacts(m: string, pattern: string, path: string): RowFacts {
  return {
    scope: null,
    listed: pattern.startsWith('/s/') ? 'link' : null,
    isPublic: isPublicPath(path),
    logins: null,
    effect: methodEffect(m),
    creates: false,
    makesItems: m !== 'DELETE',
    key: null,
    alias: null,
    gates: {},
    audit: null,
    passwordHold: null,
    named: () => false,
    declaredCaller: null,
  };
}

/** The effect a declaration gives `method`: the method's own
 *  (methodEffect), or the exception it states (`effect: { read }` on a
 *  POST, `{ write }` on a GET or HEAD). The one reading of it: a row's and
 *  an alias's base's alike. */
function declaredEffect(p: MethodPolicy, method: string): 'read' | 'write' {
  if (!p.effect) return methodEffect(method);
  return Object.hasOwn(p.effect, 'read') ? 'read' : 'write';
}

/**
 * The facts of a row from its route file's declaration, the
 * declaration of the method whose handler answers (`answeredAs`: a HEAD the
 * GET handler answers takes its GET's). Every value is checked here, at
 * boot (validateMethodPolicy, the generator's check too, and what needs the
 * manifest: an alias's base is served and declared): a declaration that
 * cannot hold is refused, never read as a pass. `declaredOf` finds the
 * declaration of another row (`METHOD pattern`), for an alias's base.
 */
function declaredFacts(
  m: string,
  answeredAs: string,
  pattern: string,
  served: (key: string) => boolean,
  raw: MethodPolicy,
  declaredOf: (key: string) => MethodPolicy | undefined,
): RowFacts {
  const key = `${m} ${pattern}`;
  const bad = (what: string): never => {
    throw new Error(`ROUTE_POLICY: ${key} declares ${what}`);
  };
  const d = validateMethodPolicy(raw, pattern, answeredAs);
  const own = (k: string) => Object.hasOwn(d, k);
  const scope: RouteClass | null =
    d.class === 'area'
      ? { kind: 'area', area: d.area }
      : d.class === 'content'
        ? { kind: 'content' }
        : d.class === 'self' && !own('scope')
          ? SELF_SCOPE
          : null;
  // The effect is the method's, or the exception the declaration states.
  const effect = declaredEffect(d, m);
  // An alias (its base's handler) or a v1 row with a base: open, creates
  // and, for an alias, limits are the base's declaration's, one source.
  const baseKey = d.aliasOf ?? d.base;
  let base: MethodPolicy | null = null;
  if (baseKey !== undefined) {
    const b = splitRouteKey(baseKey)!;
    if (!served(`${m} ${b.pattern}`))
      bad(`${baseKey} as its base, which the manifest does not serve`);
    // (An alias's base is the route its file re-exports: the generator
    // checks it, route-callers.ts aliasMismatches. A `base` is the one
    // source of a v1 row's base.)
    // The base's values are read from its own checked copy, as the row's.
    base = validateMethodPolicy(
      declaredOf(baseKey) ?? bad(`${baseKey} as its base, which declares no policy`),
      b.pattern,
      b.method,
    );
    // An alias runs its base's handler, so it is the base's row in every
    // key its base declares: each key of the shape but the alias's own
    // (ALIAS_OWN: its base, its key area) and the ones read from the base
    // (ALIAS_COPIES: open, creates, limits, which it may not declare) says
    // what the base's says, or the declaration is refused. The effect is
    // compared as the row's (the method's, or the stated exception), the
    // item as its param and need or its `none` reason.
    if (d.aliasOf !== undefined) {
      const baseEffect = declaredEffect(base, b.method);
      const shown = (v: unknown): string =>
        v === undefined ? 'none declared' : typeof v === 'string' ? v : JSON.stringify(v);
      const itemOf = (p: MethodPolicy) =>
        p.item === undefined
          ? 'none declared'
          : p.item.none !== undefined
            ? `none: ${p.item.none}${p.item.param === undefined ? '' : ` (${p.item.param})`}`
            : `${p.item.param} ${p.item.need}`;
      const field = (p: MethodPolicy, k: string): unknown =>
        Object.hasOwn(p, k) ? (p as Readonly<Record<string, unknown>>)[k] : undefined;
      const notHeld: readonly string[] = [...ALIAS_OWN, ...ALIAS_COPIES];
      for (const what of DECLARED_KEYS) {
        if (notHeld.includes(what)) continue;
        const [mine, theirs] =
          what === 'effect'
            ? [effect, baseEffect]
            : what === 'item'
              ? [itemOf(d), itemOf(base)]
              : [shown(field(d, what)), shown(field(base, what))];
        if (mine !== theirs) {
          bad(`the ${what} ${mine} on an alias of ${baseKey}, whose ${what} is ${theirs}`);
        }
      }
    }
  }
  const from = base ?? d;
  // A v1 row admits a login as its base does: the owner lists only.
  const logins: RouteLogins | null = base
    ? base.open === 'owner'
      ? 'owner'
      : null
    : (d.open ?? null);
  // A row a member opens is a content row, whichever way it got the opening:
  // its own `open` (the validator refuses that) or a v1 base's (here).
  if (logins === 'owner' && d.class !== 'content') {
    bad(`open to members through its base, on a ${d.class} row`);
  }
  // A 'self' row no owner guard serves is a row of a login list.
  if (d.class === 'self' && scope === null && !logins) bad('scope null on a row no list opens');
  const ownMethod = m === answeredAs;
  // The item a write declares (`item: { param, need }`) states intent only,
  // as a tool's matrix declaration does: the right the handler asks of the
  // item in the database, in the login's scope. The row holds none: no
  // route has an item pre-check, and a declaration does not bring one
  // back. The A8 route cells (server/web/server/test-support/a8-route-cells.ts) are
  // generated from it.
  // The key area an API key needs (an /api/v1 row only: the validator): the
  // one source. A v1 row that declares none is not in the API (keyOnRow:
  // 'not-in-api').
  const keyArea = d.keyArea;
  return {
    scope,
    listed: d.class,
    isPublic:
      d.class === 'public' ||
      d.class === 'link' ||
      (d as Readonly<{ public?: true }>).public === true,
    logins,
    effect,
    // A HEAD the GET handler answers creates nothing and makes what a read
    // makes: the method's own declaration says it, never its GET's.
    creates: ownMethod && from.creates === true,
    makesItems: !(m === 'DELETE' || (ownMethod && d.makesItems === false)),
    key:
      keyArea === undefined
        ? null
        : { keyArea: keyArea === 'self' ? null : keyArea, keySelf: keyArea === 'self' },
    alias: d.aliasOf !== undefined ? `${m} ${splitRouteKey(d.aliasOf)!.pattern}` : null,
    gates: (d.aliasOf !== undefined ? base!.limits : d.limits) ?? {},
    // Only where the row audits as a write (a HEAD the GET handler answers:
    // where that GET writes).
    audit: d.audit === 'own' && auditsAsWrite(m, effect) ? 'own' : null,
    passwordHold: d.passwordHold ?? null,
    named: (kind) => d.caller === kind,
    declaredCaller: d.caller ?? null,
  };
}

/**
 * The row of `method pattern`, from the route file's declaration for the
 * method (`declared`), or a page's (`page`, pageFacts). `served` says which `METHOD pattern` keys the
 * manifest serves (the v1 aliases).
 */
export function buildRouteRow(
  method: string,
  pattern: string,
  served: (key: string) => boolean = () => false,
  opts: {
    page?: PageClass;
    reads?: RouteCaller | null;
    gone?: boolean;
    /** The switch the route file declares for the method (a HEAD the GET
     *  handler answers: its GET's). */
    switch?: RouteSwitch | null;
    /** The route exports its own HEAD: a HEAD row is that handler's, not
     *  its GET's (buildRoutePolicy says so from the manifest; a HEAD the
     *  GET handler answers otherwise, as Hono answers it). */
    ownHead?: boolean;
    /** A test's stand-in routes, whose handlers call the guards
     *  themselves (the parity tests of the gate): a row that reads no
     *  caller is let through. Never the app's manifest: only a test file
     *  passes it (arch-lints.test.ts pins it). */
    standIn?: boolean;
    /** The route file's declaration for the method whose handler answers
     *  (a HEAD the GET handler answers: its GET's): the row's policy is
     *  read from it. Required but on a page (a row has no other source). */
    declared?: MethodPolicy;
    /** The declaration of another row (`METHOD pattern`; a HEAD the GET
     *  handler answers: its GET's), for a declared alias's base. */
    declaredOf?: (key: string) => MethodPolicy | undefined;
  } = {},
): RouteRow {
  const m = method.toUpperCase();
  const key = `${m} ${pattern}`;
  // The gate's spelling test of the pattern, compiled here so a pattern it
  // cannot spell fails when the rows are built (at boot).
  compileSpelling(pattern);
  // HEAD is answered by the GET handler, so it has GET's class and GET's
  // logins (an owner decision): a login outside Admin that may GET a row
  // may HEAD it, under the same rule (the any-login, chat and Telegram
  // rows: its own scope, not the system pool). Only where the GET handler answers it: a route that
  // exports its own HEAD (`ownHead`) has its own handler, and its HEAD row
  // is that method's declaration's.
  const answeredAs = m === 'HEAD' && !opts.ownHead ? 'GET' : m;
  const path = markedPath(pattern);
  let facts: RowFacts;
  if (opts.page) facts = pageFacts(m, pattern, path);
  else if (opts.declared) {
    facts = declaredFacts(
      m,
      answeredAs,
      pattern,
      served,
      opts.declared,
      opts.declaredOf ?? (() => undefined),
    );
  } else throw new Error(`ROUTE_POLICY: ${key} declares no policy for ${answeredAs}`);
  const { scope, listed, isPublic, logins, effect } = facts;
  const classLogins = logins;
  // A page's class is its list's (registerPages). A link page is an /s
  // pattern; a render page is off /s and off /api, so it can never shadow a
  // route a declaration classes. Nothing else is mounted outside the
  // manifest.
  const pageClass = opts.page ?? null;
  if (
    pageClass !== null &&
    (listed !== (pageClass === 'link' ? 'link' : null) ||
      (pageClass === 'render' && (pattern === '/api' || pattern.startsWith('/api/'))))
  ) {
    throw new Error(
      `ROUTE_POLICY: ${key} is a page of class ${pageClass}; its pattern is ${listed === 'link' ? 'a link route' : 'not one'}`,
    );
  }
  const cls = pageClass ?? listed;
  // A row with no class is refused here (a declaration always states one;
  // a render page takes its list's).
  if (cls === null) throw new Error(`ROUTE_POLICY: ${key} has no class`);
  const page = pageClass !== null;
  // The pipeline answers a kind's caller only on a row that kind's guard
  // serves (CALLER_LOGINS): the owner guard a session route of the owner
  // (self, content or area), open to Admin or to the owner lists (a
  // member's open reads and writes are the owner guard's too); the member,
  // any-login and chat guards the rows of their own lists. A link or render
  // row judges its own credential, and so does a public row, which reads at
  // most the login its own checks ask for at the read (callerServes). The
  // owner guard serves only a row
  // its prefix classes (scope); the others read no scope of the row.
  const caller: RouteCaller | null = opts.reads ?? null;
  // A gone row (a retired route's stub) is answered by the guard its stub
  // called, whatever list the row is in now (RouteRow.gone).
  const gone = opts.gone === true;
  if (gone && !caller) throw new Error(`ROUTE_POLICY: ${key} is a gone stub with no caller kind`);
  // A declared named caller is the one the code reads (the generator's
  // caller facts), both ways: callerServes refuses a named kind the row
  // does not declare, and this a declared kind its handler does not read.
  // Read from the checked copy (declaredFacts), never the module's value.
  if (facts.declaredCaller !== null && facts.declaredCaller !== caller) {
    throw new Error(
      `ROUTE_POLICY: ${key} declares the caller ${facts.declaredCaller}, but its handler reads ${caller ?? 'none'}`,
    );
  }
  const routeSwitch = opts.switch ?? null;
  if (routeSwitch !== null && !Object.hasOwn(SWITCHES, routeSwitch)) {
    throw new Error(`ROUTE_POLICY: ${key} is served under ${routeSwitch}, which is no switch`);
  }
  if (
    caller &&
    (pageClass !== null ||
      !callerServes(caller, {
        key: `${answeredAs} ${pattern}`,
        pattern,
        isPublic,
        asset: assetRow(answeredAs, pattern, path),
        scope,
        classLogins,
        gone,
        named: facts.named,
      }))
  ) {
    throw new Error(
      `ROUTE_POLICY: ${key} reads the ${caller} caller, but the ${caller} guard does not serve its row`,
    );
  }
  // Every row that is not public and not a page reads the caller the gate
  // answers. A handler that reads
  // nothing would run behind the gate's signature check alone, with no
  // login's answer: a new method of a route file that reads none is refused
  // here, at boot, whatever else its file reads. A public row judges its own
  // credential, a page (link, render) too.
  if (!caller && !isPublic && pageClass === null && opts.standIn !== true) {
    throw new Error(
      `ROUTE_POLICY: ${key} reads no caller: a row that is not public reads the caller the gate answers (A4 exit)`,
    );
  }
  // Every area row's caller is answered by the gate's Admin step: its kind
  // is one step 5 holds the area for (ADMIN_STEP_CALLERS). A
  // public row asks no area; a test's stand-in rows call the guards
  // themselves.
  if (
    scope?.kind === 'area' &&
    !isPublic &&
    opts.standIn !== true &&
    !(caller && ADMIN_STEP_CALLERS.has(caller))
  ) {
    throw new Error(
      `ROUTE_POLICY: ${key} manages the ${scope.area} area but reads the ${caller ?? 'no'} caller: the gate's Admin step answers only ${[...ADMIN_STEP_CALLERS].join(', ')}`,
    );
  }
  // A catch-all route also matches its bare prefix, where the loader may
  // answer 404 before the handler (route-loader.ts): the gate's answer
  // would come first there. Such a route keeps its guard.
  if (caller && pattern.endsWith('*')) {
    throw new Error(`ROUTE_POLICY: ${key} is a catch-all: it keeps its guard (hand batch)`);
  }
  const alias = facts.alias;
  // A test's stand-in rows (their handlers call the guards themselves)
  // take no limit: none names the login the gate would count.
  const gates =
    opts.standIn === true
      ? { crossSite: null, rateLimit: Object.freeze([]) }
      : gatesOf(`${answeredAs} ${pattern}`, facts.gates, {
          caller,
          catchAll: pattern.endsWith('*'),
          page,
        });
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
    creates: facts.creates,
    makesItems: facts.makesItems,
    audit: facts.audit,
    ...(facts.key ? { keyArea: facts.key.keyArea, keySelf: facts.key.keySelf } : {}),
    aliasOf: alias,
    cors: linkCors(pattern),
    renderCookie: m === 'GET' && (cls === 'render' || isRenderAssetPath(path)),
    page,
    caller,
    gone,
    passwordHold: facts.passwordHold,
    switch: routeSwitch,
    crossSite: gates.crossSite,
    rateLimit: gates.rateLimit,
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
  /** Each method to the switch its route file declares (`routeSwitches`,
   *  route-switches.ts): its rows' `switch`. */
  switches?: Readonly<Record<string, RouteSwitch>>;
  /** The route file's policy declaration (`policy`, route-declaration.ts;
   *  the route declarations), read from the code by the generator: each method to its policy.
   *  Its rows are built from it where the source is 'declarations'. */
  policy?: RoutePolicyDeclaration;
}>;

/** The methods a manifest entry is called with: its own, and HEAD where
 *  it serves GET (Hono answers HEAD with the GET handler). */
export function servedMethods(entry: RouteManifestEntry): string[] {
  const methods = entry.methods.map((m) => m.toUpperCase());
  return methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods;
}

/** Every route file of the app's manifest declares its policy, one for
 *  each method it exports, and each holds (validateRoutePolicy), whichever
 *  source the rows are read from (lint holds a new file to it,
 *  route-plumbing.mjs route-policy-declared). registerRoutes asks it of
 *  every manifest it registers: the
 *  app's at boot, a test's hand-built one too (server/test-support.ts).
 *  Throws naming each route that does not. */
export function requireRouteDeclarations(manifest: readonly RouteManifestEntry[]): void {
  const missing: string[] = [];
  for (const entry of manifest) {
    const policy = entry.policy as Readonly<Record<string, unknown>> | undefined;
    for (const m of entry.methods) {
      if (policy === undefined || !Object.hasOwn(policy, m)) missing.push(`${m} ${entry.pattern}`);
    }
    if (policy !== undefined) validateRoutePolicy(policy, entry.pattern, entry.methods);
  }
  if (missing.length > 0) {
    throw new Error(`ROUTE_POLICY: a route file declares no policy for ${missing.join(', ')}`);
  }
}

/** ROUTE_POLICY over a manifest (or, `page`, over a list of pages of
 *  server/pages, all of that class): `METHOD pattern` to its row. */
export function buildRoutePolicy(
  manifest: readonly RouteManifestEntry[],
  opts: { page?: PageClass; standIn?: boolean } = {},
): ReadonlyMap<string, RouteRow> {
  const keys = new Set(manifest.flatMap((e) => servedMethods(e).map((m) => `${m} ${e.pattern}`)));
  const served = (key: string) => keys.has(key);
  const table = new Map<string, RouteRow>();
  const rowOpts = opts;
  // A page has no route file, so no declaration: its row is pageFacts'.
  const declared = !opts.page;
  // Each row's declaration by `METHOD pattern` (a HEAD the GET handler
  // answers: its GET's), for an alias's base. Each route's declaration is
  // read once, here, into its checked copy (validateRoutePolicy): every row
  // of the route, its HEAD and an alias of it are built from that one copy,
  // never from the module's value again.
  const byKey = new Map<string, MethodPolicy>();
  const checked = new Map<RouteManifestEntry, RoutePolicyDeclaration>();
  if (declared) {
    for (const entry of manifest) {
      if (entry.policy === undefined) continue;
      const copy = validateRoutePolicy(entry.policy, entry.pattern, entry.methods);
      checked.set(entry, copy);
      for (const [m, p] of Object.entries(copy)) {
        if (p) byKey.set(`${m} ${entry.pattern}`, p as MethodPolicy);
      }
    }
  }
  const declaredOf = (key: string) => byKey.get(key);
  for (const entry of manifest) {
    const reads = entry.reads ?? {};
    const gone = new Set(entry.gone ?? []);
    const switches = entry.switches ?? {};
    // A switch declared for a method the route does not export would guard
    // nothing: refused at boot, as a row with no class is.
    for (const m of Object.keys(switches)) {
      if (!entry.methods.includes(m)) {
        throw new Error(
          `ROUTE_POLICY: ${entry.pattern} declares a switch for ${m}, which it does not serve`,
        );
      }
    }
    // So would a policy for a method it does not export.
    for (const m of Object.keys(entry.policy ?? {})) {
      if (!isDeclaredMethod(m) || !entry.methods.includes(m)) {
        throw new Error(
          `ROUTE_POLICY: ${entry.pattern} declares a policy for ${m}, which it does not serve`,
        );
      }
    }
    for (const m of servedMethods(entry)) {
      // HEAD is answered by the GET handler: it reads what GET reads.
      const as = m === 'HEAD' && !entry.methods.includes('HEAD') ? 'GET' : m;
      const read = reads[as] ?? null;
      // Every method a route file exports declares its policy;
      // one that does not is refused at boot (and by lint,
      // route-plumbing.mjs route-policy-declared).
      const policy = declared
        ? checked.get(entry)?.[as as keyof RoutePolicyDeclaration]
        : undefined;
      if (declared && !policy) {
        throw new Error(`ROUTE_POLICY: ${m} ${entry.pattern} declares no policy for ${as}`);
      }
      const row = buildRouteRow(m, entry.pattern, served, {
        ...rowOpts,
        reads: read,
        gone: gone.has(as),
        switch: switches[as] ?? null,
        ownHead: as === 'HEAD',
        ...(policy ? { declared: policy as MethodPolicy, declaredOf } : {}),
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
 * routed, but the gate answers it by the path checks, and a key is not in
 * the API there (requestKeyRoute). The one
 * place that answers whether the raw path spells a row's pattern.
 */
export function spellsPattern(pattern: string, path: string): boolean {
  return compileSpelling(pattern).test(path);
}

// ── The gate's route source and the stored row ──────────────────────────────

/** A row's declared policy (the gate's step 3). The Admin step names the
 *  row's area. The gate refuses with it on a row whose handler reads the
 *  pipeline's caller (the HTTP caller carries an Admin login's view of the
 *  area); elsewhere the HTTP caller is unscoped (`admin: null`) and the
 *  session guard decides from the Admin view the gate resolved
 *  (adminRouteGate). A public row that writes
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
 *  found it and set it on the request context (on the request, not the
 *  bound caller, so a call nested inside the request with a caller of its
 *  own still reads it); null outside a routed request (a
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
 * spelling (`/api/v1/%73earch`) finds the search row, but a key is judged
 * on the raw path, where such a spelling names no v1 route: not in the API.
 * The raw path only filters the row: it never picks another (the routed
 * row is the request's only row).
 * The gate (gateAccessKey) and the login lookup (findKeyLogin) both ask
 * this, through keyOnRow.
 */
export function requestKeyRoute(row: RouteRow | null, rawPath: string): KeyRoute | null {
  return row && spellsPattern(row.pattern, rawPath) ? rowKeyRoute(row) : null;
}

/**
 * The one judgment of an API key on a request's row:
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

/** A login outside Admin may read through this owner route. */
export function memberOpenRead(row: RouteRow): boolean {
  return row.logins === 'owner' && row.effect === 'read';
}

/** A login outside Admin may write through this owner route. */
export function memberOpenWrite(row: RouteRow): boolean {
  return row.logins === 'owner' && row.effect === 'write';
}

/** An any-login route: the rows open to any login, the chat rows and the
 *  Telegram rows. */
export function anyLoginRow(row: RouteRow): boolean {
  return row.logins === 'any' || row.logins === 'chat' || row.logins === 'telegram';
}
