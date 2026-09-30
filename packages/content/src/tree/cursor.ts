/**
 * The item tree's page cursor: the sort key and id of the last item a page
 * returned, so the next page starts right after it however many items were
 * added or removed in between (keyset paging, never an offset). Opaque to
 * clients: base64url of a small JSON tuple.
 */
import type { TreeSort } from '@mantle/client-types/tree';

export type TreeCursor = { sort: TreeSort; key: string; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // The id is cast to uuid in the page query: a forged one restarts at the
    // top instead of failing the request.
    if (!UUID_RE.test(id)) return null;
    return { sort, key, id };
  } catch {
    return null;
  }
}

/**
 * A member tree's draft cursor (./member-tree): a folder's pages run through
 * the member's drafts at that folder first, then the brain's items. Drafts
 * are few and read whole per call, so this cursor is the number shown so
 * far; the brain's items keep the keyset cursor above.
 */
export function encodeDraftCursor(shown: number): string {
  return Buffer.from(JSON.stringify(['drafts', shown]), 'utf8').toString('base64url');
}

/** The drafts shown so far, or null when `raw` is not a draft cursor. */
export function decodeDraftCursor(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || v[0] !== 'drafts') return null;
    const n = v[1];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
