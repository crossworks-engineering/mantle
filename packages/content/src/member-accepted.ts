/**
 * What a member wrote and an admin accepted into the brain (member logins
 * Phase 4, plan 6.2 and 6.3). Accept moves the item out of the member's
 * space, so it leaves Mine; the `space_items` row stays and records the
 * author. From that row the author gets:
 *
 *  - their own list of accepted items, at whatever level the admin chose;
 *  - READ access to each one, even at admin: the version ACCEPTED, from the
 *    snapshot taken at Accept (member-snapshots.ts, audit F07), never the
 *    brain's current version, so an admin's later edits stay the brain's;
 *  - an image they wrote, accepted at admin, still renders in their other
 *    drafts, but only while the brain file still has the bytes accepted
 *    (`acceptedFileReadable`); once an admin changed it the item answers
 *    its accepted metadata with `changedByAdmin: true` and no bytes;
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
  acceptedSnapshots,
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
import { tableFromSnapshot, type getTable } from './tables/read';
import {
  acceptedDrawUnchanged,
  acceptedFileUnchanged,
  snapshotOf,
  type AcceptedSnapshot,
} from './member-snapshots';

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
  | (AcceptedRow & { type: 'draw'; changedByAdmin?: boolean })
  | (AcceptedRow & {
      type: 'file';
      filename: string;
      mimeType: string | null;
      sizeBytes: number | null;
      /** An admin changed the brain file since: its bytes are not served. */
      changedByAdmin?: boolean;
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

type Joined = {
  node: typeof nodes.$inferSelect;
  acceptedAt: Date | null;
  snapTitle?: string | null;
  snapIcon?: string | null;
  snapAt?: Date | null;
};

/** The row as accepted: the snapshot's title, icon and time when there is
 *  one (an admin's later rename is the brain's), the level as it is now. */
function rowOf({ node, acceptedAt, snapTitle, snapIcon, snapAt }: Joined): AcceptedRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const icon = snapTitle != null ? snapIcon : d.icon;
  return {
    id: node.id,
    type: node.type as MemberItemKind,
    title: snapTitle ?? node.title,
    icon: typeof icon === 'string' && icon.trim() ? icon : null,
    audience: asViewerLevel(node.audience),
    acceptedAt: acceptedAt?.toISOString() ?? null,
    updatedAt: (snapAt ?? node.updatedAt).toISOString(),
  };
}

const snapCols = {
  snapTitle: acceptedSnapshots.title,
  snapIcon: acceptedSnapshots.icon,
  snapAt: acceptedSnapshots.acceptedAt,
};

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
      .select({ node: nodes, acceptedAt: spaceItems.acceptedAt, ...snapCols })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, nodes.id))
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
    .select({ node: nodes, acceptedAt: spaceItems.acceptedAt, ...snapCols })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, nodes.id))
    .where(and(eq(spaceItems.nodeId, id), authoredWhere(anchorId, loginId)))
    .limit(1);
  return row ? rowOf(row) : null;
}

/** The author rule, then the item's snapshot (completed first when it is
 *  pending or missing). Null when the rule does not hold. */
async function authoredSnapshot(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<{ row: AcceptedRow; snap: AcceptedSnapshot } | null> {
  const row = await acceptedRow(anchorId, loginId, id);
  if (!row) return null;
  const snap = await snapshotOf(anchorId, id);
  if (!snap) return null;
  // The row as accepted (a snapshot completed just now had no title yet).
  return { row: { ...row, title: snap.title, icon: snap.icon ?? null }, snap };
}

/** One accepted item as ACCEPTED (its snapshot, never the brain's current
 *  version), for its author only. `tabId` picks a table's tab. A drawing's
 *  picture is its accepted SVG (acceptedDrawSvg); a file's bytes come from
 *  the member files route while they are unchanged, and `changedByAdmin`
 *  says when they are not. */
export async function getAcceptedItem(
  anchorId: string,
  loginId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<AcceptedItem | null> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (!found) return null;
  const { row: base, snap } = found;
  switch (base.type) {
    case 'page':
      return { ...base, type: 'page', doc: snap.doc };
    case 'note':
      return { ...base, type: 'note', content: snap.content ?? '' };
    case 'table': {
      const [node] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
        .limit(1);
      if (!node) return null;
      const table = tableFromSnapshot(
        { ...node, title: snap.title },
        { storagePath: snap.tablePath, doc: snap.tableDoc },
        { tabId: opts.tabId },
      );
      return { ...base, type: 'table', table };
    }
    case 'draw': {
      const changed = !snap.sceneSvg && !(await acceptedDrawUnchanged(anchorId, id, snap));
      return { ...base, type: 'draw', ...(changed ? { changedByAdmin: true } : {}) };
    }
    case 'file': {
      const changed = !(await acceptedFileUnchanged(anchorId, id, snap));
      return {
        ...base,
        type: 'file',
        filename: snap.fileName ?? base.title,
        mimeType: snap.fileMime,
        sizeBytes: snap.fileSize,
        ...(changed ? { changedByAdmin: true } : {}),
      };
    }
  }
}

/** An accepted drawing's picture as accepted, for its author only: the SVG
 *  saved with the snapshot, and the image refs it was drawn with. A drawing
 *  accepted with no saved SVG shows the brain's SVG only while the drawing
 *  is still at the accepted version. */
export async function acceptedDrawSnapshot(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<{ svg: string; fileRefs: Record<string, unknown> } | null> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (found?.row.type !== 'draw') return null;
  const { snap } = found;
  const refs = (snap.fileRefs ?? {}) as Record<string, unknown>;
  if (snap.sceneSvg) return { svg: snap.sceneSvg, fileRefs: refs };
  if (!(await acceptedDrawUnchanged(anchorId, id, snap))) return null;
  const svg = await getDrawSvg(anchorId, id);
  return svg ? { svg, fileRefs: refs } : null;
}

/** An accepted drawing's accepted SVG, for its author only. */
export async function acceptedDrawSvg(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<string | null> {
  return (await acceptedDrawSnapshot(anchorId, loginId, id))?.svg ?? null;
}

/** True when this login wrote this accepted FILE (whatever an admin did to
 *  it since): an image of theirs inside their own accepted drawing's SVG. */
export async function isAuthorOfAcceptedFile(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<boolean> {
  const row = await acceptedRow(anchorId, loginId, id);
  return row?.type === 'file';
}

/** True when this login wrote this accepted FILE and the brain file still
 *  holds exactly the bytes accepted (audit F07): the member files route may
 *  then serve them from the brain. Once an admin changed it, false. */
export async function acceptedFileReadable(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<boolean> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (found?.row.type !== 'file') return false;
  return acceptedFileUnchanged(anchorId, id, found.snap);
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
