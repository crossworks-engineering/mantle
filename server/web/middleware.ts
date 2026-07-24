import { NextResponse, type NextRequest } from 'next/server';
import {
  MANTLE_METHOD_HEADER,
  MANTLE_PATH_HEADER,
  PUBLIC_PATHS,
  SESSION_COOKIE_NAME,
  isDetachedDev,
} from '@/lib/auth-constants';

/**
 * Lightweight session-cookie check in the Edge runtime. Uses Web Crypto
 * (available in both edge and node runtimes) so we avoid pulling node:crypto.
 *
 * Per-page `requireOwner()` does the DB lookup; this just gates non-public
 * paths on a syntactically-valid, signed, unexpired cookie.
 */

function b64urlDecode(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function eqConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function verify(token: string, secret: string): Promise<boolean> {
  // Wrapped end-to-end: a malformed token (bad base64 in the sig or payload)
  // must resolve to `false`, never throw — otherwise an attacker-controlled
  // Bearer value would crash the middleware into a 500 instead of a clean 401.
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = token.slice(0, dot);
    const sigPart = token.slice(dot + 1);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    const got = b64urlDecode(sigPart);
    if (!eqConstantTime(got, expected)) return false;

    const json = new TextDecoder().decode(b64urlDecode(payload));
    const data = JSON.parse(json);
    if (typeof data.exp !== 'number') return false;
    if (Date.now() / 1000 > data.exp) return false;
    return true;
  } catch {
    return false;
  }
}

function bearerToken(req: NextRequest): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

/** The kind marker (`k`) in a token's payload, or null. Cookies carry none;
 *  mobile bearers carry `'m'`, asset tokens `'a'`. Signature/expiry are checked
 *  separately by `verify`. */
function tokenKind(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  try {
    const k = JSON.parse(new TextDecoder().decode(b64urlDecode(token.slice(0, dot)))).k;
    return typeof k === 'string' ? k : null;
  } catch {
    return null;
  }
}

/** Byte-serving asset routes whose `<img>`/`<iframe>`/download `src`s can't
 *  carry a bearer header, so they may authenticate via a `?at=` asset token.
 *  Scoped narrowly — the asset token is accepted for NOTHING else. */
function isAssetPath(path: string): boolean {
  return path.startsWith('/api/files/files/') || path.startsWith('/api/attachments/');
}

/** The /s APP broker sub-paths the split client's hub calls cross-origin
 *  (bearer-authed by resolveShareVisitorFromRequest). They get the same CORS
 *  treatment as /api/** — and ONLY they: the /s/<token> HTML page and the
 *  non-app brokers (rows, auth, a/) stay same-origin cookie surfaces with no
 *  CORS headers at all. */
const SHARE_BROKER_RE = /^\/s\/[^/]+\/(bundle|tool-broker|db-broker)$/;
function isShareBroker(path: string): boolean {
  return SHARE_BROKER_RE.test(path);
}

