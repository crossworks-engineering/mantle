import { NextResponse, type NextRequest } from 'next/server';
import { PUBLIC_PATHS, SESSION_COOKIE_NAME } from '@/lib/auth-constants';

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

/** True if the token's payload carries the mobile kind marker (`k:'m'`). The
 *  signature/expiry are checked separately by `verify`. */
function isMobileToken(token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  try {
    const json = new TextDecoder().decode(b64urlDecode(token.slice(0, dot)));
    return JSON.parse(json).k === 'm';
  } catch {
    return false;
  }
}

// ── CORS for the detached client (Electron / cross-origin dev / DB-less) ──────
// Opt-in: set MANTLE_API_CORS_ORIGINS to a comma-separated list of allowed
// origins (or '*' to reflect any). OFF by default — a same-origin browser needs
// no CORS, so default behaviour is unchanged. Detached clients authenticate with
// a BEARER token, never cookies, so we deliberately DO NOT emit
// Access-Control-Allow-Credentials: reflecting an origin WITHOUT credentials is
// safe (no cookie is ever sent cross-origin, so no CSRF surface; an unauthorized
// request still 401s). Applies to every /api/** response, including the public
// ones (a cross-origin client must be able to reach /api/auth to log in).
const CORS_ORIGINS = (process.env.MANTLE_API_CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function corsOrigin(req: NextRequest): string | null {
  if (CORS_ORIGINS.length === 0) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null; // same-origin / non-browser — no CORS needed
  if (CORS_ORIGINS.includes('*')) return origin;
  return CORS_ORIGINS.includes(origin) ? origin : null;
}

function applyCors(res: NextResponse, origin: string): NextResponse {
  res.headers.set('Access-Control-Allow-Origin', origin);
  res.headers.append('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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
  const origin = isApi ? corsOrigin(req) : null;
  const withCors = (res: NextResponse) => (origin ? applyCors(res, origin) : res);

  // CORS preflight is answered before auth — a preflight carries no credentials
  // and only asks "may I send this request"; gating it would break every
  // cross-origin call.
  if (isApi && req.method === 'OPTIONS') {
    return withCors(new NextResponse(null, { status: 204 }));
  }

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));
  if (isPublic) return withCors(NextResponse.next());

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
  if (cookie && (await verify(cookie, secret))) return withCors(NextResponse.next());

  // Mobile companion / detached client: Authorization: Bearer <mobile-token>.
  // Signed with the same secret; we additionally require the mobile kind marker
  // (the token kind Electron + DB-less dev reuse). Per-device revocation is
  // enforced in the Node layer (getSessionUser).
  const bearer = bearerToken(req);
  if (bearer) {
    if ((await verify(bearer, secret)) && isMobileToken(bearer)) {
      return withCors(NextResponse.next());
    }
    // A bearer was presented but is invalid — this is an API client, not a
    // browser, so answer 401 rather than redirect to an HTML login page.
    return withCors(unauthorized());
  }

  // No credential at all. An /api/** request must get a STATUS (a programmatic
  // client follows an HTML redirect silently and misreads it as success); only a
  // page navigation gets the login redirect.
  if (isApi) return withCors(unauthorized());

  const url = new URL('/login', req.url);
  url.searchParams.set('next', path);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
