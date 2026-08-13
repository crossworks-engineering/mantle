import { defineConfig } from 'vitest/config';

/**
 * Minimal vitest setup. Each package can ship `*.test.ts` files anywhere
 * under its `src/` directory and they'll be picked up. No jsdom — we
 * test pure logic only for now; UI behaviour goes through `pnpm build`
 * + manual smoke for the time being.
 */
export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'server/**/*.test.ts', 'eslint-rules/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The 5s default assumes a test only times its own logic. Several tests
    // import modules INSIDE the test body — sometimes because the module reads
    // env that a `beforeAll` has to set first — so module resolution and the
    // esbuild transform are billed against this budget too. On a many-core box
    // vitest runs ~one worker per core, all transforming at once (this suite
    // reports ~250s of aggregate import time), and a `require('mathjs')` that
    // costs 411ms idle can pass 5s when the machine is genuinely busy. That
    // failed the pre-push gate on a green tree, which is the expensive kind of
    // false alarm: it teaches people to retry rather than to read.
    testTimeout: 15_000,
    // Workspace packages export raw TS — vitest's esbuild handles them.
    server: { deps: { inline: [/^@mantle\//] } },
  },
});
