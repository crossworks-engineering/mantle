import { defineConfig } from 'vitest/config';

/** The package's own run (`pnpm -C packages/diagram-templates test`): pure
 *  logic in Node, no database, none of the root suite's global setup. The
 *  root suite picks these files up as well. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
