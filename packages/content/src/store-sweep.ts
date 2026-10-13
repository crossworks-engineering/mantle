/**
 * THE store sweep (workspaces arch A3b, plan 20.3: "leaves a sweep to remove
 * orphans"; docs/store-brokers.md): one pass over every store a broker
 * writes under a new revision name, through the one helper
 * (`sweepOrphans`, @mantle/db store-broker.ts). It removes a store file no
 * row points at: an old revision a flip left, a stage whose flip never
 * landed (a refusal the broker could not clean up, a crash), the files of a
 * deleted table. Never a revision a row points at, never anything younger
 * than the grace period, and only after a file has been seen unreferenced
 * on two runs a grace period apart. Plain files and one read of the rows:
 * no model, no extraction, no notify. Run by the maintenance worker
 * (`store-sweep`) and `pnpm store:sweep`.
 *
 * Server-only (node:fs).
 */
import path from 'node:path';
import { isNotNull } from 'drizzle-orm';
import { appDatabases, db, relativeTo, sweepOrphans, tables, type SweepReport } from '@mantle/db';
import { tableDbRoot } from '@mantle/tabledb';
import { appDbRoot } from './app-broker';
import { SNAPSHOT_OWNER } from './table-storage';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]*';

/** A table workbook: `<owner>/<node>[.r-<token>][.draft].sqlite`, never the
 *  history folder or the accepted copies (the snapshot store). */
const TABLE_FILE = new RegExp(`^${SEGMENT}/${UUID}(\\.r-[0-9a-z]+)?(\\.draft)?\\.sqlite$`);
/** An app database: `<owner>/<app>[.r-<token>].sqlite`. */
const APP_FILE = new RegExp(`^${SEGMENT}/${UUID}(\\.r-[0-9a-z]+)?\\.sqlite$`);

function ownsTable(rel: string): boolean {
  return TABLE_FILE.test(rel) && !rel.startsWith(`${SNAPSHOT_OWNER}/`) && !rel.startsWith('_');
}

function ownsApp(rel: string): boolean {
  return APP_FILE.test(rel) && !rel.startsWith('_');
}

export type StoreSweepOptions = { dryRun?: boolean; now?: number; graceMs?: number };

/** Sweep every revisioned store once. */
export async function sweepStores(opts: StoreSweepOptions = {}): Promise<SweepReport[]> {
  const tableRoot = tableDbRoot();
  const appRoot = appDbRoot();
  return [
    await sweepOrphans(
      {
        store: 'tables',
        root: tableRoot,
        owns: ownsTable,
        live: async () => {
          const rows = await db
            .select({ p: tables.storagePath, d: tables.draftPath })
            .from(tables)
            .where(isNotNull(tables.storagePath));
          const out = new Set<string>();
          for (const r of rows) {
            if (r.p) out.add(path.posix.normalize(r.p));
            if (r.d) out.add(path.posix.normalize(r.d));
          }
          return out;
        },
      },
      opts,
    ),
    await sweepOrphans(
      {
        store: 'appdb',
        root: appRoot,
        owns: ownsApp,
        live: async () => {
          const rows = await db.select({ p: appDatabases.storagePath }).from(appDatabases);
          return new Set(rows.map((r) => relativeTo(appRoot, r.p)));
        },
      },
      opts,
    ),
  ];
}

/** One line for a maintenance run row. */
export function summariseStoreSweep(reports: SweepReport[], dryRun = false): string {
  const parts = reports.map(
    (r) =>
      `${r.store}: ${r.removed.length} ${dryRun ? 'would go' : 'removed'}, ${r.marked} newly unreferenced${r.failed ? `, ${r.failed} failed` : ''}`,
  );
  return parts.join('; ');
}
