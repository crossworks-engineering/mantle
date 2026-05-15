import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship raw TypeScript — Next compiles them in-tree.
  transpilePackages: [
    '@mantle/crypto',
    '@mantle/db',
    '@mantle/email',
    '@mantle/rules',
    '@mantle/search',
    '@mantle/storage',
  ],
  experimental: {
    serverActions: { bodySizeLimit: '4mb' },
  },
  // pg-boss + postgres-js use node-only modules; keep them server-only.
  serverExternalPackages: ['pg-boss', 'postgres'],
  reactStrictMode: true,
};

export default nextConfig;
