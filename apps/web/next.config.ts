import type { NextConfig } from 'next';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Build identity ───────────────────────────────────────────────────────────
// Single source of truth for the app version is the ROOT package.json `version`.
// We resolve it (plus the git SHA + build time) HERE, at build/dev-start, and
// inline the result as NEXT_PUBLIC_* so the wordmark + /api/version can show it
// with zero runtime cost. `.git` is NOT in the Docker build context (see
// .dockerignore), so inside the image we can't run git — the build script passes
// MANTLE_GIT_SHA / MANTLE_BUILD_TIME as build args instead (see Dockerfile).
const configDir = dirname(fileURLToPath(import.meta.url));
const appVersion =
  (JSON.parse(readFileSync(join(configDir, '../../package.json'), 'utf8')) as { version?: string })
    .version ?? '0.0.0';

function resolveGitSha(): string {
  if (process.env.MANTLE_GIT_SHA) return process.env.MANTLE_GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: configDir,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return ''; // no git in the build context — fine; the SHA is just omitted.
  }
}
const gitSha = resolveGitSha();
const buildTime = process.env.MANTLE_BUILD_TIME || new Date().toISOString();

// Turbopack runs BOTH `next dev` and `next build` as of Next 16 (it sets
// TURBOPACK="auto" for each), so this is normally true and the webpack() hook
// below is not attached. It still matters for the documented opt-out,
// `next build --webpack`, which is the one path that needs the
// @napi-rs/canvas externalization done by hand.
//
// Turbopack IGNORES any webpack() config and warns when one is present, so
// gating it this way also keeps the normal build warning-free.
const usingTurbopack = !!process.env.TURBOPACK;

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript — Next compiles them in-tree.
  transpilePackages: [
    '@mantle/agent-runtime',
    '@mantle/api-keys',
    '@mantle/assistant-runtime',
    '@mantle/app-build',
    '@mantle/crypto',
    '@mantle/db',
    '@mantle/email',
    '@mantle/embeddings',
    '@mantle/files',
    '@mantle/mcp-core',
    '@mantle/rules',
    '@mantle/search',
    '@mantle/storage',
    '@mantle/telegram',
    '@mantle/tools',
    '@mantle/tracing',
  ],
  experimental: {
    serverActions: { bodySizeLimit: '4mb' },
  },
  turbopack: {
    // Pin the workspace root. Without this Next infers it by walking up for a
    // lockfile, and from a git worktree under .claude/worktrees/ it walks past
    // this tree and picks the INTEGRATOR checkout — resolving files from the
    // wrong copy of the repo. Derived from this file's own location, so it is
    // correct in the integrator and in every worktree.
    root: join(configDir, '../..'),
  },
  // Build identity, inlined at compile time. Read via lib/version.ts (client +
  // server safe) — drives the version next to the wordmark and /api/version.
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_GIT_SHA: gitSha,
    NEXT_PUBLIC_BUILD_TIME: buildTime,
  },
  // pg-boss + postgres-js use node-only modules; keep them server-only.
  // heic-convert bundles a libheif WASM binary — leave it external so the
  // bundler doesn't choke on the .wasm (the /assistant route lazy-imports it
  // to transcode iPhone HEIC photos before vision).
  // pdf-to-png-converter (+ its @napi-rs/canvas native binding) powers the
  // scanned-PDF OCR fallback (rasterize → vision). Turbopack can't bundle the
  // native .node binary — externalize so it's required from node_modules at
  // runtime ("Cannot find native binding" otherwise). Works in plain Node
  // (the extractor) already; this fixes the web /assistant turn.
  serverExternalPackages: [
    '@dbos-inc/dbos-sdk',
    'pg-boss',
    'postgres',
    'heic-convert',
    'pdf-to-png-converter',
    '@napi-rs/canvas',
    // Reads host CPU/mem/temps for the /debug system-vitals + /api/health probe.
    // Server-only; pulls optional per-OS native temp-sensor modules — externalize
    // so webpack doesn't try to bundle them (they're require()d at runtime).
    'systeminformation',
    // /apps build pipeline: esbuild ships a platform binary, server-only and
    // reached THROUGH a transpiled workspace package (@mantle/app-build), so it
    // also needs the webpack externals hook below for the production build.
    // (Per-app SQLite uses the built-in `node:sqlite` — no extra dep.)
    'esbuild',
    // /apps code editor's Format route: prettier dynamically require()s its
    // parser plugins at runtime, so webpack must not try to bundle it.
    'prettier',
    // Office export (page/note → .docx, table → .xlsx) — reached through the
    // transpiled @mantle/content package. exceljs in particular does dynamic
    // require()s; externalize both so the webpack build doesn't try to bundle
    // them. Both are direct apps/web deps so the externalization resolves.
    'docx',
    'exceljs',
  ],
  // Externalize `@napi-rs/canvas` for the PRODUCTION server build (webpack).
  // `serverExternalPackages` alone doesn't externalize it when it's reached
  // *through* a transpilePackages workspace package (@mantle/files rasterize →
  // pdf-to-png-converter → @napi-rs/canvas), so `next build` tries to parse the
  // native `skia.*.node` binary and fails ("Module parse failed"). Turbopack
  // (dev) tolerates it via serverExternalPackages, so this hook is attached ONLY
  // for the webpack build (see `usingTurbopack` above). We match the meta-package
  // + its per-platform binding (@napi-rs/canvas-<os>-<arch>) by NAME —
  // deliberately NOT a blanket `.node` rule, which would also catch packages'
  // *optional* relative bindings (e.g. `./platform.node`) and turn a benign
  // "optional dep absent" warning into a fatal runtime require failure.
  ...(usingTurbopack
    ? {}
    : {
        webpack: (config, { isServer }: { isServer: boolean }) => {
          if (isServer) {
            config.externals = config.externals || [];
            config.externals.push(
              (
                { request }: { request?: string },
                callback: (err?: null, result?: string) => void,
              ) => {
                if (
                  request &&
                  (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas-'))
                ) {
                  return callback(null, `commonjs ${request}`);
                }
                // /apps build pipeline native (see serverExternalPackages note).
                if (request && request === 'esbuild') {
                  return callback(null, `commonjs ${request}`);
                }
                callback();
              },
            );
          }
          return config;
        },
      }),
  reactStrictMode: true,
  // The shared mini-app runtime (packages/app-build → public/app-runtime/) is
  // imported by sandboxed app iframes via an import map. Those iframes have an
  // OPAQUE origin (sandbox without allow-same-origin), so a module fetch is
  // cross-origin (Origin: null) and needs CORS — hence ACAO. The runtime files
  // are content-hashed → immutable; the manifest maps specifiers to the current
  // hashes, so it must always revalidate.
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
  // The Journal screen was renamed from Life Logs (briefly "Memories"). Keep old
  // bookmarks/deep-links working; `?selected=` and other query params pass through
  // automatically.
  async redirects() {
    return [
      { source: '/lifelog', destination: '/journal', permanent: true },
      { source: '/memories', destination: '/journal', permanent: true },
      // Todos screen renamed to Tasks (node type `task` + /api/todos keep the
      // internal name). Old bookmarks/deep-links keep working; query params pass
      // through automatically.
      { source: '/todos', destination: '/tasks', permanent: true },
    ];
  },
};

export default nextConfig;
