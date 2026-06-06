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
 * Wired into `scripts/up.sh` (dev) and the production migrate gate.
 *
 * Usage:  pnpm -C apps/web pgboss:init   (reads DATABASE_URL from .env.local)
 */

import PgBoss from 'pg-boss';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[pgboss-init] DATABASE_URL is required');
  process.exit(1);
}

const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
boss.on('error', (e) => console.error('[pgboss-init] pg-boss error:', e.message));

try {
  await boss.start(); // creates pgboss.* on a fresh DB; no-op if already present
  await boss.stop({ graceful: false });
  console.log('[pgboss-init] pgboss schema ready.');
  process.exit(0);
} catch (err) {
  console.error('[pgboss-init] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
