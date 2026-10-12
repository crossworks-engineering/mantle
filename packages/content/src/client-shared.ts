/**
 * Which items a CLIENT login may read, by id, in the client's own scope
 * (`withViewer({ login })`): row security shows the items the
 * login's workspaces hold (W5b2: their grants; brain items have no level),
 * so there is no access filter here to get wrong. A client's drawing images
 * (client-draw-images.ts) and its accepted items (member-accepted.ts) ask
 * here. "Shared with you", the client portal's reads, was removed in
 * workspaces W5c.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { currentScope, db, nodes } from '@mantle/db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refuse to run anywhere but a plain client scope: at any other level the
 *  "readable" answer would be someone else's. */
function assertClient(): void {
  if (currentScope().kind !== 'user') {
    throw new Error("client read outside withViewer({ login })");
  }
}

/** The items among `ids` a client may read, with their current titles:
 *  items of this brain a workspace of the client login holds (W5b2: its
 *  grants, which row security applies; brain items have no level). Keys
 *  lower-case. */
export async function clientReadable(
  anchorId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  assertClient();
  const wanted = [...new Set(ids.filter((i) => UUID.test(i)).map((i) => i.toLowerCase()))];
  if (!wanted.length) return new Map();
  const rows = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.ownerId, anchorId), inArray(nodes.id, wanted)));
  return new Map(rows.map((r) => [r.id.toLowerCase(), r.title]));
}

/** The ids among `ids` a client may read (`clientReadable`'s keys). */
export async function clientReadableIds(
  anchorId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  return new Set((await clientReadable(anchorId, ids)).keys());
}
