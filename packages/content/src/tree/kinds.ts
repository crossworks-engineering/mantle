/**
 * What the brain adds to a kind's shared spec (@mantle/client-types/tree):
 * which kinds the tree serves yet, what an item row carries beyond its title,
 * and which of a kind's rows the tree leaves out.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { TreeItemMeta, TreeKind } from '@mantle/client-types/tree';

/** The kinds the tree serves on this brain. A client offers the tree for
 *  these and keeps its older screen for the rest (the shell lists them).
 *  Pages wait for Recall v2 (pages stop nesting). Apps joined in phase 3,
 *  their old layout document moved in by tree/apps-nav.ts. */
export const TREE_LIVE_KINDS: readonly TreeKind[] = [
  'files',
  'notes',
  'draw',
  'tables',
  'formulas',
  'tasks',
  'events',
  'contacts',
  'secrets',
  'apps',
];

export function isTreeLiveKind(kind: TreeKind): boolean {
  return TREE_LIVE_KINDS.includes(kind);
}

/** The short token an item shows in its row's status slot. */
export function itemSubtype(kind: TreeKind, data: Record<string, unknown>): string | null {
  switch (kind) {
    case 'files': {
      const ext = data.extension;
      return typeof ext === 'string' && ext ? ext.toLowerCase() : null;
    }
    case 'secrets': {
      const k = data.kind;
      return typeof k === 'string' && k ? k : null;
    }
    default:
      return null;
  }
}

const iso = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** What a row draws beyond its title: a task's done box and due date, an
 *  event's start. Undefined for kinds without any. */
export function itemMeta(kind: TreeKind, data: Record<string, unknown>): TreeItemMeta | undefined {
  switch (kind) {
    case 'tasks':
      return { done: data.status === 'done', due: iso(data.due_at) };
    case 'events':
      return { start: iso(data.starts_at) };
    default:
      return undefined;
  }
}

/**
 * The part of a kind's rows the tree leaves out, as a SQL condition on the
 * item alias (`and ...`, or nothing). Archived tasks are filed away: the
 * task screen's own Archived view is where they are found.
 */
export function kindItemFilter(kind: TreeKind, alias: string): SQL {
  if (kind === 'tasks') return sql`and ${sql.raw(alias)}.data->>'archived_at' is null`;
  return sql``;
}
