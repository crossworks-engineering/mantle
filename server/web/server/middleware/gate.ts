import type { MiddlewareHandler } from 'hono';
import {
  RENDER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  isAssetPath,
  isDetachedDev,
  isPublicPath,
  requestOrigin,
} from '../../lib/auth-constants';
import { isAccessKey, type AccessKeyGrant } from '../../lib/access-keys';
import { bodyCeilingFor, bodyTooLargeResponse, declaredOver } from '../../lib/body-limit';
import { API_CACHE_DEFAULT, CACHE_CONTROL } from '../../lib/cache-control';
import {
  ADMIN_STEP_CALLERS,
  ANSWERED_AT_READ,
  assetQueryAsHanded,
  registerRouteSource,
  routeRef,
  routeSwitchedOff,
  spellsPattern,
  type RouteRow,
} from '../../lib/auth/route-policy';
import { refuseCrossSiteAuthPost } from '../../lib/auth/preflight';
import { takeRouteLimits, type RateLimitScope } from '../../lib/route-limits';
import { runWithRequestContext, type RequestContext } from '../request-context';
import { servedRoute, type ServedRoute } from '../route-loader';
import { gateAccessKey } from './access-key-gate';
import { tokenKind, verifySignedToken } from './token-verify';
import { env } from '@mantle/config';
import {
  enterCall,
  loginActor,
  runInActorSlot,
  runInRequestSlot,
  systemActor,
  withRequestScopeMemo,
  type CallerVia,
  type GateCaller,
  type WorkspaceScope,
} from '@mantle/db';
import {
  RouteLoginError,
  answeredLimitLogin,
  answerRouteCaller,
  enterRouteLogin,
  resolveHttpLogin,
  type HttpLogin,
} from '../../lib/auth/session';
import { ensureGateReady } from '@mantle/tools/gate-narrowers';

/**
 * The session/CORS gate — a faithful port of the old Next Edge middleware.ts.
 * Runs on every request that the static layer didn't serve. Differences from
 * the Next version, all deliberate:
 *
 *  - Request context (path/method for audit attribution) travels via ALS
 *    (server/request-context.ts) instead of injected x-mantle-* headers —
 *    same anti-spoof guarantee (derived from the URL, never forwarded).
 *  - The /login redirect builds on requestOrigin(req) (proxy-header aware)
 *    instead of req.url, so plain-HTTP/proxied installs redirect correctly.
 *  - public/ assets are served before the gate (they're library assets —
 *    fonts, app-runtime, icons — with no user data; the share surface needs
 *    them cookie-less anyway).
 *
 * The one gate's HTTP entry (arch plan v2, sections 2 and 7; A4 step 1): a
 * request a route of the manifest answers runs through enterCall
 * (@mantle/db gate.ts) with its ROUTE_POLICY row, found here once
 * (servedRoute) and set on the request context (currentRoute(), read by
 * every session guard and the API key checks, and by a call nested inside
 * the request). The credential checks below are step 1, resolving the
 * caller, and since A4 step 3a step 1 also finds its login, once
 * (resolveHttpLogin, lib/auth/session.ts): enterCall binds the caller with
 * it (currentCaller(): the login, its role and actor, the request's
 * logins every session guard now reads), looks the row's policy up,
 * narrows, and opens the request slot the guard fills. Since A4 step 2 the /s page
 * and the render pages are routes too (registerPages), each run in its own
 * actor slot. A request no route answers (a 404, a 405, the stubs) runs as
 * before.
 *
 * The credential questions of a routed request are its row's
 * (gateRouteView): whether it is public, whether it gets CORS, whether the
 * render cookie opens it. The path checks below answer only a request no
 * row answers. The routed row is the request's only row (requestRow): a
 * check on the raw path as sent only filters it, never picks another.
 */

/** The owner-surface sandbox frame document. Its iframe navigation carries no
 *  cookie (sandboxed, opaque origin) — auth is the seconds-lived `?t=` frame
 *  ticket (kind 'f'), accepted for THIS path shape only; the route re-verifies
 *  and binds the ticket to the app id. Mirrors the `?at=` asset-path carve. */
const OWNER_FRAME_RE = /^\/api\/apps\/[^/]+\/frame$/;
/** The member-surface frame document (member logins Phase 4b): same ticket
 *  carve; the route accepts only a MEMBER ticket (`mem` claim). */
