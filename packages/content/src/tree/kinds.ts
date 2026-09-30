/**
 * What the brain adds to a kind's shared spec (@mantle/client-types/tree):
 * which kinds the tree serves yet, and the status-slot token of an item.
 */
import type { TreeKind } from '@mantle/client-types/tree';

/** The kinds the tree serves on this brain. A client offers the tree for
 *  these and keeps its older screen for the rest (the shell lists them). */
export const TREE_LIVE_KINDS: readonly TreeKind[] = ['files'];

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
    default:
      return null;
  }
}
