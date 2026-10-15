import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The A8 matrix (workspaces arch plan v2, section 12 A8): the SQL grid and
 * the surface cells, `*.matrix.test.ts`, which the other configs leave out.
 * `pnpm test:matrix` with MANTLE_TEST_DATABASE_URL set; docs/actors.md, "A8
 * matrix".
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/**/src/**/*.matrix.test.ts', 'server/**/*.matrix.test.ts'],
    exclude: [...configDefaults.exclude],
  },
});