const MEMBER_FRAME_RE = /^\/api\/member\/apps\/[^/]+\/frame$/;
/** A Present canvas's frame document: the same ticket carve (a canvas
 *  ticket, `cv`; the route refuses an app's). */
const CANVAS_FRAME_RE = /^\/api\/presents\/[^/]+\/frame$/;

/** Old middleware matcher exclusion: bare image paths never hit the gate. */
const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

// ── CORS for the detached client (Electron / cross-origin dev / DB-less) ──────
// Opt-in via MANTLE_API_CORS_ORIGINS (comma list, or '*' to reflect any).
// Detached clients authenticate with a BEARER token, never cookies, so we
// deliberately DO NOT emit Access-Control-Allow-Credentials. The '*' wildcard
// is refused on the credential-minting surfaces (/api/auth*): those need an
// explicit allowlist entry.
function corsOrigins(): string[] {
  return (env('MANTLE_API_CORS_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOrigin(req: Request, path: string): string | null {
  const allowed = corsOrigins();
  if (allowed.length === 0) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null; // same-origin / non-browser — no CORS needed
  const isAuth = path === '/api/auth' || path.startsWith('/api/auth/');
  if (allowed.includes('*') && !isAuth) return origin;
  return allowed.includes(origin) ? origin : null;
}

function applyCors(headers: Headers, origin: string): void {
  headers.set('Access-Control-Allow-Origin', origin);
  headers.append('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  // Idempotency-Key rides every assistant/team turn POST (replay-safe retries).
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  headers.set('Access-Control-Max-Age', '86400');
}

/** 401 for a programmatic (API) client — a clean JSON status it can branch on,
 *  matching getOwnerOr401's body. */
function unauthorized(): Response {
  return Response.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': CACHE_CONTROL.none } },
  );
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * The caller of a routed request (the gate's step 1; A4 step 3a resolves
 * its login here). `login` is what the gate found (resolveHttpLogin,
 * session.ts: the same functions every session guard reads): the login,
 * its role and actor, what it holds of the row's Admin area (step 5), and
 * the request's logins bound in the facts, which each guard reads
 * (currentCaller()). The request slot still starts as the row says
 * (system(http:no-login) for a manifest route; a public write row's
 * named actor, the same) and the guard names the login on it when it
 * reads it, as before: a route that reads no guard runs as it did. Step 6
 * names no create home (createHome null): the guard does, on its rules.
 * On a row whose handler reads the caller the pipeline answers (row.caller,
 * A4 step 3b) the gate runs the answer of the guard of the row's caller
 * kind itself, before the handler (answerRouteCaller), with what it does on
 * the side; and on every area row whose caller is the owner guard or its
 * asset form (route-policy.ts ADMIN_STEP_CALLERS: 'owner', 'ownerAsset';
 * the boot refuses an area row that reads another kind and is not public)
 * the gate's step 5 is the area check (A4 step 3b part 4, S9 part 2): the
 * caller carries the Admin view the login lookup resolved, of the login the
 * row's guard answers as (on an asset row, the login a GET's `?at=` token
 * or the render cookie names), and the login's effects are applied in the
 * request slot first (enterRouteLogin), as the guard applied them before
 * its check.
 */
function httpCaller(
  row: RouteRow,
  via: CallerVia,
  login: HttpLogin,
  memo: Map<string, Promise<WorkspaceScope>>,
  accessKey?: AccessKeyGrant,
): GateCaller {
  const startsAs = systemActor(row.actor ?? row.startsAs);
  // The Admin step the gate enforces: the view of the row's area of the
  // login the row's guard answers as (resolveHttpLogin), on every area row
  // (S9 part 2: its caller is one of ADMIN_STEP_CALLERS, the boot refuses
  // another). Unscoped (null) only where no view is read: a member, a
  // credential with no login, a row with no area, whose answer is the
  // pipeline's (403 member-login, the 401); a failed area read never gets
  // here (the gate answers it in the handler's place).
  const admin = row.area && row.caller && ADMIN_STEP_CALLERS.has(row.caller) ? login.admin : null;
  const slot = <T>(fn: () => Promise<T>) =>
    runInRequestSlot(admin ? () => enterRouteLogin(fn) : fn, { memo, startsAs });
  return {
    actor: login.loginId && login.mode ? loginActor(login.loginId, login.mode) : startsAs,
    via,
    loginId: login.loginId,
    role: login.role,
    // A key's write switch. gateAccessKey judged the key's areas and its
    // read-only switch first, on the same row (keyOnRow: the row's
    // effect, pinned to the key table's access by route-policy.test.ts),
    // with the 403 bodies the API promises; this narrows nothing past it.
    // No `facts.keyAreas`: the gate's key narrower does not run on HTTP
    // (gateAccessKey and the login lookup judge the areas, keyOnRow).
    ...(accessKey ? { write: accessKey.access === 'read_write' } : {}),
    admin,
    createHome: null,
    facts: login.facts,
    // The request slot (workspaces W6a), opened for the handler with the
    // memo the login lookup seeded. A page of server/pages (the /s page, a
    // render page; A4 step 2) has no session guard to fill one: it runs in
    // an actor slot of its own, starting as its row says, as it did before
    // it had a row.
    enterScope: row.page
      ? (_writes, fn) => runInActorSlot(startsAs, fn)
      : (_writes, fn) => slot(fn),
  };
}

/** The limit scopes the gate takes: every one, but a login's on a row
 *  whose caller is answered at the read (that read takes it). */
const ALL_SCOPES: ReadonlySet<RateLimitScope> = new Set(['ip', 'login', 'brain']);
const NO_LOGIN_SCOPES: ReadonlySet<RateLimitScope> = new Set(['ip', 'brain']);

/**
 * What a row checks of its request before the handler (route-limits.ts
 * its declaration's `limits`; A10 #8), in the gate's request slot, once the caller is
 * answered: the cross-site refusal of a public auth post first (no page on
 * another site spends a visitor's budget), then the row's rate limits, with
 * the one 429. A login's limit counts the login the pipeline answered
 * (answeredLimitLogin); on a row answered at the read the read takes it
 * (session.ts publicLoginCaller). A byte row's query is the one its handler
 * is handed (assetQueryAsHanded).
 */
function beforeHandler(row: RouteRow, req: Request): Response | null {
  if (row.crossSite) {
    const refused = refuseCrossSiteAuthPost(req, { json: row.crossSite === 'json' });
    if (refused) return refused;
  }
  if (!row.rateLimit.length) return null;
  const handed = assetQueryAsHanded(row);
  const atRead = row.caller !== null && ANSWERED_AT_READ.has(row.caller);
  return takeRouteLimits(row.rateLimit, {
    req,
    ...(handed !== null ? { query: new URLSearchParams(handed) } : {}),
    login: atRead ? null : answeredLimitLogin(),
    scopes: atRead ? NO_LOGIN_SCOPES : ALL_SCOPES,
  });
}

/**
 * The request's ROUTE_POLICY row: its route's row for the method, or null
 * (no route answers, or the route answers the method only with its 405).
 *
 * The one rule (arch A4; docs/actors.md): this ROUTED row is the request's
 * only row. enterCall runs with it, the request context carries it
 * (currentRoute()), the key scope (requestKeyRoute) and the item a write
 * names (routeItemTarget) read it. A check on the raw path as sent (the
 * credential view below, requestKeyRoute) only FILTERS this row: it may
 * decide the row does not answer, never pick a different one.
 */
export function requestRow(route: ServedRoute | null, method: string): RouteRow | null {
  return route?.rows.get(method.toUpperCase()) ?? null;
}

/** What the gate reads of a request's route (arch A4 step 2). */
export type GateRouteView = Readonly<{
  /** The request's row answered the questions below: there is one, and
   *  the path as sent spells its pattern. False: the path checks did (no
   *  row, or a path that spells a static segment with escapes). */
  byRow: boolean;
  /** Let in with no credential (the route judges its own). */
  public: boolean;
  /** CORS-eligible: any /api request, and the /s routes a client-origin
   *  page calls cross-origin (the row's pattern: its preflight too). */
  cors: boolean;
  /** The render cookie opens it (GET only: the row's renderCookie). */
  renderCookie: boolean;
}>;

/**
 * The gate's credential questions for one request, answered once: by the
 * request's row (requestRow) for a routed request, by the path checks for
 * a request no route answers (one place each: the row is built from the
 * same functions, route-policy.ts).
 *
 * The router matches the path with its percent-escapes decoded, and the
 * path checks always read it as sent. So the row answers only when the
 * path as sent spells its pattern (spellsPattern); a path that spells a
 * static segment with escapes (`/s/x/%76iew`) is answered by the path
 * checks, as it was before rows decided (pinned by link-render-sweep). The
 * spelling test filters the row; the request keeps it either way.
 */
export function gateRouteView(
  route: ServedRoute | null,
  row: RouteRow | null,
  path: string,
): GateRouteView {
  const isApi = path === '/api' || path.startsWith('/api/');
  const spelled = route !== null && spellsPattern(route.pattern, path);
  if (row && spelled) {
    return {
      byRow: true,
      public: row.public,
      cors: isApi || row.cors,
      renderCookie: row.renderCookie,
    };
  }
  return {
    byRow: false,
    public: isPublicPath(path),
    // A preflight or another method of a /s route with CORS: no row, the
    // pattern's own answer.
    cors: isApi || (spelled && route.cors),
    // Every path the render cookie opens has a row (route-policy.test.ts).
    renderCookie: false,
  };
}

/**
 * The gate's Cache-Control default (A10 #15, lib/cache-control.ts): an /api
 * answer that names no Cache-Control answers `no-store`, whatever made it (a
 * handler, a refusal of the gate, the app's error or not-found answer: this
 * runs outside them all, so it sees the answer that goes out). A route that
 * may be cached names its policy from CACHE_CONTROL; this never overrides
 * one. Mounted just before the gate (server/app.ts).
 */
export function apiCacheDefault(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return;
    if (c.res.headers.has('cache-control')) return;
    try {
      c.res.headers.set('Cache-Control', API_CACHE_DEFAULT);
    } catch {
      // Immutable headers (a fetched or a redirect Response): a copy takes it.
      const res = new Response(c.res.body, c.res);
      res.headers.set('Cache-Control', API_CACHE_DEFAULT);
      c.res = res;
    }
  };
}

export function gate(): MiddlewareHandler {
  // The one gate is ready (every narrower registered) before the app takes
  // a request: main.ts asks it at boot too; this covers an app built
  // without main (a test).
  ensureGateReady();
  registerRouteSource();
  // Arch A2a: the gate's own lookups (an API key, a token) run as
  // system(http:gate); enterCall opens each routed handler's own slot.
  const inner = gateHandler();
  return (c, next) => runInActorSlot(systemActor('http:gate'), () => inner(c, next));
}

function gateHandler(): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const path = url.pathname;

    const isApi = path === '/api' || path.startsWith('/api/');
    // The request's route and its row, found once (A4 step 1), and what
    // the gate reads of them (A4 step 2). `row` is the request's only row
    // (requestRow): the view and the key check only filter it.
    const route = servedRoute(c);
    const row = requestRow(route, req.method);
    const view = gateRouteView(route, row, path);
    const corsEligible = view.cors;
    const origin = corsEligible ? corsOrigin(req, path) : null;
    const withCors = (res: Response) => {
      if (origin) applyCors(res.headers, origin);
      return res;
    };

    // Run the downstream handler inside the ambient request context, then
    // apply CORS to whatever it produced. `accessKey` is set only when the
    // request was let in by an API key (below). A routed request runs
    // through the one gate with its row (found once, above); a refusal of
    // the gate is answered by the one mapper. The call runs with that row
    // even where the path checks answered the credential questions (an
    // escaped path: view.byRow false).
    const proceed = async (via: CallerVia, accessKey?: AccessKeyGrant) => {
      const ctx: RequestContext = {
        req,
        path,
        method: req.method,
        ...(accessKey ? { accessKey } : {}),
        ...(row ? { route: row } : {}),
      };
      const refused = await runWithRequestContext(ctx, async () => {
        if (!row) {
          await next();
          return null;
        }
        // A row served under a switch that is off (A4 hand batch A): the
        // route's own off answer, where its handler gave it, first, before
        // any guard (the switch its route file declares, RouteRow.switch).
        const off = routeSwitchedOff(row);
        if (off) return Response.json(off.body, { status: off.status });
        // Step 1: the login, found once for the request (A4 step 3a),
        // its read seeding the memo the request slot is opened with.
        const memo = new Map<string, Promise<WorkspaceScope>>();
        let login: Awaited<ReturnType<typeof resolveHttpLogin>>;
        try {
          login = await withRequestScopeMemo(memo, () => resolveHttpLogin(row));
        } catch (error) {
          if (!(error instanceof RouteLoginError)) throw error;
          // The Admin view of the row's area could not be read (S9 part 2):
          // thrown in the handler's place, where the guard's own area read
          // threw it before, so onError answers it with the CORS headers.
          // Fail closed: no handler runs, nothing asks the area again.
          ctx.callerError = { error: error.error };
          await next();
          if (ctx.callerError) throw ctx.callerError.error;
          return null;
        }
        const call = enterCall(
          httpCaller(row, via, login, memo, accessKey),
          routeRef(row),
          async () => {
            // A row whose handler reads the caller the pipeline answers
            // (row.caller, A4 step 3b): the answer of the guard of the
            // row's caller kind (owner, member, any-login, chat), given
            // here once in the request slot, its effects with it; a
            // refusal is the gate's answer and the handler does not run.
            let refused: Response | null = null;
            try {
              refused = await answerRouteCaller(row);
            } catch (error) {
              // An error the answer throws (the database down, busy) is
              // thrown where the guard threw it before the codemod: in
              // the handler's place (route-loader.ts takes it from the
              // request), so the app's onError answers it and the
              // response keeps its CORS headers, as it did. The handler
              // does not run.
              ctx.callerError = { error };
            }
            if (refused) return refused;
            // What the row checks before its handler (A10 #8), once the
            // caller is answered: the cross-site refusal, then its limits.
            // Not where the answer threw: the handler does not run.
            if (!ctx.callerError) {
              const held = beforeHandler(row, req);
              if (held) return held;
            }
            await next();
            // Nothing took it (no handler of the manifest answered):
            // thrown here, never dropped.
            if (ctx.callerError) throw ctx.callerError.error;
            return null;
          },
        );
        let out: Awaited<typeof call>;
        try {
          out = await call;
        } catch (error) {
          if (!(error instanceof RouteLoginError)) throw error;
          // The login's effects failed before the Admin step
          // (enterRouteLogin): the error is thrown in the handler's place,
          // where the owner guard threw it before the gate checked the
          // area, so onError answers it with the CORS headers. No handler
          // runs.
          ctx.callerError = { error: error.error };
          await next();
          if (ctx.callerError) throw ctx.callerError.error;
          return null;
        }
        if (out.ok) return out.value;
        if (!out.refusal.http) throw out.error;
        return Response.json(out.refusal.http.body, { status: out.refusal.http.status });
      });
      if (refused) return withCors(refused);
      if (origin) applyCors(c.res.headers, origin);
    };

    // CORS preflight is answered before auth — a preflight carries no
    // credentials and only asks "may I send this request".
    if (corsEligible && req.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    // The body ceiling (client logins C5 audit, I4): a declared body over
    // the route's ceiling is refused before any handler buffers it, public
    // routes included. Streamed uploads spool under their own caps (null
    // here); a chunked body is capped while it is read (the route loader,
    // capRequestBody).
    // The public share routes too (apps audit S2): their db-broker read any
    // body an anonymous caller sent.
    // The decoded path Hono matched (c.req.path), as the loader reads it:
    // `/api/%61uth/...` is held to the ceiling of the route that answers it
    // (fix round 1, L8).
    const matchedPath = c.req.path;
    if (
      (matchedPath === '/api' ||
        matchedPath.startsWith('/api/') ||
        matchedPath.startsWith('/s/')) &&
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      const ceiling = bodyCeilingFor(matchedPath);
      if (ceiling !== null && declaredOver(req.headers, ceiling)) {
        return withCors(bodyTooLargeResponse(ceiling));
      }
    }

    const isPublic = view.public;

    // An inbound API key (`mtlk_`): judged on itself, before any cookie, so
    // a cookie riding along can never widen what the key may do, and before
    // the image-suffix bypass below, so no path shape skips its checks
    // (audit item 3). Accepted on /api/v1/* only; anywhere else under /api
    // it is a 401 (access-key-gate.ts). A public path keeps its own rules:
    // /api/mcp checks keys itself (lib/mcp-auth.ts), and on the others the
    // route's login lookup takes no key (lib/auth/session.ts).
    const presented = bearerToken(req);
    if (isAccessKey(presented) && !isPublic) {
      const res = await gateAccessKey(req, path, presented, row);
      if ('response' in res) return withCors(res.response);
      return proceed('key', res.grant);
    }

    // Old matcher exclusion: image-suffixed paths bypass the gate entirely
    // (static already had its chance; this just falls through to the 404).
    // A routed request let in this way judged no credential and may not be
    // public: its via says so ('unjudged'), never 'public', so no later
    // step reads it as the row's `public`. Its route's guard decides.
    if (IMAGE_EXT_RE.test(path)) return proceed(isPublic ? 'public' : 'unjudged');

    if (isPublic) return proceed('public');

    const secret = env('SESSION_SECRET');
    if (!secret || secret.length < 32) {
      // Misconfig: log server-side, return a generic 500. Never put config
      // details in the URL/body — operator sees the reason in stderr.
      console.error('[gate] SESSION_SECRET missing or <32 chars; refusing all requests');
      return withCors(
        new Response('Service unavailable', {
          status: 500,
          headers: { 'Cache-Control': CACHE_CONTROL.none },
        }),
      );
    }

    // A session cookie must be a real cookie, not a kinded token reused as one —
    // a mobile token would dodge revocation, an asset token would grant full
    // session access. Mirrors lib/auth's verify (rejects any `k` on cookies).
    const cookie = cookieValue(req, SESSION_COOKIE_NAME);
    if (cookie && (await verifySignedToken(cookie, secret)) && tokenKind(cookie) === null) {
      return proceed('cookie');
    }

    // Mobile companion / detached client: Authorization: Bearer <mobile-token>.
    // Per-device revocation is enforced in the Node layer (getSessionUser).
    const bearer = bearerToken(req);
    if (bearer) {
      if ((await verifySignedToken(bearer, secret)) && tokenKind(bearer) === 'm') {
        return proceed('bearer');
      }
      // A bearer was presented but is invalid — an API client, not a browser:
      // answer 401 rather than redirect to an HTML login page.
      return withCors(unauthorized());
    }

    // Browser-native asset sources (<img>/<iframe>/download) convey auth via a
    // short-lived signed `?at=` token — accepted ONLY for the byte-serving
    // asset paths. The route re-validates and owner-scopes the lookup.
    if (isAssetPath(path) && req.method === 'GET') {
      const at = url.searchParams.get('at');
      if (at && (await verifySignedToken(at, secret)) && tokenKind(at) === 'a') {
        return proceed('token');
      }
    }

    // The sandbox frame document navigates with a `?t=` frame ticket — same
    // can't-carry-a-credential shape as the asset paths above, same narrow
    // acceptance: these three paths only, GET only, kind 'f' only.
    if (
      (OWNER_FRAME_RE.test(path) || MEMBER_FRAME_RE.test(path) || CANVAS_FRAME_RE.test(path)) &&
      req.method === 'GET'
    ) {
      const t = url.searchParams.get('t');
      if (t && (await verifySignedToken(t, secret)) && tokenKind(t) === 'f') {
        return proceed('token');
      }
    }

    // The browser sidecar rendering an export carries a render cookie (kind
    // 'r', set on the print origin only). Accepted for the render surfaces and
    // the byte routes they load, GET only (the row's renderCookie), and never
    // as a session: anywhere else it is no credential at all. The route
    // re-checks the login and, on a render surface, the node the cookie names.
    if (view.renderCookie) {
      const r = cookieValue(req, RENDER_COOKIE_NAME);
      if (r && (await verifySignedToken(r, secret)) && tokenKind(r) === 'r') {
        return proceed('token');
      }
    }

    // No credential at all. An /api/** request must get a STATUS (programmatic
    // clients follow HTML redirects silently); only page navs get the login
    // redirect.
    if (isApi) return withCors(unauthorized());

    // DB-less detached dev: page navs render (the page gate resolves identity
    // via detachedDevUser); API requests still 401 — the client's data fetches
    // target the REMOTE API. Dev-only, hard-off in production.
    if (isDetachedDev()) return proceed('public');

    const loginUrl = new URL('/login', requestOrigin(req));
    loginUrl.searchParams.set('next', path);
    return Response.redirect(loginUrl, 307);
  };
}

/** Raw (undecoded) cookie read — tokens are unpadded base64url, so this always
 *  agrees with lib/auth's decoded read; if token minting ever emits `%`/`=`,
 *  revisit BOTH reads together (audit note L2). Gate is defense-in-depth only —
 *  every route re-authenticates. */
function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
