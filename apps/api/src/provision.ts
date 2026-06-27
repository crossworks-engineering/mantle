/**
 * One-shot: idempotently create the DBOS system database before the runner
 * boots. Run in the `migrate` gate (like pgboss:init) so the database exists
 * deterministically — the runner then just connects, and need not hold
 * CREATE DATABASE itself. DBOS would lazily auto-create it on launch, but doing
 * it here keeps creation in the privileged one-shot and out of the hot path.
 *
 * Kept dependency-light (only `postgres`): the system-DB name logic is inlined
 * rather than importing resolveSystemDatabaseUrl from @mantle/assistant-runtime,
 * which would pull the whole turn-runtime module graph into this tiny step.
 * Keep in sync with that resolver (the `mantle_dbos_sys` convention).
 */

import postgres from 'postgres';

function systemDbUrl(): string {
  const explicit = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (explicit) return explicit;
  const app = process.env.DATABASE_URL;
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
      return;
    }
    await sql.unsafe(`create database "${dbName}"`);
    console.log(`[provision] created DBOS system database "${dbName}"`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[provision] failed:', err);
  process.exit(1);
});
