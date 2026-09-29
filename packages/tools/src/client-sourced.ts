/**
 * Client-sourced text and the lowering guard (client logins C4, plan section
 * 8, review 1 R12, review 2 N18).
 *
 * Text a CLIENT wrote reaches staff agents: a client request (a task,
 * `data.source = 'client-request'`) and a client login's chat thread (read by
 * `team_chat_read`). An instruction hidden in it ("make the pricing page
 * public") could steer a staff agent. Fencing it as data helps, but it does
 * not stop an obedient model, so the one class of act that would hand brain
 * content OUT to clients or the public is gated instead: in a turn that has
 * read client-sourced text, a lowering to client or public goes to pending
 * approval (/pending) instead of running.
 *
 * "Read" is decided by ids: every tool call's input and output, and the
 * retrieval context of the turn, are scanned for uuids, and one query asks
 * whether any names a client request task, a client login or an item a
 * client wrote (client logins C5). Tools name the
 * items they return by id, so text that reaches the model from a client
 * request carries its id with it. A false positive only costs a click on
 * /pending; a missed read would cost the guard, so the scan errs wide.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { authUsers, CLIENT_REQUEST_SOURCE, db, nodes, spaceItems } from '@mantle/db';
import { asSystem } from '@mantle/db/viewer';

/** A turn's taint, shared by reference across the turn (and its delegated
 *  children: a child that reads client text taints the parent too). */
export type TurnTaint = {
  /** The turn has read text a client wrote. */
  clientSourced: boolean;
  /** What tainted it first, for the pending card and the trace. */
  via?: string;
};

export function newTurnTaint(): TurnTaint {
  return { clientSourced: false };
}

const UUID_G = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** The most ids one scan checks (a huge result is truncated, not skipped). */
const MAX_IDS = 500;

/** The distinct uuids in `text`, lower-cased, at most MAX_IDS. */
export function uuidsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(UUID_G)) {
    out.add(m[0].toLowerCase());
    if (out.size >= MAX_IDS) break;
  }
  return [...out];
}

/**
 * Whether any of `ids` names client-sourced text: a client request task of
 * this brain, a client login (its chat thread), or an item a client wrote
 * (client logins C5): a `space_items` row stamped `author_role` 'client',
 * in any state (submitted, taken over, accepted into the brain). The stamp
 * outlives the client login, so an item accepted from a client's space still
 * counts after that login is deleted. As the system: the tasks
 * are admin level and the check must see them whatever the turn's level. It
 * answers yes or no and returns no content.
 */
export async function namesClientSourced(
  ownerId: string,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return false;
  const list = [...ids];
  return asSystem(async () => {
    const [task] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          inArray(nodes.id, list),
          sql`${nodes.data}->>'source' = ${CLIENT_REQUEST_SOURCE}`,
        ),
      )
      .limit(1);
    if (task) return true;
    const [login] = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(and(inArray(authUsers.id, list), eq(authUsers.role, 'client')))
      .limit(1);
    if (login) return true;
    const [written] = await db
      .select({ id: spaceItems.nodeId })
      .from(spaceItems)
      .where(and(inArray(spaceItems.nodeId, list), eq(spaceItems.authorRole, 'client')))
      .limit(1);
    return !!written;
  });
}

/** Mark `taint` when `text` names client-sourced text. Never throws: a failed
 *  check marks the turn (fail closed: approval instead of a silent pass). */
export async function taintFromText(
  taint: TurnTaint,
  ownerId: string,
  text: string,
  via: string,
): Promise<void> {
  if (taint.clientSourced) return;
  const ids = uuidsIn(text);
  if (ids.length === 0) return;
  let hit: boolean;
  try {
    hit = await namesClientSourced(ownerId, ids);
  } catch {
    hit = true;
  }
  if (hit) {
    taint.clientSourced = true;
    taint.via = via;
  }
}

/** The tools that can hand brain content to clients or the public. */
export const LOWERING_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'access_set',
  'node_share',
  'page_share',
  'email_page',
]);

/**
 * Whether this call would lower something to client or public: `access_set`
 * to client or public (an item, an agent or a tool group), any share link
 * (public by construction), and `email_page` with a link.
 */
export function isLoweringCall(slug: string, input: Record<string, unknown>): boolean {
  switch (slug) {
    case 'access_set':
      return input.level === 'client' || input.level === 'public';
    case 'node_share':
    case 'page_share':
      return true;
    case 'email_page':
      return input.includeLink === true || input.includeLink === 'true';
    default:
      return false;
  }
}
