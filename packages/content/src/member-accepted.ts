/**
 * What a member wrote and an admin accepted into the brain (member logins
 * Phase 4, plan 6.2 and 6.3). Accept moves the item out of the member's
 * space, so it leaves Mine; the `space_items` row stays and records the
 * author. From that row the author gets:
 *
 *  - their own list of accepted items, at whatever level the admin chose;
 *  - READ access to each one, the SAVED version only, even at admin: they
 *    can open what they wrote, and an image they wrote, accepted at admin,
 *    still renders in their other drafts;
 *
 * and readers get the authorship: the author's name on an accepted item
 * (the "member-authored" badge).
 *
 * Every function here runs on the ADMIN pool (the item may sit above the
 * author's level, and the limited roles hold no grant on `space_items`), so
 * the rule lives in every query, as in member-review.ts: the row names this
 * login as the author, its state is `accepted`, and the item belongs to this
 * brain. Nothing here writes, and nothing returns a draft.
 */
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import {
  asViewerLevel,
  authUsers,
  currentSpaceScope,
  currentViewerLevel,
  db,
  nodes,
  spaceItems,
  type ViewerLevel,
} from '@mantle/db';
import type { MemberAcceptedItem, MemberAcceptedRow, MemberItemAuthor } from '@mantle/client-types';
import { MEMBER_ITEM_KINDS, type MemberItemKind } from '@mantle/client-types/member-kinds';
import { getDrawSvg } from './draws';
import { getNote } from './notes';
import { getPage } from './pages/read';
import { getTable } from './tables/read';

export type AcceptedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  /** The level the admin chose: at team or below it is in the Library too. */
  audience: ViewerLevel;
  acceptedAt: string | null;
  updatedAt: string;
};

export type AcceptedItem =
  | (AcceptedRow & { type: 'page'; doc: unknown })
  | (AcceptedRow & { type: 'note'; content: string })
  | (AcceptedRow & { type: 'table'; table: NonNullable<Awaited<ReturnType<typeof getTable>>> })
  | (AcceptedRow & { type: 'draw' })
  | (AcceptedRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
    });

/** These queries must see items above the member's level and write their
 *  own rule; inside a viewer or space scope they would see nothing (or the
 *  wrong thing), so refuse to run there. */
function assertAdminPool(): void {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error('member-accepted reads on the admin pool: call it outside a viewer scope');
  }
}

/** The author rule, written in the query: accepted, written by this login,
 *  now in this brain, of a member kind. */
function authoredWhere(anchorId: string, loginId: string) {
  return and(
    eq(spaceItems.authorLoginId, loginId),
    eq(spaceItems.reviewState, 'accepted'),
    eq(nodes.ownerId, anchorId),
    inArray(nodes.type, [...MEMBER_ITEM_KINDS]),
  );
}

type Joined = { node: typeof nodes.$inferSelect; acceptedAt: Date | null };

function rowOf({ node, acceptedAt }: Joined): AcceptedRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    type: node.type as MemberItemKind,
    title: node.title,
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    audience: asViewerLevel(node.audience),
    acceptedAt: acceptedAt?.toISOString() ?? null,
    updatedAt: node.updatedAt.toISOString(),
  };
}

