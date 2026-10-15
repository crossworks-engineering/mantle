import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The database suites with the app's pools on the runtime role (workspaces
 * arch A9, docs/runtime-role.md): MANTLE_DB_RUNTIME_ROLE=1, so the system
 * pool and the LISTEN connections log in as mantle_runtime (its password
 * from MANTLE_MASTER_KEY, the role made by the global setup), while each
 * test's own fixtures keep the superuser URL. What a box runs after its
 * roll. `pnpm test:runtime-role`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/**/src/**/*.db.test.ts', 'server/**/*.db.test.ts'],
    env: {
      ...base.test?.env,
      MANTLE_DB_RUNTIME_ROLE: '1',
      MANTLE_MASTER_KEY: process.env.MANTLE_MASTER_KEY ?? 'mantle-viewer-test-key',
    },
  },
});
