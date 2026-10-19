import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The write-path cells with the actor check on (workspaces arch A2b2b): a
 * scoped login write runs on the write role and the database refuses what
 * its checks refuse, as on a box whose check is on (dev). The member write
 * cells, the workspaces cells, the write role's cells and the gateway's,
 * and the A6 grant sweep (its answers as main recorded them, in check on).
 * vitest.setup.ts still fails a test on a miss or an unknown write-role gap.
 * `pnpm test:actor-on`.
 */
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'server/web/server/w6b-*.db.test.ts',
      'server/web/server/a2b2b-write-gateway.db.test.ts',
      'server/web/lib/grants.db.test.ts',
      'server/web/server/a6-grant-sweep.db.test.ts',
      'server/web/server/a6b-exit-sweep.db.test.ts',
      'packages/db/src/workspaces*.db.test.ts',
      'packages/db/src/write-role.db.test.ts',
      'packages/db/src/matrix/**/*.test.ts',
      'server/web/server/app-draft-scope.db.test.ts',
      // The Admin login is role AND membership, warn (the full run) and on.
      'server/web/lib/auth/admin-membership.db.test.ts',
      // The Login and adminFacts, scoped and unscoped, warn and on.
      'server/web/lib/auth/admin-facts.db.test.ts',
    ],
    env: { ...base.test?.env, MANTLE_ACTOR_CHECK: 'on' },
  },
});
