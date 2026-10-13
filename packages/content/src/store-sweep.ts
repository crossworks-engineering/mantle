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
 * nothing while a restore's hold is in place (held, not a failure), and
 * nothing at all when a hard stop trips (a row outside the root, no row
 * naming any file, a row back on an older revision). Plain files
 * and one read of the rows: no model, no extraction, no notify. Run by the
 * maintenance worker (`store-sweep`) and `pnpm store:sweep`.
 *
 * Server-only (node:fs).
 */
import path from 'node:path';
import {
  forgetTombstones,
  isLegacyDraftName,
  revisionNode,
  storeRows,
  storeTombstones,
  sweepOrphans,
  type RevisionStore,
  type SweepOptions,
  type SweepReport,
  type SweepSpec,
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

const SNAPSHOT_FILE =
  /^[^/]+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sqlite$/;

/**
 * The snapshot store's three folders (A3b part 2): an app's history
 * (APP_DB_DIR/_snapshots), a table's (TABLE_DB_DIR/_snapshots), and the
 * accepted tables' workbook copies (TABLE_DB_DIR/accepted-snapshots). A
 * snapshot's item is its row (`<owner>/<item>/<snapshot id>.sqlite`), an
 * accepted copy's the table (`<table>.r-<token>.sqlite`). Their rows'
 * paths are relative to the store root they sit in (`base`); a restore's
 * hold is that root's. A file goes when a tombstone says the row that
 * named it went (0284), or (an accepted copy) when it is an old revision
 * of a table whose row names another; a file with neither a row nor a
 * tombstone is only reported.
 */
export function snapshotSweepSpecs(): SweepSpec[] {
  const roots = storeRoots();
  const part = (
    label: 'appsnap' | 'tablesnap' | 'accepted',
    base: string,
    folder: string,
    nodeOf: (rel: string) => string | null,
  ): SweepSpec => {
    const stored = new Map<string, string>();
    return {
      store: 'snapshots',
      label,
      root: path.join(base, folder),
      holdRoot: base,
      nodeOf,
      pruneEmptyDirs: label !== 'accepted',
      // Files from before 0284 whose rows are all gone are reported, never
      // a nightly failure (fix round 1, L9).
      stopWhenNoRows: false,
      rows: async () =>
        (await storeRows(label)).map((r) => ({
          ...r,
          files: r.files.map((f) => path.resolve(base, f)),
          columns: r.columns?.map((f) => (f ? path.resolve(base, f) : null)),
        })),
      tombstones: async () =>
        (await storeTombstones(label)).map((t) => {
          const abs = path.resolve(base, t.path);
          stored.set(abs, t.path);
          return { abs, ageMs: t.ageMs };
        }),
      forget: (abs) =>
        forgetTombstones(
          label,
          abs.map((a) => stored.get(a)).filter((p): p is string => p !== undefined),
        ),
    };
  };
  const snapshotOf = (rel: string) => SNAPSHOT_FILE.exec(rel)?.[1] ?? null;
  return [
    part('appsnap', roots.appdb, '_snapshots', snapshotOf),
    part('tablesnap', roots.tables, '_snapshots', snapshotOf),
    part('accepted', roots.tables, SNAPSHOT_OWNER, (rel) =>
      rel.includes('/') || rel.endsWith('.draft.sqlite') ? null : revisionNode(rel, 'tables'),
    ),
  ];
}

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
  for (const spec of snapshotSweepSpecs()) out.push(await sweepOrphans(spec, opts));
  return out;
}

/** One line for a maintenance run row. */
export function summariseStoreSweep(reports: SweepReport[], dryRun = false): string {
  const parts = reports.map((r) => {
    if (r.aborted) return `${r.label}: STOPPED, nothing removed (${r.aborted})`;
    if (r.held) return `${r.label}: HELD until ${r.held} by a restore, nothing removed`;
    const kept = [
      r.deferred ? `${r.deferred} deferred to the next run` : '',
      r.noRow.length ? `${r.noRow.length} kept with no row` : '',
      r.rowFileMissing.length ? `${r.rowFileMissing.length} kept (a row's file is missing)` : '',
      r.legacy.length ? `${r.legacy.length} legacy drafts kept` : '',
    ].filter(Boolean);
    return (
      `${r.label}: ${r.removed.length} ${dryRun ? 'would go' : 'removed'}, ${r.marked} newly unreferenced` +
      `${r.failed ? `, ${r.failed} failed` : ''}${kept.length ? `, ${kept.join(', ')}` : ''}`
    );
  });
  return parts.join('; ');
}
