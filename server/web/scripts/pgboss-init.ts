/**
 * Materialise the `pgboss` schema once, before any workers start.
 *
 * Why: pg-boss creates its schema (`pgboss.version`/`job`/`queue`/…) lazily on
 * the first `boss.start()`. On a FRESH database the web email worker, the agent
 * extract-queue, the email backfill queue, and the folder-actions queue all call
 * `start()` at roughly the same time — and that concurrent first-create RACES,
 * leaving the schema uncreated. The symptom is a storm of
 * `relation "pgboss.job"/"pgboss.version" does not exist` (42P01) from the
 * supervisor/cron loops, and queues that never get created (so extraction +
 * email indexing silently stall).
 *
 * Running ONE `start()` here, after migrations and before the workers, creates
 * the schema deterministically. Idempotent: a no-op once the schema exists.
 * Then EXECUTE on pg-boss's routines is taken from PUBLIC (@mantle/db
 * revokePgBossRoutines; migrate does the same on every run).
 * Wired into `scripts/up.sh` (dev) and the production migrate gate.
 *
 * Usage:  pnpm -C server/web pgboss:init   (reads DATABASE_URL from .env.local)
 */

import { PgBoss } from 'pg-boss';
import { bootSmokeExit, env, isBootSmoke } from '@mantle/config';
import { revokePgBossRoutines } from '@mantle/db';

// Boot smoke (scripts/boot-smoke.mjs): imports linked; exit 0 before any I/O.
if (isBootSmoke()) await bootSmokeExit('pgboss-init');

const url = env('DATABASE_URL');
if (!url) {
  console.error('[pgboss-init] DATABASE_URL is required');
  process.exit(1);
}

/** The queues of the old sync workers (email-sync, microsoft-sync,
 *  calendar-sync), removed in Sync plan M4. */
const RETIRED_QUEUES = [
  'mantle.email.sync',
  'mantle.email.backfill',
  'mantle.email.scheduler',
  'mantle.microsoft.drive-sync',
  'mantle.microsoft.mail-sync',
  'mantle.microsoft.backfill',
  'mantle.microsoft.scheduler',
  'mantle.calendar.sync',
  'mantle.calendar.scheduler',
];

const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
boss.on('error', (e) => console.error('[pgboss-init] pg-boss error:', e.message));

try {
  await boss.start(); // creates pgboss.* on a fresh DB; no-op if already present
  // pg-boss makes its routines with PUBLIC's default EXECUTE, after this
  // box's migrate on a fresh database or an upgrade: take it back now
  // (job_table_run runs its text as SQL). As the migrator, their owner.
  await revokePgBossRoutines({ unsafe: (text) => boss.getDb().executeSql(text) });
  // The old mail, calendar-feed and Microsoft sync left the brain (Sync plan,
  // M4): their schedules would keep queueing a job every 2 minutes that no
  // worker takes. Gone once; a no-op after.
  for (const q of RETIRED_QUEUES) {
    await boss.unschedule(q).catch(() => undefined);
    await boss.deleteQueue(q).catch(() => undefined);
  }
  await boss.stop({ graceful: false });
  console.log('[pgboss-init] pgboss schema ready.');
  process.exit(0);
} catch (err) {
  console.error('[pgboss-init] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
