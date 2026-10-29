import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The write-path cells with the actor check on: a
 * scoped login write runs on the write role and the database refuses what
 * its checks refuse, as on a box whose check is on (dev). The member write
 * cells, the workspaces cells, the write role's cells and the gateway's,
 * and the grant sweep (its recorded answers, in check on).
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
      // The handlers that ask adminFacts of the Login, beside the legacy kind.
      'server/web/lib/auth/admin-facts-handlers.db.test.ts',
      // The area check in the gate's step 5, warn and on.
      'server/web/lib/auth/s9-area-fold.db.test.ts',
      // The folders above what a login reads, as structure (0311), off, warn and on.
      'server/web/server/s13-folder-trail-sweep.db.test.ts',
      'packages/db/src/folder-trail-0311.db.test.ts',
      // A fresh install's first sign-up and the first owner's exit (on).
      'server/web/server/ws-fresh-signup.db.test.ts',
    ],
    env: { ...base.test?.env, MANTLE_ACTOR_CHECK: 'on' },
  },
});