// ── CORS for the detached client (Electron / cross-origin dev / DB-less) ──────
// Opt-in: set MANTLE_API_CORS_ORIGINS to a comma-separated list of allowed
// origins (or '*' to reflect any). OFF by default — a same-origin browser needs
// no CORS, so default behaviour is unchanged. Detached clients authenticate with
// a BEARER token, never cookies, so we deliberately DO NOT emit
// Access-Control-Allow-Credentials: reflecting an origin WITHOUT credentials is
// safe (no cookie is ever sent cross-origin, so no CSRF surface; an unauthorized
// request still 401s). Applies to every /api/** response — but the '*' wildcard
// is refused on /api/auth (those routes return a bearer token in the body), so a
// cross-origin client must be EXPLICITLY allowlisted to reach login. See corsOrigin.
const CORS_ORIGINS = (process.env.MANTLE_API_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function corsOrigin(req: NextRequest, path: string): string | null {
  if (CORS_ORIGINS.length === 0) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null; // same-origin / non-browser — no CORS needed
  // The `*` wildcard reflects any origin — convenient for the bearer-only data
  // API, but a foot-gun on the auth surface (`/api/auth/login` etc. return a
  // bearer token in the body), so the wildcard NEVER applies there: auth routes
  // require an explicit allowlist entry. Non-auth /api keeps the wildcard.
  const isAuth = path === '/api/auth' || path.startsWith('/api/auth/');
  if (CORS_ORIGINS.includes('*') && !isAuth) return origin;
  return CORS_ORIGINS.includes(origin) ? origin : null;
}

function applyCors(res: NextResponse, origin: string): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.append('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  // Idempotency-Key rides every assistant/team turn POST (replay-safe retries).
  // Without it here the browser's preflight rejects the send for detached
  // clients — same-origin never preflights, so the gap only bit dev:fe/Electron.
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  res.headers.set('Access-Control-Max-Age', '86400');
  return res;
}

/** 401 for a programmatic (API) client — a clean JSON status it can branch on,
 *  matching getOwnerOr401's body. A browser EventSource / fetch would otherwise
 *  silently FOLLOW a redirect-to-/login and read HTML as a 200. */
function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const isApi = path === '/api' || path.startsWith('/api/');
  const corsEligible = isApi || isShareBroker(path);
  const origin = corsEligible ? corsOrigin(req, path) : null;
  const withCors = (res: NextResponse) => (origin ? applyCors(res, origin) : res);

  // Tell the Node layer what was requested: `getOwnerOr401` reads method+path
  // from these to audit mutations without threading `Request` through its 280+
  // call sites. Always set (never merely forwarded), so a client-supplied value
  // can't mislabel the audit trail on any path that passes through middleware.
  const reqHeaders = new Headers(req.headers);
  reqHeaders.set(MANTLE_PATH_HEADER, path);
  reqHeaders.set(MANTLE_METHOD_HEADER, req.method);
  const next = () => NextResponse.next({ request: { headers: reqHeaders } });

  // CORS preflight is answered before auth — a preflight carries no credentials
  // and only asks "may I send this request"; gating it would break every
  // cross-origin call. Covers the /s app brokers too (Authorization forces a
  // preflight on every cross-origin broker call).
  if (corsEligible && req.method === 'OPTIONS') {
    return withCors(new NextResponse(null, { status: 204 }));
  }

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
  if (isPublic) return withCors(next());

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // Misconfig: log server-side, return a generic 500. Never put config
    // details in the URL — they end up in browser history, referer
    // headers, and access logs. Operator sees the real reason in stderr;
    // the user sees a neutral page.
    console.error('[middleware] SESSION_SECRET missing or <32 chars; refusing all requests');
    return withCors(
      new NextResponse('Service unavailable', {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      }),
    );
  }

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  // A session cookie must be a real cookie, not a kinded token reused as one — a
  // mobile token would dodge revocation, an asset token would grant full session
  // access. Mirror lib/auth's verify(), which rejects any `k` on the cookie path.
  if (cookie && (await verify(cookie, secret)) && tokenKind(cookie) === null) {
    return withCors(next());
  }

  // Mobile companion / detached client: Authorization: Bearer <mobile-token>.
  // Signed with the same secret; we additionally require the mobile kind marker
  // (the token kind Electron + DB-less dev reuse). Per-device revocation is
  // enforced in the Node layer (getSessionUser).
  const bearer = bearerToken(req);
  if (bearer) {
    if ((await verify(bearer, secret)) && tokenKind(bearer) === 'm') {
      return withCors(next());
    }
    // A bearer was presented but is invalid — this is an API client, not a
    // browser, so answer 401 rather than redirect to an HTML login page.
    return withCors(unauthorized());
  }

  // Browser-native asset sources (<img>/<iframe>/download) can't send a bearer
  // header, so they convey auth via a short-lived signed `?at=` token — accepted
  // ONLY for the byte-serving asset paths so it can't reach any other API. The
  // route re-validates (lib/auth getOwnerForAsset) and owner-scopes the lookup.
  if (isAssetPath(path) && req.method === 'GET') {
    const at = req.nextUrl.searchParams.get('at');
    if (at && (await verify(at, secret)) && tokenKind(at) === 'a') {
      return withCors(next());
    }
  }

  // No credential at all. An /api/** request must get a STATUS (a programmatic
  // client follows an HTML redirect silently and misreads it as success); only a
  // page navigation gets the login redirect.
  if (isApi) return withCors(unauthorized());

  // DB-less detached dev: there's no local session cookie (login never happened)
  // and a top-level page navigation can't carry a bearer header, so without this
  // every page nav would 307 to /login BEFORE the page render's requireOwner()
  // could resolve the identity via detachedDevUser() — an infinite redirect
  // loop. Let page navs render; the page gate does the rest. Dev-only and never
  // in production (isDetachedDev). API requests still 401 — the client's data
  // fetches target the REMOTE API, not this local server.
  if (isDetachedDev()) return withCors(next());

  const url = new URL('/login', req.url);
  url.searchParams.set('next', path);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
