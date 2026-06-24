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
];