/** The author's accepted items, newest accept first. `q` matches the title. */
export async function listAccepted(
  anchorId: string,
  loginId: string,
  opts: { kind?: MemberItemKind; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: AcceptedRow[]; total: number }> {
  assertAdminPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim();
  const where = and(
    authoredWhere(anchorId, loginId),
    opts.kind ? eq(nodes.type, opts.kind) : undefined,
    q ? ilike(nodes.title, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
  );
  const [rows, [count]] = await Promise.all([
    db
      .select({ node: nodes, acceptedAt: spaceItems.acceptedAt })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .where(where)
      .orderBy(desc(spaceItems.acceptedAt), desc(nodes.updatedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .where(where),
  ]);
  return { items: rows.map(rowOf), total: count?.n ?? 0 };
}

/** The row of an item this login wrote and an admin accepted, or null
 *  (someone else wrote it, it was not accepted, or it left this brain). */
export async function acceptedRow(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<AcceptedRow | null> {
  assertAdminPool();
  const [row] = await db
    .select({ node: nodes, acceptedAt: spaceItems.acceptedAt })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .where(and(eq(spaceItems.nodeId, id), authoredWhere(anchorId, loginId)))
    .limit(1);
  return row ? rowOf(row) : null;
}

/** One accepted item with its SAVED body, for its author only. `tabId` picks
 *  a table's tab. A drawing's picture is its saved SVG (acceptedDrawSvg); a
 *  file's bytes come from the member files route. */
export async function getAcceptedItem(
  anchorId: string,
  loginId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<AcceptedItem | null> {
  const base = await acceptedRow(anchorId, loginId, id);
  if (!base) return null;
  switch (base.type) {
    case 'page': {
      const page = await getPage(anchorId, id);
      // `doc` is the saved version; an admin's working draft stays theirs.
      return page ? { ...base, type: 'page', doc: page.doc } : null;
    }
    case 'note': {
      const note = await getNote(anchorId, id);
      return note ? { ...base, type: 'note', content: note.content } : null;
    }
    case 'table': {
      const table = await getTable(anchorId, id, {
        tabId: opts.tabId,
        unknownTabIsFirst: true,
        publishedOnly: true,
      });
      return table ? { ...base, type: 'table', table } : null;
    }
    case 'draw':
      return { ...base, type: 'draw' };
    case 'file': {
      const [n] = await db
        .select({ data: nodes.data })
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
        .limit(1);
      const d = (n?.data ?? {}) as Record<string, unknown>;
      return {
        ...base,
        type: 'file',
        filename: typeof d.filename === 'string' ? d.filename : base.title,
        mimeType: typeof d.mime_type === 'string' ? d.mime_type : null,
        sizeBytes: Number(d.size_bytes ?? 0) || null,
      };
    }
  }
}

/** An accepted drawing's saved SVG, for its author only. */
export async function acceptedDrawSvg(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<string | null> {
  const row = await acceptedRow(anchorId, loginId, id);
  if (row?.type !== 'draw') return null;
  return getDrawSvg(anchorId, id);
}

/** True when this login wrote this accepted FILE: the member files route
 *  then serves its bytes from the brain. */
export async function isAuthorOfAcceptedFile(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<boolean> {
  const row = await acceptedRow(anchorId, loginId, id);
  return row?.type === 'file';
}

export type AcceptedAuthor = MemberItemAuthor;

// Compile-time locks: what the routes send must fit the published contract.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractLocks: [
  Same<AcceptedRow, MemberAcceptedRow>,
  AcceptedItem extends MemberAcceptedItem ? true : false,
] = [true, true];
void contractLocks;

/**
 * Who wrote each of these brain items, for the ones a member wrote and an
 * admin accepted: the "member-authored" badge. Other items (an admin's own)
 * are left out. Callers pass only ids their reader may already see; this
 * adds the author's name, nothing of the item.
 */
export async function acceptedAuthors(
  anchorId: string,
  ids: readonly string[],
): Promise<Map<string, AcceptedAuthor>> {
  assertAdminPool();
  const out = new Map<string, AcceptedAuthor>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      id: spaceItems.nodeId,
      acceptedAt: spaceItems.acceptedAt,
      loginId: spaceItems.authorLoginId,
      name: authUsers.displayName,
    })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
    .where(
      and(
        inArray(spaceItems.nodeId, [...ids]),
        eq(spaceItems.reviewState, 'accepted'),
        eq(nodes.ownerId, anchorId),
      ),
    );
  for (const r of rows) {
    // A deleted login keeps the badge without a name; never an email here.
    const name = r.loginId ? r.name?.trim() || 'A member' : 'Removed member';
    out.set(r.id, { name, acceptedAt: r.acceptedAt?.toISOString() ?? null });
  }
  return out;
}
