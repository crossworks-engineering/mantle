/**
 * What the migrator does around the migrations that the app's runtime role
 * may not: one place for migrate.ts, the test scratch databases
 * and the restore test, so each runs the same steps.
 *
 *  - before the migrations: the viewer roles and the runtime roles (cluster
 *    objects a restore does not bring back; the migrations grant to them);
 *  - after: the access matrix's grants, the tables handed to mantle_owner
 *    and the runtime role's rights (runtime-role.ts), and ts_match_vq
 *    LEAKPROOF (leakproof.ts), which a pg_dump restore does not carry;
 *  - migrate.ts only: the narrow counts' epoch row (ensureNarrowEpoch),
 *    once per release.
 *
 * Each needs the superuser that runs the migrations (DATABASE_URL); a
 * caller that is not one gets a warning for the runtime role and the
 * LEAKPROOF flag, and the box runs as before.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoIdentityLeaks } from './identity-gateway';
import type postgres from 'postgres';
import { applyViewerGrants } from './access-matrix';
import { ensureTsMatchLeakproof } from './leakproof';
import {
  applyRuntimeGrants,
  ensureRuntimeRoles,
  ownTables,
  runtimeLockDetails,
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
 *  outcome for afterMigrations. `runtimeLogin`: MANTLE_DB_RUNTIME_ROLE as
 *  migrate sees it (compose passes it through x-app-env): the runtime role
 *  may log in only then, and is NOLOGIN again at the first migrate without
 *  it. The narrow role logs in whenever it can (a master key, outside
 *  per-database mode): the narrow route's own pool (gateway/pools.ts). */
export async function beforeMigrations(
  sql: Sql,
  masterKey: string | null,
  perDatabase: boolean,
  runtimeLogin: boolean,
  log: StepLog = consoleLog,
): Promise<RuntimeRolesOutcome> {
  // Refuses to reset roles another brain on this cluster owns.
  if ((await ensureViewerRoles(sql, masterKey, perDatabase)) === 'not-permitted') {
    log.warn(
      '  WARNING the viewer roles not set: migrate runs as a role that may not manage roles',
    );
  }
  /** A login role's line: LOGIN, or NOLOGIN with the cause that holds (the
   *  switch, per-database mode, or no master key to derive its password). */
  const loginLine = (role: string, switchName: string, on: boolean): string => {
    if (!on) return `  ${role}: NOLOGIN (${switchName} is off)`;
    if (perDatabase) return `  ${role}: NOLOGIN (per-database mode: no login for it)`;
    if (!masterKey) {
      return `  ${role}: NOLOGIN (${switchName} is on, but MANTLE_MASTER_KEY is not set: no password to derive)`;
    }
    return `  ${role}: LOGIN (${switchName} is on)`;
  };
  const runtime = await ensureRuntimeRoles(sql, masterKey, {
    login: runtimeLogin,
    perDatabase,
    warn: log.warn,
  });
  if (runtime === 'ok') {
    log.info(loginLine('runtime role mantle_runtime', 'MANTLE_DB_RUNTIME_ROLE', runtimeLogin));
    log.info(narrowLine(perDatabase, masterKey !== null));
  }
  if (runtime === 'not-superuser') {
    log.warn(
      '  WARNING the runtime role (mantle_runtime) not made: migrate does not run as a superuser',
    );
  } else if (runtime === 'old-server') {
    log.warn('  WARNING the runtime role (mantle_runtime) needs Postgres 16 or later: not made');
  }
  const narrow = narrowLoginWarning(runtime);
  if (narrow) log.warn(narrow);
  return runtime;
}

/** The narrow role's line: LOGIN, or NOLOGIN with the cause that holds. */
function narrowLine(perDatabase: boolean, hasKey: boolean): string {
  const role = '  narrow role mantle_system_narrow';
  if (perDatabase) return `${role}: NOLOGIN (per-database mode: the role is taken per transaction)`;
  if (!hasKey) return `${role}: NOLOGIN (MANTLE_MASTER_KEY is not set: no password to derive)`;
  return `${role}: LOGIN`;
}

/**
 * Migrate's warning when the roles step did not run (`runtime` is not
 * 'ok'): this run could not make the narrow role or give it its login, so
 * unless an earlier migrate did, every narrow statement fails closed
 * (NarrowLoginError). Null when there is nothing to warn of.
 */
export function narrowLoginWarning(runtime: RuntimeRolesOutcome): string | null {
  if (runtime === 'ok') return null;
  const why =
    runtime === 'not-superuser'
      ? 'migrate does not run as a superuser'
      : 'the server is older than Postgres 16';
  return (
    `  WARNING the narrow role (mantle_system_narrow) was not made or given its login (${why}): ` +
    `unless an earlier migrate did, every narrow statement fails closed. Run migrate as a ` +
    `superuser on Postgres 16 or later`
  );
}

