/**
 * Constants shared between middleware (Edge runtime) and lib/auth.ts
 * (Node runtime). Both files validate the session cookie but can't share
 * full code — middleware uses Web Crypto, lib/auth uses node:crypto.
 * Pull anything that's just data (cookie name, public paths) in here.
 */

export const SESSION_COOKIE_NAME = 'mantle_session';

// `/s` is the public read-only share surface (token-gated, no session). The
// /s pages + /s/[token]/a/[fileId] asset route authorize by share token, not by
// the owner cookie — see docs/sharing.md.
// `/api/federation` is the inbound federation surface for peer Mantles. It
// authorizes by a per-peer bearer token (verifyInboundToken), not the owner
// cookie — so it must bypass the session gate. See docs/federation.md.
// `/api/version` exposes only the build identity (version/SHA/build time) — no
// sensitive data — so it stays open for uptime/ops probes. See docs/versioning.md.
// `/app-runtime` is the shared mini-app runtime (React + UI kit + host bridge) —
// open-source library code with no secrets or user data. Sandboxed app iframes
// load it with an OPAQUE origin (no session cookie), so it must bypass the gate.
export const PUBLIC_PATHS = [
  '/login',
  '/api/auth',
  '/s',
  '/api/federation',
  '/api/version',
  '/app-runtime',
  // The remote MCP endpoint self-authenticates with an OAuth bearer, so it must
  // bypass the session-cookie gate. See apps/web/app/api/mcp/route.ts.
  '/api/mcp',
  // OAuth 2.1 authorization server for the MCP connector. register + token
  // self-authenticate; authorize is the exception — it USES the session but must
  // still bypass the middleware (it's a browser navigation that does its OWN
  // login redirect, where the gate would otherwise return 401 JSON). The
  // discovery docs are public metadata. See apps/web/lib/mcp-oauth.ts.
  '/api/oauth',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
];

/**
 * Whether cookies set on this response should carry the `Secure` attribute.
 * Decided from the request's actual scheme — NOT from NODE_ENV: production
 * builds also serve plain-HTTP installs (MANTLE_SITE_ADDRESS=:80 on a bare
 * IP, the documented no-domain mode), where browsers silently discard Secure
 * cookies — login "succeeds" but the session never sticks and the user loops
 * back to /login forever. Caddy sets X-Forwarded-Proto on every proxied
 * request; the URL scheme covers direct (proxy-less) access.
 */
export function secureCookies(req: Request): boolean {
  const fwd = req.headers.get('x-forwarded-proto');
  if (fwd) return fwd.split(',')[0]?.trim().toLowerCase() === 'https';
  return new URL(req.url).protocol === 'https:';
}

/**
 * DB-less "detached" dev: a local frontend pointed at a remote API
 * (`NEXT_PUBLIC_MANTLE_API_BASE`) with no local Postgres. The dev auth shim in
 * `lib/auth` (`detachedDevUser`) and the page-nav bypass in `middleware.ts` both
 * gate on this.
 *
 * Master switch is a SERVER-ONLY env var (deliberately NOT `NEXT_PUBLIC_`, so it
 * can never be flipped on from a shipped client bundle) AND it is hard-disabled
 * in production — so the bypass can NEVER activate in a prod build, regardless of
 * how the public API vars are set. Env-only (no node:crypto), so it is safe to
 * call from the Edge middleware. See docs/db-less-dev.md.
 */
export function isDetachedDev(): boolean {
  return process.env.NODE_ENV !== 'production' && !!process.env.MANTLE_DETACHED_DEV?.trim();
}
