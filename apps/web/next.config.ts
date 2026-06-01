import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript — Next compiles them in-tree.
  transpilePackages: [
    '@mantle/agent-runtime',
    '@mantle/api-keys',
    '@mantle/crypto',
    '@mantle/db',
    '@mantle/email',
    '@mantle/embeddings',
    '@mantle/files',
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
    'pg-boss',
    'postgres',
    'heic-convert',
    'pdf-to-png-converter',
    '@napi-rs/canvas',
    // Reads host CPU/mem/temps for the /debug system-vitals + /api/health probe.
    // Server-only; pulls optional per-OS native temp-sensor modules — externalize
    // so webpack doesn't try to bundle them (they're require()d at runtime).
    'systeminformation',
  ],
  // Externalize `@napi-rs/canvas` for the PRODUCTION server build (webpack).
  // `serverExternalPackages` alone doesn't externalize it when it's reached
  // *through* a transpilePackages workspace package (@mantle/files rasterize →
  // pdf-to-png-converter → @napi-rs/canvas), so `next build` tries to parse the
  // native `skia.*.node` binary and fails ("Module parse failed"). (Only
  // `next dev`/turbopack was ever run before, which tolerates it.) We match the
  // meta-package + its per-platform binding (@napi-rs/canvas-<os>-<arch>) by
  // NAME — deliberately NOT a blanket `.node` rule, which would also catch
  // packages' *optional* relative bindings (e.g. `./platform.node`) and turn a
  // benign "optional dep absent" warning into a fatal runtime require failure.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push((
        { request }: { request?: string },
        callback: (err?: null, result?: string) => void,
      ) => {
        if (request && (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas-'))) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });
    }
    return config;
  },
  reactStrictMode: true,
};

export default nextConfig;
