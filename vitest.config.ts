import { defineConfig } from 'vitest/config';

/**
 * Minimal vitest setup. Each package can ship `*.test.ts` files anywhere
 * under its `src/` directory and they'll be picked up. No jsdom — we
 * test pure logic only for now; UI behaviour goes through `pnpm build`
 * + manual smoke for the time being.
 */
export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'server/**/*.test.ts',
      'client/**/*.test.ts',
      'e2e/lib/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
    // Workspace packages export raw TS — vitest's esbuild handles them.
    server: { deps: { inline: [/^@mantle\//] } },
  },
});