/**
 * The grants and the superuser-only marks, after the migrations (and after
 * a restore, at the migrate that follows it). The access matrix and the
 * runtime role's rights fail the run when they fail; an ownership change a
 * busy table refused (or any other it could not make) and the LEAKPROOF
 * flag are warnings (the next run tries again). Then the integrity row
 * runtime_role_lock, read again: what this run could not put back (a
 * mantle_owner_role() from before 0290, say) is a warning in the log, not
 * only a row on /debug/integrity.
 */
export async function afterMigrations(
  sql: Sql,
  runtime: RuntimeRolesOutcome,
  log: StepLog = consoleLog,
): Promise<void> {
  // The identity gateway's catalog check (0322): no function, policy or
  // trigger condition reads an identity setting outside the readers. Fatal:
  // a definer that trusts a session's own login is a hole on every role.
  // A database stopped before 0322 (an old-migration cell) has no check yet.
  await assertNoIdentityLeaks(sql, (line) => log.info(line));

  // The viewer roles' grants come from the access matrix, re-applied every
  // run so the live grants always equal the checked-in list.
  await applyViewerGrants(sql);

  if (runtime === 'ok') {
    const own = await ownTables(sql);
    if (own.owned.length > 0) log.info(`  ${own.owned.length} table(s) handed to mantle_owner`);
    const busy = own.failed.filter((f) => f.busy);
    if (busy.length > 0) {
      log.warn(
        `  WARNING ${busy.length} table(s) busy, still with their old owner (the next migrate ` +
          `retries; untidy, not a hole): ${busy.map((f) => f.rel).join(', ')}`,
      );
    }
    for (const f of own.failed.filter((x) => !x.busy)) {
      log.warn(`  WARNING ${f.rel} still has its old owner (next run retries): ${f.error}`);
    }
    await applyRuntimeGrants(sql);
    for (const detail of await runtimeLockDetails(sql)) {
      log.warn(`  WARNING the runtime role lock is not whole (runtime_role_lock): ${detail}`);
    }
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

/** The check name of the narrow counts' epoch row in actor_check_misses
 *  (docs/runtime-role.md, "The narrow-denied count"). It starts with
 *  narrow- so the maintenance reaper keeps it, as it keeps the counts. */
export const NARROW_EPOCH_CHECK = 'narrow-epoch';

/** A release version as the epoch row holds it: digits and dots, an
 *  optional pre-release tag. Nothing else is written, so the box script
 *  may print it. */
const RELEASE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

/** The release's version from the root package.json's text, or null: no
 *  text, not JSON, no version, the 0.0.0 placeholder, or a value that is
 *  not a plain version. */
export function releaseVersionOf(pkgText: string | null): string | null {
  if (!pkgText) return null;
  let version: unknown;
  try {
    version = (JSON.parse(pkgText) as { version?: unknown }).version;
  } catch {
    return null;
  }
  if (typeof version !== 'string' || version.length > 64) return null;
  if (!RELEASE_VERSION.test(version) || version === '0.0.0') return null;
  return version;
}

/** The root package.json, which holds the release's version (the server
 *  reads the same file: server/web/server/main.ts). */
const ROOT_PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'package.json',
);

/** The release's version as migrate reads it, or null (releaseVersionOf). */
export function readReleaseVersion(path = ROOT_PACKAGE_JSON): string | null {
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    /* no file: no version */
  }
  return releaseVersionOf(text);
}

/**
 * The narrow counts' epoch: one row per release, check narrow-epoch,
 * detail the version. The box script
 * (scripts/arch-scoreboard-box.sh) counts the narrow rows written since the
 * latest one, so a release that fixed a cause starts again from 0. Written
 * once per version: a second migrate of the same version writes nothing,
 * and neither does a version an epoch row already names (a roll back to an
 * older release keeps the newer epoch). No version: nothing. The row is
 * written as every miss row is, through mantle_actor_miss_log (0275: the
 * same columns, its cap of 100 an hour per check far above one a release).
 */
export async function ensureNarrowEpoch(
  sql: Sql,
  version: string | null,
): Promise<'written' | 'present' | 'no-version'> {
  if (!version) return 'no-version';
  const rows = await sql`
    select "public"."mantle_actor_miss_log"('migrate', ${NARROW_EPOCH_CHECK}, '', ${version})
     where not exists (select 1 from public.actor_check_misses
                        where check_name = ${NARROW_EPOCH_CHECK} and detail = ${version})`;
  return rows.length > 0 ? 'written' : 'present';
}
