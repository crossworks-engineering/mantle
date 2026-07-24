/**
 * Snapshot every file-backed table workbook into <destDir> (VACUUM INTO,
 * published + draft). Run INSIDE a container that mounts TABLE_DB_DIR (web or
 * api); scripts/db-dump.sh invokes this and tars the result to the host, so
 * table workbooks are backed up alongside the Postgres dump — durability gate
 * 2 of Tables v2: no table file exists outside the backup surface, ever.
 *
 *   pnpm -C server/web exec tsx scripts/backup-table-dbs.ts /tmp/tabledbsnap
 *
 * Exit codes: 0 all good · 1 usage/crash · 2 one or more snapshots failed
 * (loud — a backup must never silently skip a workbook).
 */
import { snapshotAllTableDatabases } from '@mantle/content/table-storage';

async function main() {
  const destDir = process.argv[2];
  if (!destDir) {
    console.error('usage: tsx scripts/backup-table-dbs.ts <destDir>');
    process.exit(1);
  }
  const r = await snapshotAllTableDatabases(destDir);
  console.error(
    `table-dbs snapshot → ${destDir}: ${r.snapshotted.length} ok, ${r.missing.length} missing, ${r.failed.length} failed`,
  );
  for (const m of r.missing)
    console.error(
      `  missing: ${m.nodeId} (${m.storagePath}) — already-lost data, restore from an older backup`,
    );
  for (const f of r.failed) console.error(`  FAILED:  ${f.nodeId} — ${f.error}`);
  if (r.failed.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
