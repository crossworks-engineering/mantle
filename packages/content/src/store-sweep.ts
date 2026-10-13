/**
 * THE store sweep (workspaces arch A3b, plan 20.3: "leaves a sweep to remove
 * orphans"; docs/store-brokers.md): one pass over every store a broker
 * writes under a new revision name, through the one helper
 * (`sweepOrphans`, @mantle/db store-broker.ts). It removes only an old
 * revision of an item whose row names another file (one a flip replaced,
 * a stage whose flip never landed); a file whose item has no row (a deleted
 * one's, an app's from before A3b) and a draft from before A3b are only
 * reported. Never a revision a row points at, never anything younger than
 * the grace period, only after a file has been seen unreferenced on two
 * runs a grace period apart, and nothing at all when a guard trips (a row
 * outside the root, no row naming any file, too many at once). Plain files
 * and one read of the rows: no model, no extraction, no notify. Run by the
 * maintenance worker (`store-sweep`) and `pnpm store:sweep`.
 *
 * Server-only (node:fs).
 */
import path from 'node:path';
import {
  appDatabases,
  db,
  sweepOrphans,
  tables,
  type SweepOptions,
  type SweepReport,
} from '@mantle/db';
import { tableDbRoot } from '@mantle/tabledb';
import { appDbRoot, appFileNode } from './app-broker';
import { isLegacyDraftName, tableFileNode } from './table-broker';
import { SNAPSHOT_OWNER } from './table-storage';

/** The node of a store file at `<folder>/<name>` (one folder deep), or
 *  null: the history (`_snapshots`), the accepted copies, anything else. */
function nodeOneDeep(rel: string, nodeOfName: (name: string) => string | null): string | null {
  const parts = rel.split('/');
  if (parts.length !== 2) return null;
  const [dir, name] = parts as [string, string];
  if (dir.startsWith('_') || dir.startsWith('.') || dir === SNAPSHOT_OWNER) return null;
  return nodeOfName(name);
}

export type StoreSweepOptions = Pick<
  SweepOptions,
  'dryRun' | 'now' | 'graceMs' | 'allowMany' | 'maxRemovals' | 'maxShare'
>;

/** Sweep every revisioned store once. */
export async function sweepStores(opts: StoreSweepOptions = {}): Promise<SweepReport[]> {
  return [
    await sweepOrphans(
      {
        store: 'tables',
        root: tableDbRoot(),
        nodeOf: (rel) => nodeOneDeep(rel, tableFileNode),
        // A draft written before A3b keeps its old name: never removed,
        // reported (A3b fix round 1, L2).
        spare: (rel) => isLegacyDraftName(path.posix.basename(rel)),
        rows: async () => {
          const rows = await db
            .select({ node: tables.nodeId, p: tables.storagePath, d: tables.draftPath })
            .from(tables);
          return rows.map((r) => ({
            node: r.node,
            files: [r.p, r.d].filter((f): f is string => !!f),
          }));
        },
      },
      opts,
    ),
    await sweepOrphans(
      {
        store: 'appdb',
        root: appDbRoot(),
        nodeOf: (rel) => nodeOneDeep(rel, appFileNode),
        // Absolute paths: the sweep compares them with the root as real
        // paths and stops when one is outside it (A3b fix round 1, H3).
        rows: async () => {
          const rows = await db
            .select({ node: appDatabases.appNodeId, p: appDatabases.storagePath })
            .from(appDatabases);
          return rows.map((r) => ({ node: r.node, files: [r.p] }));
        },
      },
      opts,
    ),
  ];
}

/** One line for a maintenance run row. */
export function summariseStoreSweep(reports: SweepReport[], dryRun = false): string {
  const parts = reports.map((r) => {
    if (r.aborted) return `${r.store}: STOPPED, nothing removed (${r.aborted})`;
    const kept = [
      r.noRow.length ? `${r.noRow.length} kept with no row` : '',
      r.rowFileMissing.length ? `${r.rowFileMissing.length} kept (a row's file is missing)` : '',
      r.legacy.length ? `${r.legacy.length} legacy drafts kept` : '',
    ].filter(Boolean);
    return (
      `${r.store}: ${r.removed.length} ${dryRun ? 'would go' : 'removed'}, ${r.marked} newly unreferenced` +
      `${r.failed ? `, ${r.failed} failed` : ''}${kept.length ? `, ${kept.join(', ')}` : ''}`
    );
  });
  return parts.join('; ');
}
