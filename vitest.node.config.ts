import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * What still runs on Node, tested on Node: the parser with its readers
 * (packages/files), sandboxd, migrate with the object store's bucket step, and
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
      'packages/files/src/**/*.test.ts',
      'packages/config/src/**/*.test.ts',
      'packages/db/src/migrate-*.test.ts',
      'packages/db/src/migrator-steps.test.ts',
      'packages/db/src/check-floor*.test.ts',
      'packages/storage/src/index.test.ts',
      'packages/client-types/**/*.test.ts',
      'packages/content-core/**/*.test.ts',
      'packages/voice-client/**/*.test.ts',
      'packages/share-ui/**/*.test.ts',
      'packages/app-build/**/*.test.ts',
    ],
    exclude: [...configDefaults.exclude, 'packages/files/**/*.db.test.ts'],
  },
});
