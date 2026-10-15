/**
 * What the migrator does around the migrations that the app's runtime role
 * may not (arch A9): one place for migrate.ts, the test scratch databases
 * and the restore test, so each runs the same steps.
 *
 *  - before the migrations: the viewer roles and the runtime roles (cluster
 *    objects a restore does not bring back; the migrations grant to them);
 *  - after: the access matrix's grants, the tables handed to mantle_owner
 *    and the runtime role's rights (runtime-role.ts), and ts_match_vq
 *    LEAKPROOF (leakproof.ts), which a pg_dump restore does not carry.
 *
 * Each needs the superuser that runs the migrations (DATABASE_URL); a
 * caller that is not one gets a warning for the runtime role and the
 * LEAKPROOF flag, and the box runs as before.
 */
import type postgres from 'postgres';
import { applyViewerGrants } from './access-matrix';
import { ensureTsMatchLeakproof } from './leakproof';
import {
  applyRuntimeGrants,
  ensureRuntimeRoles,
  ownTables,
  type RuntimeRolesOutcome,
} from './runtime-role';
import { ensureViewerRoles } from './viewer-roles';

type Sql = ReturnType<typeof postgres>;

export type StepLog = { info: (line: string) => void; warn: (line: string) => void };

const consoleLog: StepLog = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
};

/** The roles, before any migration runs. Returns the runtime roles'
 *  outcome for afterMigrations. */
export async function beforeMigrations(
  sql: Sql,
  masterKey: string | null,
  perDatabase: boolean,
  log: StepLog = consoleLog,
): Promise<RuntimeRolesOutcome> {
  // Refuses to reset roles another brain on this cluster owns.
  if ((await ensureViewerRoles(sql, masterKey, perDatabase)) === 'not-permitted') {
    log.warn(
      '  WARNING the viewer roles not set: migrate runs as a role that may not manage roles',
    );
  }
  const runtime = await ensureRuntimeRoles(sql, masterKey, perDatabase);
  if (runtime === 'not-superuser') {
    log.warn(
      '  WARNING the runtime role (mantle_runtime) not made: migrate does not run as a superuser',
    );
  } else if (runtime === 'old-server') {
    log.warn('  WARNING the runtime role (mantle_runtime) needs Postgres 16 or later: not made');
  }
  return runtime;
}

/**
 * The grants and the superuser-only marks, after the migrations (and after
 * a restore, at the migrate that follows it). The access matrix and the
 * runtime role's rights fail the run when they fail; an ownership change a
 * busy table refused and the LEAKPROOF flag are warnings (the next run
 * tries again).
 */
export async function afterMigrations(
  sql: Sql,
  runtime: RuntimeRolesOutcome,
  log: StepLog = consoleLog,
): Promise<void> {
  // The viewer roles' grants come from the access matrix, re-applied every
  // run so the live grants always equal the checked-in list.
  await applyViewerGrants(sql);

  if (runtime === 'ok') {
    const own = await ownTables(sql);
    if (own.owned.length > 0) log.info(`  ${own.owned.length} table(s) handed to mantle_owner`);
    for (const f of own.failed) {
      log.warn(`  WARNING ${f.rel} still has its old owner (next run retries): ${f.error}`);
    }
    await applyRuntimeGrants(sql);
  }

  // Keyword search under row security: the flag 0249 sets, again after a
  // restore (leakproof.ts). Speed only: a failure is a warning.
  try {
    const lp = await ensureTsMatchLeakproof(sql);
    if (lp === 'set') log.info('  ts_match_vq marked LEAKPROOF (keyword index under row security)');
    if (lp === 'not-superuser')
      log.info(
        '  ts_match_vq not LEAKPROOF and not a superuser: keyword arms scan under row security',
      );
  } catch (err) {
    log.warn(`  WARNING ts_match_vq LEAKPROOF not set (keyword arms scan): ${String(err)}`);
  }
}
