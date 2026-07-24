import type { MiddlewareHandler } from 'hono';
import {
  PUBLIC_PATHS,
  SESSION_COOKIE_NAME,
  isDetachedDev,
  requestOrigin,
} from '../../lib/auth-constants';
import { runWithRequestContext } from '../request-context';
import { tokenKind, verifySignedToken } from './token-verify';

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
 */

/** Byte-serving asset routes whose <img>/<iframe>/download srcs can't carry a
 *  bearer header, so they may authenticate via a `?at=` asset token. Scoped
 *  narrowly — the asset token is accepted for NOTHING else. */
function isAssetPath(path: string): boolean {
  return path.startsWith('/api/files/files/') || path.startsWith('/api/attachments/');
}

/** The /s APP broker sub-paths the split client's hub calls cross-origin
 *  (bearer-authed by resolveShareVisitorFromRequest). They get the same CORS
 *  treatment as /api/** — and ONLY they: the /s/<token> HTML page and the
 *  non-app brokers (rows, auth, a/) stay same-origin cookie surfaces with no
 *  CORS headers at all. */
const SHARE_BROKER_RE = /^\/s\/[^/]+\/(bundle|tool-broker|db-broker)$/;

/** Old middleware matcher exclusion: bare image paths never hit the gate. */
const IMAGE_EXT_RE = /\.(?:svg|png|jpg|jpeg|gif|webp)$/;

// ── CORS for the detached client (Electron / cross-origin dev / DB-less) ──────
// Opt-in via MANTLE_API_CORS_ORIGINS (comma list, or '*' to reflect any).
// Detached clients authenticate with a BEARER token, never cookies, so we
// deliberately DO NOT emit Access-Control-Allow-Credentials. The '*' wildcard
// is refused on the credential-minting surfaces (/api/auth*, /api/team/auth,
// /api/team/sso) — those need an explicit allowlist entry.
function corsOrigins(): string[] {
  return (process.env.MANTLE_API_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOrigin(req: Request, path: string): string | null {
  const allowed = corsOrigins();
  if (allowed.length === 0) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null; // same-origin / non-browser — no CORS needed
  const isAuth =
    path === '/api/auth' ||
    path.startsWith('/api/auth/') ||
    path === '/api/team/auth' ||
    path === '/api/team/sso';
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
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export function gate(): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const path = url.pathname;

    const isApi = path === '/api' || path.startsWith('/api/');
    const corsEligible = isApi || SHARE_BROKER_RE.test(path);
    const origin = corsEligible ? corsOrigin(req, path) : null;
    const withCors = (res: Response) => {
      if (origin) applyCors(res.headers, origin);
      return res;
    };

    // Run the downstream handler inside the ambient request context, then
    // apply CORS to whatever it produced.
    const proceed = async () => {
      await runWithRequestContext({ req, path, method: req.method }, () => next());
      if (origin) applyCors(c.res.headers, origin);
    };

    // CORS preflight is answered before auth — a preflight carries no
    // credentials and only asks "may I send this request".
    if (corsEligible && req.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }));
    }

    // Old matcher exclusion: image-suffixed paths bypass the gate entirely
    // (static already had its chance; this just falls through to the 404).
    if (IMAGE_EXT_RE.test(path)) return proceed();

    const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
    if (isPublic) return proceed();

    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
      // Misconfig: log server-side, return a generic 500. Never put config
      // details in the URL/body — operator sees the reason in stderr.
      console.error('[gate] SESSION_SECRET missing or <32 chars; refusing all requests');
      return withCors(
        new Response('Service unavailable', {
          status: 500,
          headers: { 'Cache-Control': 'no-store' },
        }),
      );
    }

    // A session cookie must be a real cookie, not a kinded token reused as one —
    // a mobile token would dodge revocation, an asset token would grant full
    // session access. Mirrors lib/auth's verify (rejects any `k` on cookies).
    const cookie = cookieValue(req, SESSION_COOKIE_NAME);
    if (cookie && (await verifySignedToken(cookie, secret)) && tokenKind(cookie) === null) {
      return proceed();
    }

    // Mobile companion / detached client: Authorization: Bearer <mobile-token>.
    // Per-device revocation is enforced in the Node layer (getSessionUser).
    const bearer = bearerToken(req);
    if (bearer) {
      if ((await verifySignedToken(bearer, secret)) && tokenKind(bearer) === 'm') {
        return proceed();
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
        return proceed();
      }
    }

    // No credential at all. An /api/** request must get a STATUS (programmatic
    // clients follow HTML redirects silently); only page navs get the login
    // redirect.
    if (isApi) return withCors(unauthorized());

    // DB-less detached dev: page navs render (the page gate resolves identity
    // via detachedDevUser); API requests still 401 — the client's data fetches
    // target the REMOTE API. Dev-only, hard-off in production.
    if (isDetachedDev()) return proceed();

    const loginUrl = new URL('/login', requestOrigin(req));
    loginUrl.searchParams.set('next', path);
    return Response.redirect(loginUrl, 307);
  };
}

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
