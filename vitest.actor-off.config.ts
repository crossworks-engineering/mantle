import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The suite with the actor check off (workspaces arch A2a): the plain
 * production path, where nothing is checked and no setting is sent. The db
 * package and the route sweeps run here as they do on a box whose check is
 * off. vitest.setup.ts still fails a test on a miss, and with the check off
 * none is recorded. `pnpm test:actor-off`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/db/src/**/*.test.ts', 'server/web/server/*sweep*.test.ts'],
    env: { ...base.test?.env, MANTLE_ACTOR_CHECK: 'off' },
  },
});
