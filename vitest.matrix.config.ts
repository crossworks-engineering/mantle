import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The A8 matrix (workspaces arch plan v2, section 12 A8): the SQL grid and
 * the surface cells, `*.matrix.test.ts`, which the other configs leave out.
 * `pnpm test:matrix` with MANTLE_TEST_DATABASE_URL set; docs/actors.md, "A8
 * matrix".
 */
// Every matrix file skips without a database. Say so loudly, so a local
// `pnpm verify` with no MANTLE_TEST_DATABASE_URL does not read as the matrix
// passed (CI refuses to start without it: vitest.global-setup.ts).
if (!process.env.MANTLE_TEST_DATABASE_URL) {
  const bar = '='.repeat(72);
  console.warn(
    [
      bar,
      'A8 MATRIX SKIPPED: MANTLE_TEST_DATABASE_URL is not set.',
      'The SQL grid, the surface cells and the grants panel test did not run.',
      'Run `pnpm test:matrix` with a test database (docs/actors.md, "A8 matrix").',
      bar,
    ].join('\n'),
  );
}

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/**/src/**/*.matrix.test.ts', 'server/**/*.matrix.test.ts'],
    exclude: [...configDefaults.exclude],
  },
});
