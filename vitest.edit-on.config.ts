import { defineConfig } from 'vitest/config';
import onBase from './vitest.actor-on.config';

/**
 * The write-path cells with both checks on (workspaces arch A3a): the
 * actor check on (vitest.actor-on.config.ts) and the edit check on, each
 * scratch database switched by MANTLE_TEST_EDIT_CHECK (test-support.ts) as
 * an operator switches a box (mantle_set_edit_check). The A3a cells too.
 * vitest.setup.ts still fails a test on a miss. `pnpm test:edit-on`.
 */
export default defineConfig({
  ...onBase,
  test: {
    ...onBase.test,
    include: [
      ...(onBase.test?.include ?? []),
      'packages/db/src/edit-check*.test.ts',
      'packages/db/src/a2b-nested-tx.db.test.ts',
      'server/web/server/a3a-folders.db.test.ts',
    ],
    env: { ...onBase.test?.env, MANTLE_TEST_EDIT_CHECK: 'on' },
  },
});
