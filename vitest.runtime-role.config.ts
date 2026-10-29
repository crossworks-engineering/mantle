import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The database suites with the app's pools on the runtime role
 * (docs/runtime-role.md): MANTLE_DB_RUNTIME_ROLE=1, so the system
 * pool and the LISTEN connections log in as mantle_runtime, while each
 * test's own fixtures keep the superuser URL. What a box runs after its
 * roll. `pnpm test:runtime-role`.
 *
 * The role's password comes from MANTLE_MASTER_KEY, so the whole run (the
 * global setup that sets it, and every test file) needs one key: set here,
 * before the global setup runs, when the caller has none. A 32-byte key,
 * because files that seal with the vault keep it (they only set a key of
 * their own when there is none).
 */
process.env.MANTLE_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/**/src/**/*.db.test.ts', 'server/**/*.db.test.ts'],
    env: {
      ...base.test?.env,
      MANTLE_DB_RUNTIME_ROLE: '1',
      MANTLE_MASTER_KEY: process.env.MANTLE_MASTER_KEY,
    },
  },
});
