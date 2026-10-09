/**
 * "Shared by members" for pages, notes, tables, draws and files (workspace
 * review pattern, Jason 2026-10-09, option 1: admins see what the team
 * shares). An admin reads exactly what a member of the team reads of another
 * member's items: the team-drafts reads (member-space.ts), run on the team
 * role with the human flag on (`withTeamDrafts`), so row security decides
 * and a private item is a plain "not found". The admin reads the SAVED
 * version, never the author's working draft.
 *
 * ONE rule picks what an admin may reach here (`eligible`, on the admin
 * pool, before the team-level read confirms it): an item kind in the
 * personal space of an ACTIVE MEMBER (role member, not deactivated), shared
 * with the team, in draft or returned. So never a submitted item (it waits
 * in "Waiting for approval"), never an accepted or taken one, never a
 * deactivated or deleted author's item (it is "left behind" and waits in the
 * review queue for Approve or Discard), never a client's item (client items
 * are client requests, and the team-drafts rule is member-only too). The
 * list, the item, its bytes and SVG, and Unshare all apply it.
 *
 * One admin act: Unshare (back to private, nothing deleted), a guarded
 * update of the state row under the same rule.
 *
 * Cost-safety: nothing here starts LLM work.
 */
import { and, desc, eq, inArray, isNull, type Column, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { asSystem, authUsers, db, nodes, spaceItems, spaces, withTeamDrafts } from '@mantle/db';
import {
  SPACE_ITEM_KINDS,
  getTeamDraftDrawSvg,
  getTeamDraftItem,
  listTeamDrafts,
  openTeamDraftFile,
  type SpaceItemBody,
  type SpaceItemKind,
  type SpaceItemRow,
} from './member-space';
import type { OpenedSpaceFile } from './member-space-files';
import { notifySpaceItemChanged } from './member-space-events';
import { walkBundle } from './member-bundle';

/** The author as the section shows them. Only active members are listed,
 *  so `active` is true on every row; it stays in the shape for the client. */
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

/** The review states a shared item may be in to be read here. */
const SHARED_STATES = ['draft', 'returned'] as const;

/** The one rule (see the module comment). Needs `spaceItems`, `spaces` and
 *  the author's login `u` (on the space's login) joined to `nodes`. */
const ruleFor = (u: { role: Column; disabledAt: Column }): SQL =>
  and(
    inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    eq(spaces.kind, 'personal'),
    eq(spaceItems.sharing, 'team'),
    inArray(spaceItems.reviewState, [...SHARED_STATES]),
    eq(u.role, 'member'),
    isNull(u.disabledAt),
  )!;
const eligibleRule = ruleFor(authUsers);

/** The author's login under an unqualified name: a locking clause (FOR
 *  SHARE OF) takes no schema-qualified table. */
const author = alias(authUsers, 'author');

type Eligible = {
  id: string;
  type: SpaceItemKind;
  spaceId: string;
  author: SharedItemAuthor;
};

/** The items the rule allows, newest change first, on the admin pool. */
async function eligible(where: SQL | undefined, limit: number): Promise<Eligible[]> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        type: nodes.type,
        spaceId: nodes.ownerId,
        loginId: authUsers.id,
        email: authUsers.email,
        displayName: authUsers.displayName,
      })
      .from(nodes)
      .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .innerJoin(authUsers, eq(authUsers.id, spaces.loginId))
      .where(and(eligibleRule, where))
      .orderBy(desc(nodes.updatedAt), desc(nodes.id))
      .limit(limit),
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type as SpaceItemKind,
    spaceId: r.spaceId,
    author: {
      loginId: r.loginId,
      name: r.displayName?.trim() || r.email.split('@')[0] || null,
      active: true,
    },
  }));
}

/** One item, when the rule allows it; null otherwise. */
async function eligibleOne(id: string): Promise<Eligible | null> {
  const [one] = await eligible(eq(nodes.id, id), 1);
  return one ?? null;
}

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
 * kind (or every item kind). The rule picks the ids (and the cap applies to
 * them), then the team-level read confirms each and gives its row.
 * `adminLoginId` only fills the team-drafts "not the caller's own" rule: an
 * admin has no member space.
 */
