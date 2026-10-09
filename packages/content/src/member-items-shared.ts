/**
 * "Shared by members" for pages, notes, tables, draws and files (workspace
 * review pattern, Jason 2026-10-09, option 1: admins see what the team
 * shares). An admin reads exactly what a member of the team reads of another
 * member's items: the team-drafts reads (member-space.ts), run on the team
 * role with the human flag on (`withTeamDrafts`), so row security decides
 * and a private item is a plain "not found". The admin reads the SAVED
 * version, never the author's working draft.
 *
 * Listed: team-shared items of ACTIVE members, not submitted (those wait in
 * "Waiting for approval"), not accepted or taken. A deactivated or deleted
 * author's team-shared item is "left behind" and waits in the review queue
 * (member-review.ts) for Approve or Discard instead.
 *
 * One admin act: Unshare (back to private, nothing deleted), a guarded
 * update of the state row, the same shape as the apps' `adminUnshareSpaceApp`.
 *
 * Cost-safety: nothing here starts LLM work.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { asSystem, authUsers, db, nodes, spaceItems, spaces, withTeamDrafts } from '@mantle/db';
import { SPACE_ITEM_KINDS, type SpaceItemBody, type SpaceItemKind } from './member-space';
import {
  getTeamDraftDrawSvg,
  getTeamDraftItem,
  listTeamDrafts,
  openTeamDraftFile,
} from './member-space';
import type { SpaceItemRow } from './member-space';
import type { OpenedSpaceFile } from './member-space-files';
import { notifySpaceItemChanged } from './member-space-events';

/** The author as the section shows them: active means signed in may still
 *  happen (not deactivated, still a member or client). */
export type SharedItemAuthor = { loginId: string | null; name: string | null; active: boolean };

/** One row of "Shared by members". */
export type SharedMemberItem = {
  id: string;
  type: SpaceItemKind;
  title: string;
  icon: string | null;
  author: SharedItemAuthor;
  updatedAt: string;
};

/** At most this many rows: the section is a glance, the author's own list
 *  holds the rest. */
export const SHARED_ITEMS_MAX = 200;

/** The authors of `ids`, read at admin (the list itself was read at team). */
async function authorsOf(ids: readonly (string | null)[]): Promise<Map<string, SharedItemAuthor>> {
  const want = [...new Set(ids.filter((i): i is string => !!i))];
  if (!want.length) return new Map();
  const rows = await asSystem(() =>
    db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        displayName: authUsers.displayName,
        disabledAt: authUsers.disabledAt,
        role: authUsers.role,
      })
      .from(authUsers)
      .where(inArray(authUsers.id, want)),
  );
  return new Map(
    rows.map((u) => [
      u.id,
      {
        loginId: u.id,
        name: u.displayName?.trim() || u.email.split('@')[0] || null,
        active: u.disabledAt === null && (u.role === 'member' || u.role === 'client'),
      },
    ]),
  );
}

const goneAuthor = (loginId: string | null): SharedItemAuthor => ({
  loginId,
  name: null,
  active: false,
});

function toShared(row: SpaceItemRow, author: SharedItemAuthor): SharedMemberItem {
  return {
    id: row.id,
    type: row.type as SpaceItemKind,
    title: row.title,
    icon: row.icon,
    author,
    updatedAt: row.updatedAt,
  };
}

/**
 * The team-shared items of active members, newest change first, for one
 * kind (or every item kind). `adminLoginId` only fills the team-drafts
 * "not the caller's own" rule: an admin has no member space.
 */
export async function listMemberItemsShared(
  adminLoginId: string,
  kind?: SpaceItemKind,
): Promise<SharedMemberItem[]> {
  const { items } = await withTeamDrafts(() =>
    listTeamDrafts(adminLoginId, {
      kind,
      // Not submitted (Waiting for approval lists it), not accepted or taken.
      reviewStates: ['draft', 'returned'],
      limit: SHARED_ITEMS_MAX,
    }),
  );
  const authors = await authorsOf(items.map((i) => i.authorLoginId));
  return items
    .map((i) => toShared(i, authors.get(i.authorLoginId ?? '') ?? goneAuthor(i.authorLoginId)))
    .filter((i) => i.author.active);
}

/** One team-shared item with its SAVED body and its author; null when it is
 *  not shared with the team (a private item looks like a missing one), or
 *  its author is not active (it waits in the review queue then). */
export async function getMemberItemShared(
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody; author: SharedItemAuthor } | null> {
  const got = await withTeamDrafts(() => getTeamDraftItem(id, opts));
  if (!got) return null;
  const author = (await authorsOf([got.row.authorLoginId])).get(got.row.authorLoginId ?? '');
  if (!author?.active) return null;
  return { ...got, author };
}

/** The bytes of a team-shared file: the item itself, or a file its page
 *  shows (only one that is itself shared with the team). */
export function openMemberFileShared(fileId: string): Promise<OpenedSpaceFile | null> {
  return withTeamDrafts(() => openTeamDraftFile(fileId));
}

/** A team-shared drawing's saved SVG (the item, or one its page shows). */
export function memberDrawSvgShared(drawId: string): Promise<string | null> {
  return withTeamDrafts(() => getTeamDraftDrawSvg(drawId));
}

/**
 * Unshare a member's team-shared item: back to private, nothing deleted.
 * Only an item in a personal space of a member or client login (never an
 * admin's own), shared with the team, of an item kind, not accepted or
 * taken. One guarded update; false when there was nothing to unshare (a
 * private item answers exactly like a missing one).
 */
export async function adminUnshareMemberItem(id: string): Promise<boolean> {
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({ sharing: 'private', updatedAt: new Date() })
      .where(
        and(
          eq(spaceItems.nodeId, id),
          eq(spaceItems.sharing, 'team'),
          sql`${spaceItems.reviewState} not in ('accepted', 'taken')`,
          inArray(
            spaceItems.nodeId,
            db
              .select({ id: nodes.id })
              .from(nodes)
              .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
              .leftJoin(authUsers, eq(authUsers.id, spaces.loginId))
              .where(
                and(
                  eq(nodes.id, id),
                  inArray(nodes.type, [...SPACE_ITEM_KINDS]),
                  eq(spaces.kind, 'personal'),
                  // A member's or client's space, or one whose login is gone.
                  sql`(${isNull(authUsers.id)} or ${authUsers.role} in ('member', 'client'))`,
                ),
              ),
          ),
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!changed.length) return false;
  // It WAS shared: teammates' lists drop it too.
  const [n] = await asSystem(() =>
    db.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, id)).limit(1),
  );
  if (n)
    await asSystem(() => notifySpaceItemChanged(id, 'state', { spaceId: n.ownerId, team: true }));
  return true;
}
