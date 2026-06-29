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
  // PHASE 0 SPIKE: the remote MCP endpoint self-authenticates (hardcoded bearer
  // now, OAuth later) so it must bypass the session-cookie gate. See
  // apps/web/app/api/mcp/route.ts and the plan's Phase 4.
  '/api/mcp',
];

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