export async function listMemberItemsShared(
  adminLoginId: string,
  kind?: SpaceItemKind,
): Promise<SharedMemberItem[]> {
  const picked = await eligible(kind ? eq(nodes.type, kind) : undefined, SHARED_ITEMS_MAX);
  if (!picked.length) return [];
  const { items } = await withTeamDrafts(() =>
    listTeamDrafts(adminLoginId, {
      kind,
      ids: picked.map((p) => p.id),
      reviewStates: [...SHARED_STATES],
      limit: SHARED_ITEMS_MAX,
    }),
  );
  const authorOf = new Map(picked.map((p) => [p.id, p.author]));
  return items.flatMap((i) => {
    const author = authorOf.get(i.id);
    return author ? [toShared(i, author)] : [];
  });
}

/** One team-shared item with its SAVED body and its author; null when the
 *  rule does not allow it (a private item looks like a missing one). */
export async function getMemberItemShared(
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody; author: SharedItemAuthor } | null> {
  const ok = await eligibleOne(id);
  if (!ok) return null;
  const got = await withTeamDrafts(() => getTeamDraftItem(id, opts));
  return got ? { ...got, author: ok.author } : null;
}

/**
 * Whether `node` may be served as part of the shared item `id`: the item
 * itself, or an item it embeds (its bundle, walked over the SAVED versions,
 * items that are themselves shared or submitted only). The item must pass
 * the rule; the team-level read of `node` then decides the rest.
 */
async function servesWith(id: string, node: string): Promise<boolean> {
  const item = await eligibleOne(id);
  if (!item) return false;
  if (node === id) return true;
  const walk = await asSystem(() =>
    walkBundle(db, item.spaceId, { id, type: item.type, title: '' }, { sharedOnly: true }),
  ).catch(() => null);
  return !!walk?.items.some((i) => i.id === node);
}

/** The bytes of a shared item's file: the item itself, or a file its page
 *  shows (only one that is itself shared with the team). */
export async function openMemberFileShared(
  id: string,
  node: string = id,
): Promise<OpenedSpaceFile | null> {
  if (!(await servesWith(id, node))) return null;
  return withTeamDrafts(() => openTeamDraftFile(node));
}

/** A shared item's drawing as saved SVG: the item, or a drawing its page
 *  shows (only one that is itself shared with the team). */
export async function memberDrawSvgShared(id: string, node: string = id): Promise<string | null> {
  if (!(await servesWith(id, node))) return null;
  return withTeamDrafts(() => getTeamDraftDrawSvg(node));
}

/** What an Unshare changed, for the audit trail. */
export type UnsharedItem = { id: string; type: SpaceItemKind; authorLoginId: string | null };

/**
 * Unshare a member's team-shared item: back to private, nothing deleted.
 * Only what the rule allows (an active member's draft or returned item), so
 * a left-behind item stays in the review queue and a submitted one stays
 * waiting. One guarded update: the state row's lock re-checks the sharing
 * and the state, so a Submit that lands first wins, and the author's row is
 * held FOR SHARE, so a deactivation cannot land between the check and the
 * write. Null when there was
 * nothing to unshare (a private item answers exactly like a missing one).
 */
export async function adminUnshareMemberItem(id: string): Promise<UnsharedItem | null> {
  const item = await eligibleOne(id);
  if (!item) return null;
  const changed = await asSystem(() =>
    db
      .update(spaceItems)
      .set({ sharing: 'private', updatedAt: new Date() })
      .where(
        and(
          eq(spaceItems.nodeId, id),
          eq(spaceItems.sharing, 'team'),
          inArray(spaceItems.reviewState, [...SHARED_STATES]),
          inArray(
            spaceItems.nodeId,
            db
              .select({ id: nodes.id })
              .from(nodes)
              .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
              .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
              .innerJoin(author, eq(author.id, spaces.loginId))
              .where(and(eq(nodes.id, id), ruleFor(author)))
              // The author's row is held while the update runs: a parallel
              // deactivation waits, or (landing first) is seen, and then the
              // item is left behind and not unshared.
              .for('share', { of: author }),
          ),
        ),
      )
      .returning({ id: spaceItems.nodeId }),
  );
  if (!changed.length) return null;
  // It WAS shared: teammates' lists drop it too.
  await asSystem(() => notifySpaceItemChanged(id, 'state', { spaceId: item.spaceId, team: true }));
  return { id, type: item.type, authorLoginId: item.author.loginId };
}
