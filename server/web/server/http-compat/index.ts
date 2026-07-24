/**
 * The app's replacement for `next/server` imports in route handlers.
 * Route files import `{ NextResponse, type NextRequest }` from here via a
 * mechanical swap of the import specifier — see ./response.ts for scope.
 */
export { NextResponse, ResponseCookies, serializeCookie } from './response';
export type { CookieSetOptions } from './response';

/**
 * Under Hono every handler receives a plain Fetch `Request`. The alias keeps
 * type annotations compiling; NextRequest-specific members (`nextUrl`,
 * `req.cookies`) were never used in route handlers (verified — query parsing is
 * `new URL(req.url)` everywhere).
 */
export type NextRequest = Request;
