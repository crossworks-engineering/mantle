/**
 * One-shot: idempotently create the DBOS system database, and bring its schema
 * up to this release's DBOS, before the runner boots. Run in the `migrate` gate
 * (like pgboss:init) so the database exists deterministically — the runner then
 * just connects, and need not hold CREATE DATABASE itself. DBOS would lazily
 * auto-create it on launch, but doing it here keeps creation in the privileged
 * one-shot and out of the hot path.
 *
 * The schema step matters since DBOS 5: it moves workflow inputs and outputs
 * into their own tables, and a 5.x DBOSClient (the web enqueuer) needs that
 * schema but never migrates it itself. Without this step the web process could
 * enqueue against the old schema until the runner's launch migrated it. Same
 * code path as `npx dbos schema`; idempotent on a current schema.
 *
 * Kept dependency-light (only `postgres`): the system-DB name logic is inlined
 * rather than importing resolveSystemDatabaseUrl from @mantle/runtime/assistant,
 * which would pull the whole turn-runtime module graph into this tiny step.
 * Keep in sync with that resolver (the `mantle_dbos_sys` convention).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { env } from '@mantle/config';

function systemDbUrl(): string {
  const explicit = env('DBOS_SYSTEM_DATABASE_URL');
  if (explicit) return explicit;
  const app = env('DATABASE_URL');
  if (!app) throw new Error('DATABASE_URL (or DBOS_SYSTEM_DATABASE_URL) must be set');
  const u = new URL(app);
  u.pathname = '/mantle_dbos_sys';
  return u.toString();
}

async function main(): Promise<void> {
  const sysUrl = new URL(systemDbUrl());
  const dbName = sysUrl.pathname.replace(/^\//, '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName)) {
    // CREATE DATABASE can't be parameterized; only allow a safe identifier.
    throw new Error(`unsafe DBOS system database name: ${dbName}`);
  }
  // Connect to the default `postgres` database ON THE SAME SERVER to issue the
  // cluster-level CREATE DATABASE (you can't create the db you're connected to).
  const adminUrl = new URL(sysUrl.toString());
  adminUrl.pathname = '/postgres';
  const sql = postgres(adminUrl.toString(), { max: 1, prepare: false });
  try {
    const exists = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length > 0) {
      console.log(`[provision] DBOS system database "${dbName}" already exists`);
    } else {
      await sql.unsafe(`create database "${dbName}"`);
      console.log(`[provision] created DBOS system database "${dbName}"`);
    }
  } finally {
    await sql.end();
  }
  // The package's own CLI: its schema module is not in the package exports.
  // Resolved from this package's .bin so it is the same DBOS the runner loads.
  const dbos = path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'dbos');
  try {
    execFileSync(dbos, ['schema', sysUrl.toString()], { stdio: 'inherit' });
  } catch (err) {
    // execFileSync's message repeats argv, and argv carries the password, so
    // the original error is deliberately NOT attached as `cause`.
    const status = (err as { status?: number | null }).status;
    // eslint-disable-next-line preserve-caught-error -- the cause would log the password
    throw new Error(`dbos schema failed (exit ${status ?? 'unknown'}); see its output above`);
  }
  console.log(`[provision] DBOS system schema is current`);
}

main().catch((err) => {
  console.error('[provision] failed:', err);
  process.exit(1);
});
