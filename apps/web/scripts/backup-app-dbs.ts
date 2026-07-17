/**
 * Snapshot every per-app SQLite database into <destDir> (VACUUM INTO). Run
 * INSIDE a container that mounts APP_DB_DIR (the web or api service); scripts/
 * db-dump.sh invokes this and tars the result to the host, so the app-dbs are
 * backed up alongside the Postgres dump.
 *
 *   pnpm -C apps/web exec tsx scripts/backup-app-dbs.ts /tmp/appdbsnap
 *
 * Exit codes: 0 all good · 1 usage/crash · 2 one or more DBs failed to snapshot
 * (loud — a backup must never silently skip a database).
 */
import { snapshotAllAppDatabases } from '@mantle/content/app-broker';

async function main() {
  const destDir = process.argv[2];
  if (!destDir) {
    console.error('usage: tsx scripts/backup-app-dbs.ts <destDir>');
    process.exit(1);
  }
  const r = await snapshotAllAppDatabases(destDir);
  // Summary to STDERR so stdout stays clean for callers that pipe.
  console.error(
    `app-dbs snapshot → ${destDir}: ${r.snapshotted.length} ok, ${r.missing.length} missing, ${r.failed.length} failed`,
  );
  for (const m of r.missing)
    console.error(`  missing: ${m.ownerId}/${m.appNodeId} (${m.storagePath})`);
  for (const f of r.failed) console.error(`  FAILED:  ${f.ownerId}/${f.appNodeId} — ${f.error}`);
  if (r.failed.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
