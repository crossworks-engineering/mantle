import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * What still runs on Node, tested on Node: the parser with its readers
 * (packages/files), sandboxd, the storage client's Node path, and the contract
 * packages mantle-client loads on Electron. Every other suite runs on Bun,
 * migrate's included. `pnpm test:node`.
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
