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
  serverExternalPackages: ['pg-boss', 'postgres', 'heic-convert'],
  reactStrictMode: true,
};

export default nextConfig;
