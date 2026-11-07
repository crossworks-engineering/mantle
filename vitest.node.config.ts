import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * What still runs on Node, tested on Node: the parser, sandboxd, migrate, and
 * the contract packages mantle-client loads on Electron. Every other suite runs
 * on Bun. `pnpm test:node`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'server/parser/**/*.test.ts',
      'server/sandboxd/**/*.test.ts',
      'packages/db/src/migrate-*.test.ts',
      'packages/client-types/**/*.test.ts',
      'packages/content-core/**/*.test.ts',
      'packages/voice-client/**/*.test.ts',
      'packages/share-ui/**/*.test.ts',
      'packages/app-build/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude],
  },
});
