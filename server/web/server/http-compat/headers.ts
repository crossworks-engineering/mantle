// Relative imports on purpose: vitest resolves no `@/` alias (see the note in
// lib/team-sso.ts), and this seam is unit-tested.
import { MANTLE_METHOD_HEADER, MANTLE_PATH_HEADER } from '../../lib/auth-constants';
import { getRequestContext } from '../request-context';

/**
 * Drop-in replacement for the READ surface of `next/headers`, backed by the
 * per-request ALS context. `lib/auth.ts` + `lib/audit.ts` swap only their
 * import specifier; the ~280 downstream call sites stay untouched.
 *
 * Read-only on purpose: no cookie MUTATION ever went through next/headers in
 * this app (verified — all Set-Cookie goes through the NextResponse instance
 * API, see ./response.ts), so `set`/`delete` are deliberately absent.
 *
 * Both functions are async purely to mirror the Next 15+ API shape
 * (`await cookies()` / `await headers()`).
 */

export type RequestCookie = { name: string; value: string };

export type ReadonlyRequestCookies = {
  get(name: string): RequestCookie | undefined;
  getAll(): RequestCookie[];
  has(name: string): boolean;
};

function requireContext() {
  const ctx = getRequestContext();
  if (!ctx) {
    // Same failure mode as calling next/headers outside a request scope.
    throw new Error(
      'cookies()/headers() called outside a request scope — no ambient request context',
    );
  }
  return ctx;
}

/** RFC 6265 request-cookie parsing: name=value pairs, `;`-separated. First
 *  occurrence wins on duplicates (matching Next / the cookie package). */
function parseCookieHeader(header: string | null): RequestCookie[] {
  if (!header) return [];
  const out: RequestCookie[] = [];
  const seen = new Set<string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    let value = part.slice(eq + 1).trim();
    // Cookie values may arrive double-quoted; strip one layer, per RFC 6265.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not %-encoded (our tokens are base64url) — use as-is.
    }
    out.push({ name, value });
  }
  return out;
}

/** Request-cookie lookup on an explicit Request (was NextRequest#cookies). */
export function requestCookie(req: Request, name: string): RequestCookie | undefined {
  return parseCookieHeader(req.headers.get('cookie')).find((c) => c.name === name);
}

export async function cookies(): Promise<ReadonlyRequestCookies> {
  const ctx = requireContext();
  const all = parseCookieHeader(ctx.req.headers.get('cookie'));
  return {
    get: (name) => all.find((c) => c.name === name),
    getAll: () => [...all],
    has: (name) => all.some((c) => c.name === name),
  };
}

export async function headers(): Promise<Headers> {
  const ctx = requireContext();
  const h = new Headers(ctx.req.headers);
  // Replaces the old middleware header-injection: path/method are derived
  // server-side from the URL (never forwarded from the client), so audit
  // attribution can't be spoofed — same guarantee, no header rewriting.
  h.set(MANTLE_PATH_HEADER, ctx.path);
  h.set(MANTLE_METHOD_HEADER, ctx.method);
  return h;
}
