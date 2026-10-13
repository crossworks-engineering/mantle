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
 * runs a grace period apart, at most a budget per run (the rest carried),
 * and nothing at all when a guard trips (a restore's hold, a row outside
 * the root, no row naming any file). Plain files
 * and one read of the rows: no model, no extraction, no notify. Run by the
 * maintenance worker (`store-sweep`) and `pnpm store:sweep`.
 *
 * Server-only (node:fs).
 */
import path from 'node:path';
import {
  isLegacyDraftName,
  revisionNode,
  storeRows,
  sweepOrphans,
  type RevisionStore,
  type SweepOptions,
  type SweepReport,
} from '@mantle/db';
import { tableDbRoot } from '@mantle/tabledb';
import { appDbRoot } from './app-broker';
import { SNAPSHOT_OWNER } from './table-storage';

/** The node of a store file at `<folder>/<name>` (one folder deep), or
 *  null: the history (`_snapshots`), the accepted copies, anything else. */
function nodeOneDeep(rel: string, store: RevisionStore): string | null {
  const parts = rel.split('/');
  if (parts.length !== 2) return null;
  const [dir, name] = parts as [string, string];
  if (dir.startsWith('_') || dir.startsWith('.') || dir === SNAPSHOT_OWNER) return null;
  return revisionNode(name, store);
}

/** The roots of the revisioned stores. */
export function storeRoots(): Record<RevisionStore, string> {
  return { tables: tableDbRoot(), appdb: appDbRoot() };
}

export type StoreSweepOptions = Pick<
  SweepOptions,
  'dryRun' | 'now' | 'graceMs' | 'allowMany' | 'budget'
>;

/** Sweep every revisioned store once: the files each names come from the
 *  one spec of which columns name them (STORE_FILE_COLUMNS, storeRows). */
export async function sweepStores(opts: StoreSweepOptions = {}): Promise<SweepReport[]> {
  const roots = storeRoots();
  const out: SweepReport[] = [];
  for (const store of ['tables', 'appdb'] as const) {
    out.push(
      await sweepOrphans(
        {
          store,
          root: roots[store],
          nodeOf: (rel) => nodeOneDeep(rel, store),
          // A table draft written before A3b keeps its old name: never
          // removed, reported (A3b fix round 1, L2).
          spare:
            store === 'tables' ? (rel) => isLegacyDraftName(path.posix.basename(rel)) : undefined,
          // A table's paths are relative, an app database's absolute: the
          // sweep compares them with the root as real paths and stops when
          // one is outside it (A3b fix round 1, H3).
          rows: () => storeRows(store),
        },
        opts,
      ),
    );
  }
  return out;
}

/** One line for a maintenance run row. */
export function summariseStoreSweep(reports: SweepReport[], dryRun = false): string {
  const parts = reports.map((r) => {
    if (r.aborted) return `${r.store}: STOPPED, nothing removed (${r.aborted})`;
    const kept = [
      r.deferred ? `${r.deferred} deferred to the next run` : '',
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
