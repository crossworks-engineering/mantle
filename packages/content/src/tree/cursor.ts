/**
 * The item tree's page cursor: the sort key and id of the last item a page
 * returned, so the next page starts right after it however many items were
 * added or removed in between (keyset paging, never an offset). Opaque to
 * clients: base64url of a small JSON tuple.
 */
import type { TreeSort } from '@mantle/client-types/tree';

export type TreeCursor = { sort: TreeSort; key: string; id: string };

export function encodeTreeCursor(c: TreeCursor): string {
  return Buffer.from(JSON.stringify([c.sort, c.key, c.id]), 'utf8').toString('base64url');
}

/** The cursor, or null when it is missing, malformed or for another sort (a
 *  stale cursor after the reader switched sort restarts at the top). */
export function decodeTreeCursor(
  raw: string | null | undefined,
  sort: TreeSort,
): TreeCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 3) return null;
    const [s, key, id] = v as unknown[];
    if (s !== sort || typeof key !== 'string' || typeof id !== 'string') return null;
    return { sort, key, id };
  } catch {
    return null;
  }
}
