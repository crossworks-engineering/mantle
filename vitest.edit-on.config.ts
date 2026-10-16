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
      // A3b: the store brokers (it sets both checks on itself, too).
      'server/web/server/a3b-store-brokers.db.test.ts',
      // A3b part 2: the files and snapshot stores.
      'server/web/server/a3b2-store-brokers.db.test.ts',
      // A8 fix round 1 (L6): the A8 findings' cells with both checks on.
      'server/web/server/a8-findings.db.test.ts',
      // A8 matrix F9 (0294): a contact share's write and its export sync.
      'server/web/server/f9-contact-export.db.test.ts',
      // The runs worker, the stdio MCP server and the Telegram poller on the
      // write role (pre-check deletion blocker 2).
      'server/web/server/worker-write-role.db.test.ts',
    ],
    env: { ...onBase.test?.env, MANTLE_TEST_EDIT_CHECK: 'on' },
  },
});
