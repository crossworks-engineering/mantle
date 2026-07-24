import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * ZERO-SECRET client middleware. This app holds no SESSION_SECRET, so it can
 * verify NOTHING — real enforcement is the server origin's 401s on every data
 * fetch. The only job here is UX: a page load without the presence cookie
 * (set at login by the token store, cleared at sign-out/bounce) server-
 * redirects to /login instead of flashing an empty shell that then bounces.
 *
 * The presence cookie is spoofable by construction — spoofing it renders a
 * data-free skeleton whose every fetch 401s. Nothing is protected here.
 */
const PRESENCE_COOKIE = 'mantle_authed';

/** Paths that render without a session: login itself + the runtime bits. */
const PUBLIC_PREFIXES = ['/login', '/env.js', '/app-runtime'];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (req.cookies.get(PRESENCE_COOKIE)?.value === '1') {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|ttf|woff2?)).*)',
  ],
};
