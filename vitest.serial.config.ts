import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The files that change something the whole cluster shares (a role's
 * password: narrow-password.serial.db.test.ts), `*.serial.db.test.ts`,
 * which the other configs leave out: one file at a time, and no other run
 * beside it on the same database server. `pnpm test:serial` with
 * MANTLE_TEST_DATABASE_URL set.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/**/src/**/*.serial.db.test.ts', 'server/**/*.serial.db.test.ts'],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
  },
});
