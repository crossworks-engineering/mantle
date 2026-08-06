import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The ZERO-SECRET owner-UI app. No DB, no server packages, no SESSION_SECRET —
 * every byte of data comes from the server origin over bearer + CORS (see
 * @mantle/web-ui/api-fetch). Same-origin deployments simply serve this app and
 * the server app behind one host; the split serves it at app.<domain>.
 */

// Build identity — mirrors server/web: the ROOT package.json version is the
// single source of truth (scripts/bump-version.mjs keeps this file's own
// version in lockstep for the workspace, but the inlined value reads root).
const rootPkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  version: string;
};

const nextConfig: NextConfig = {
  transpilePackages: ['@mantle/web-ui'],
  // Pin the dev/build root to THIS checkout. Without it Turbopack infers the
  // root by scanning upward for lockfiles, finds the integrator clone's, and
  // roots there — and since `.claude/worktrees/` lives INSIDE that clone, every
  // sibling worktree falls under the root and becomes fair game to compile.
  // The failure is spectacular and easy to misread: a dev server in worktree A
  // serves chunks built from worktree B, the module factories don't exist
  // ("module factory is not available"), and the dev overlay hard-reloads to
  // recover — forever. It presents as an infinite refresh loop, not as a
  // resolution error. Same guess `outputFileTracingRoot` below already guards.
  turbopack: { root: join(__dirname, '../..') },
  // Desktop shell (client/desktop) embeds this app as a self-contained node
  // server. Opt-in so image builds keep today's output. The tracing root is
  // pinned to the monorepo root so the standalone tree resolves workspace deps
  // from THIS checkout (with several worktrees present Next would guess).
  ...(process.env.MANTLE_STANDALONE
    ? { output: 'standalone' as const, outputFileTracingRoot: join(__dirname, '../..') }
    : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPkg.version,
    NEXT_PUBLIC_GIT_SHA: process.env.MANTLE_GIT_SHA ?? '',
    NEXT_PUBLIC_BUILD_TIME: process.env.MANTLE_BUILD_TIME ?? '',
  },
  // Mini-app sandbox runtime — this app renders sandboxes too (owner /apps),
  // and the OPAQUE-origin iframes (sandbox without allow-same-origin) fetch
  // the runtime cross-origin (Origin: null) → ACAO:* required. Same block as
  // server/web (which serves it for the team/share surfaces).
  async headers() {
    return [
      {
        source: '/app-runtime/:file(.+\\.js)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        source: '/app-runtime/manifest.json',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cache-Control', value: 'no-cache' },
        ],
      },
    ];
  },
  // Renamed screens — old bookmarks/deep-links keep working (moved from the
  // monolith; these are owner-UI routes, so they live here now).
  async redirects() {
    return [
      { source: '/lifelog', destination: '/journal', permanent: true },
      { source: '/memories', destination: '/journal', permanent: true },
      { source: '/todos', destination: '/tasks', permanent: true },
    ];
  },
};

export default nextConfig;
