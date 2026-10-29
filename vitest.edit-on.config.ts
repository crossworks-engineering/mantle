import { defineConfig } from 'vitest/config';
import onBase from './vitest.actor-on.config';

/**
 * The write-path cells with both checks on: the
 * actor check on (vitest.actor-on.config.ts) and the edit check on, each
 * scratch database switched by MANTLE_TEST_EDIT_CHECK (test-support.ts) as
 * an operator switches a box (mantle_set_edit_check). The folder edit
 * cells too.
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
      // The store brokers (it sets both checks on itself, too).
      'server/web/server/a3b-store-brokers.db.test.ts',
      // The files and snapshot stores.
      'server/web/server/a3b2-store-brokers.db.test.ts',
      // The A8 findings' cells with both checks on.
      'server/web/server/a8-findings.db.test.ts',
      // A contact share's write and its export sync (0294).
      'server/web/server/f9-contact-export.db.test.ts',
      // The runs worker, the stdio MCP server and the Telegram poller on the
      // write role.
      'server/web/server/worker-write-role.db.test.ts',
      // An Admin user's write request on the write role.
      'server/web/server/f4-admin-write-role.db.test.ts',
      // The owner's management flows on the write role.
      'server/web/server/f4-owner-flows.db.test.ts',
      // The fail-closed branches with both checks on.
      'packages/db/src/fail-closed.db.test.ts',
      // The parser keys the extractor keeps on a file node (the failure
      // count, the native PDF read that found nothing), both checks on.
      'server/api/src/agent/extract/parser-node-keys.db.test.ts',
    ],
    env: { ...onBase.test?.env, MANTLE_TEST_EDIT_CHECK: 'on' },
  },
});
