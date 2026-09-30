/**
 * The admin side of personal spaces (member logins Phase 4, plan v3.1
 * section 6): read a submitted item, talk about it, Accept it into the brain
 * or Return it with a note; and the items a deactivated login left behind
 * (plan 6.4: offered to an admin, accept or discard).
 *
 * What an admin may see of a space is exactly this (Jason 2026-09-26, S3:
 * admins never see a member's private items):
 *  - an item SUBMITTED for review (the author sent it to the admins), and
 *  - a TEAM-SHARED item of a login that is deactivated or gone (the team
 *    could already read it).
 * Every read and write here names that condition in its own query
 * (`reviewable`), so an id of a private item answers exactly like an id that
 * does not exist. The admin pool bypasses row security, which is why the
 * condition lives in the query and not in a policy.
 *
 * Accept is one transaction per bundle (plan 6.2): the item plus everything
 * that renders inside it (member-bundle.ts) moves into the brain with the
 * same node ids, so every link to it stays valid. A submitted item moves the
 * bundle recorded at Submit (frozen since); a left-behind item only what is
 * itself shared or submitted. Only the author's own items join; links and
 * mentions stay where they are, and the admin is told how many point at
 * items that stay in a personal space. Bytes move beside the rows: staged
 * before the commit, put in place after it, removed again on a rollback.
 *
 * Only a MEMBER's item is ever reviewable (Phase 7): an admin's own private
 * items are never in the queue, the count, a Return or a review comment, not
 * even when submitted before the login was promoted. An admin accepts their
 * own items themselves (`acceptOwnItem`), through the same move.
 *
 * Take over (audit F07): an admin takes a submitted item and its bundle into
 * their own private space (`takeOverReviewItem`, member-takeover.ts moves
 * it); it leaves the queue, and the admin accepts it from there or gives it
 * back. If that admin is deactivated or deleted, the taken item is offered
 * in the queue again (a THIRD reviewable case below), in place: Accept,
 * Return (a give-back), Take over and Discard work on it as on a submitted
 * item, over what was taken with it.
 *
 * Every Accept of a member's item records the accepted snapshot for its
 * author (member-snapshots.ts), in the Accept's own transaction.
 *
 * Cost-safety: Accept is the ONE place a personal item is announced to the
 * extractor, once per moved item, after the commit and after its bytes are
 * in place (never for a rollback). Nothing else here starts LLM work.
 */
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  isUniqueViolation,
  authUsers,
  db,
  draws,
  isViewerLevel,
  nodeComments,
  nodes,
  pages,
  spaceItems,
  spaces,
  tables,
  type NodeCommentDbRow,
  type ReviewState,
  type SpaceSharing,
  type ViewerLevel,
  takeShareReadLock,
  isBusy,
  BUSY_MESSAGE,
} from '@mantle/db';
import {
  TEXT_EXTS,
  diskPathForFile,
  ensureFilesRootBranch,
  extOf,
  isFilesPath,
  mimeForExt,
  openSpaceFile,
  removeSpaceFile,
  sanitizeFilename,
  spaceFilePath,
} from '@mantle/files';
import {
  publishedPath,
  relativeStoragePath,
  resolveStoragePath,
  snapshotFile,
} from '@mantle/tabledb';
import {
  COMMENT_BODY_MAX,
  commentPage,
  type CommentPage,
  type CommentPageQuery,
} from './node-comments';
import { notifySpaceItemChanged } from './member-space-events';
import {
  SPACE_ITEM_KINDS,
  savedState,
  spaceItemBody,
  type SpaceItemBody,
  type SpaceItemKind,
} from './member-space';
import { SpaceItemStateError, spaceNotFound } from './member-space-core';
import { spaceFileOf, type OpenedSpaceFile } from './member-space-files';
import {
  BUNDLE_MAX_ITEMS,
  clearBundles,
  computeBundle,
  lockBundleRows,
  recordedBundle,
  withLinksStayingBehind,
  type Bundle,
  type BundleItem,
} from './member-bundle';
import { DRAWS_ROOT_LABEL, getDrawSvg } from './draws';
import { NOTES_ROOT_LABEL } from './notes';
import { PAGES_ROOT_LABEL } from './pages/shared';
import { draftAbsFor, removeTableFile } from './table-storage';
import { dedupeFilename } from './dedupe-filename';
import { isWorkspaceKind, setItemLevel } from './access';
import {
  brainEmbedsOf,
  levelAbove,
  lowerEmbedClosure,
  type EmbedItem,
  type LoweredItem,
} from './embed-closure';
import { refoldPageTexts } from './pages/level-text';
import {
  detachFromGroups,
  giveBackTaken,
  moveBetweenSpaces,
  personalSpaceOf,
  takenGroup,
  withMoveHooks,
} from './member-takeover';
import { writeAcceptedSnapshots } from './member-snapshots';
import {
  TREE_KIND_SPECS,
  TREE_VISIBILITY_LIST_MAX,
  type TreeVisibilityChange,
} from '@mantle/client-types/tree';
import { effectiveLevel } from '@mantle/content-core/tree';
import {
  acceptPlace,
  dropEmptyOwnFolders,
  ensurePlaced,
  planPlace,
  sharesAt,
  treeKindOfType,
  type AcceptPlace,
  type PlacePlan,
} from './accept-place';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Why a review action was refused. Routes answer 404 for `not-found` (a
 *  private item looks exactly like one that does not exist), 400 for
 *  `invalid`, 409 for the rest. */
export class ReviewError extends Error {
  constructor(
    readonly reason:
      | 'not-found'
      | 'not-submitted'
      | 'not-left-behind'
      | 'invalid'
      | 'too-large'
      // A client's item to client or public level, not confirmed (C1).
      | 'confirm-level'
      // It lands in a shared folder and would be read above the chosen
      // level (folder plan phase 5): repeat with visibilityConfirmed.
      | 'visibility'
      // Another write held the same rows (a deadlock broken, or the share
      // lock's timeout): nothing moved; try again (review F7).
      | 'busy',
    message: string,
    /** `confirm-level` only: the brain items the Accept would take down
     *  with the item (its embed closure above the chosen level). */
    readonly goingDown?: EmbedItem[],
    /** `visibility` only: what would be read above the chosen level. */
    readonly visibility?: {
      changes: TreeVisibilityChange[];
      total: number;
      /** What the bundle embeds that would be read through it (0208). */
      alsoEmbeds?: TreeVisibilityChange[];
    },
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** Not reviewable (any more). Deliberately one answer for "recalled by the
 *  author", "handled by another admin" and "a private item": telling them
 *  apart would tell an admin that a private item exists. */
const notFound = () =>
  new ReviewError(
    'not-found',
    'This item is not waiting for review. The author may have recalled it, or another admin handled it.',
  );

/** Why an admin sees the item: submitted for review, or left behind by a
 *  deactivated (or deleted) login while shared with the team. An item taken
 *  over by an admin who is gone since (reviewState `taken`) is `submitted`,
 *  or `left-behind` when its author is gone too. */
export type ReviewReason = 'submitted' | 'left-behind';

/** The role of a reviewable item's author: a member or a client login; null
 *  when the login is gone (client logins C1, audit A28). */
export type ReviewAuthorRole = 'member' | 'client';

export type ReviewAuthor = {
  loginId: string | null;
  name: string;
  email: string | null;
  /** Deactivated, or the login is gone. */
  inactive: boolean;
  /** Member or client (null: the login is gone). An Accept of a client's
   *  item takes team by default and needs a confirmation at client or
   *  public (`acceptAudience`). */
  role: ReviewAuthorRole | null;
};

export type ReviewItemRow = {
  id: string;
  type: SpaceItemKind;
  title: string;
  icon: string | null;
  sharing: SpaceSharing;
  reviewState: ReviewState;
  submittedAt: string | null;
  updatedAt: string;
  reason: ReviewReason;
  author: ReviewAuthor;
};

/** A login that cannot use the brain any more: deactivated, or deleted. */
const authorInactive = or(isNull(authUsers.id), isNotNull(authUsers.disabledAt))!;

/** Written by a MEMBER or a CLIENT login (or one since deleted, which only a
 *  member's or client's left-behind item can be): never an admin's own
 *  private item (Phase 7). The roles are named (client logins C1): a role
 *  this code does not know is not an author. No client can submit before
 *  client logins C5; Accept of a client's item defaults to team
 *  (acceptAudience). Needs `authUsers` left-joined on the item's author. */
const authorIsMember = or(isNull(authUsers.id), inArray(authUsers.role, ['member', 'client']))!;

/** The admin holding a taken item (audit F07), left-joined on `taken_by`. */
const taker = alias(authUsers, 'taker');

/**
 * A taken item whose admin cannot act on it any more (deactivated, deleted,
 * or no longer an admin): the queue offers it again, in place. Only the
 * group's root (`taken_root` NULL) is listed; the rest is its bundle. Needs
 * `taker` left-joined on the item's `taken_by`.
 */
const released: SQL = and(
  eq(spaceItems.reviewState, 'taken'),
  isNull(spaceItems.takenRoot),
  or(isNull(taker.id), isNotNull(taker.disabledAt), ne(taker.role, 'admin')),
)!;

/**
 * The one condition under which an admin reads a personal item (see the
 * module comment). `spaces.kind = 'personal'` keeps brain items out, and
 * `authorIsMember` every admin's own space. A taken item is the taking
 * admin's alone while they can act on it (never left behind, never listed).
 */
const reviewable: SQL = and(
  eq(spaces.kind, 'personal'),
  inArray(nodes.type, [...SPACE_ITEM_KINDS]),
  authorIsMember,
  or(
    eq(spaceItems.reviewState, 'submitted'),
    and(
      eq(spaceItems.sharing, 'team'),
      sql`${spaceItems.reviewState} not in ('accepted', 'taken')`,
      authorInactive,
    ),
    released,
  ),
)!;

function reviewQuery(via: Pick<Tx, 'select'> = db) {
  return via
    .select({
      node: nodes,
      item: spaceItems,
      author: {
        id: authUsers.id,
        email: authUsers.email,
        displayName: authUsers.displayName,
        disabledAt: authUsers.disabledAt,
        role: authUsers.role,
      },
    })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
    .leftJoin(taker, eq(taker.id, spaceItems.takenBy));
}

type Joined = Awaited<ReturnType<typeof reviewQuery>>[number];

function rowOf({ node, item, author }: Joined): ReviewItemRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const inactive = !author?.id || author.disabledAt !== null;
  // The login's role, or the role stamped on the row when the login is
  // deleted (audit I6): a deleted client's item is still a client's, with
  // the Client badge and Accept's client rules (acceptAudience).
  const role = author?.role ?? item.authorRole;
  return {
    id: node.id,
    type: node.type as SpaceItemKind,
    title: node.title,
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    sharing: item.sharing,
    reviewState: item.reviewState,
    submittedAt: item.submittedAt?.toISOString() ?? null,
    updatedAt: node.updatedAt.toISOString(),
    reason:
      item.reviewState === 'submitted' || (item.reviewState === 'taken' && !inactive)
        ? 'submitted'
        : 'left-behind',
    author: {
      loginId: author?.id ?? null,
      name: author?.displayName?.trim() || author?.email?.split('@')[0] || 'Removed login',
      email: author?.email ?? null,
      inactive,
      role: role === 'member' || role === 'client' ? role : null,
    },
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Everything waiting for an admin: submitted items (oldest first), then
 *  what deactivated logins left shared with the team. */
export async function listReviewQueue(via: Pick<Tx, 'select'> = db): Promise<{
  items: ReviewItemRow[];
  counts: { submitted: number; leftBehind: number };
}> {
  const rows = await reviewQuery(via)
    .where(reviewable)
    .orderBy(asc(spaceItems.submittedAt), asc(nodes.updatedAt))
    .limit(500);
  const items = rows.map(rowOf);
  const submitted = items.filter((i) => i.reason === 'submitted');
  const leftBehind = items.filter((i) => i.reason === 'left-behind');
  return {
    items: [...submitted, ...leftBehind],
    counts: { submitted: submitted.length, leftBehind: leftBehind.length },
  };
}

/** How many items wait for review (the nav badge). `via` reads on another
 *  connection (a test's one snapshot). */
export async function countSubmitted(via: Pick<Tx, 'select'> = db): Promise<number> {
  const [r] = await via
    .select({ n: sql<number>`count(*)::int` })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
    .leftJoin(taker, eq(taker.id, spaceItems.takenBy))
    .where(
      and(
        eq(spaces.kind, 'personal'),
        or(eq(spaceItems.reviewState, 'submitted'), released),
        inArray(nodes.type, [...SPACE_ITEM_KINDS]),
        authorIsMember,
      ),
    );
  return r?.n ?? 0;
}

/**
 * The Review queue in numbers, for the "needs you" count: ONE count query
 * over the exact condition the queue lists (`reviewable`), split the way
 * `rowOf` splits it, so the count never disagrees with the tab and never
 * stops at the list's cap. `via` reads on another connection (a test's one
 * snapshot).
 */
export async function countReviewQueue(
  via: Pick<Tx, 'select'> = db,
): Promise<{ submitted: number; leftBehind: number }> {
  // rowOf: 'submitted' when submitted, or taken by a gone admin while the
  // author is still active; everything else the queue lists is left behind.
  const waiting = sql`(${spaceItems.reviewState} = 'submitted' or (${spaceItems.reviewState} = 'taken'
    and ${authUsers.id} is not null and ${authUsers.disabledAt} is null))`;
  const [r] = await via
    .select({
      submitted: sql<number>`count(*) filter (where ${waiting})::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
    .leftJoin(taker, eq(taker.id, spaceItems.takenBy))
    .where(reviewable);
  const submitted = r?.submitted ?? 0;
  return { submitted, leftBehind: (r?.all ?? 0) - submitted };
}

/** The item submitted most recently (a "needs you" notification names its
 *  title and author, never its content); null when nothing is submitted. */
export async function newestSubmitted(
  via: Pick<Tx, 'select'> = db,
): Promise<{ id: string; title: string; from: string; at: string } | null> {
  const [j] = await reviewQuery(via)
    .where(and(reviewable, eq(spaceItems.reviewState, 'submitted')))
    .orderBy(desc(spaceItems.submittedAt))
    .limit(1);
  if (!j) return null;
  const row = rowOf(j);
  return {
    id: row.id,
    title: row.title,
    from: row.author.name,
    at: row.submittedAt ?? row.updatedAt,
  };
}

async function reviewRow(
  id: string,
  via: Pick<Tx, 'select'> = db,
): Promise<{ row: ReviewItemRow; spaceId: string } | null> {
  const [j] = await reviewQuery(via)
    .where(and(eq(nodes.id, id), reviewable))
    .limit(1);
  return j ? { row: rowOf(j), spaceId: j.node.ownerId } : null;
}

/** The saved version only: drafts are the author's working copy, and a
 *  submitted item has none (Submit refuses unsaved edits; it is frozen). */
function publishedOnly(body: SpaceItemBody): SpaceItemBody {
  switch (body.type) {
    case 'page':
      return { type: 'page', page: { ...body.page, draft: null, draftUpdatedAt: null } };
    case 'draw':
      return { type: 'draw', draw: body.draw ? { ...body.draw, draft: null } : null };
    case 'table':
      return { type: 'table', table: { ...body.table, draft: null } };
    default:
      return body;
  }
}

/** One item an admin may read, with its saved body; null otherwise. */
export async function getReviewItem(
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: ReviewItemRow; body: SpaceItemBody } | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  const body = await spaceItemBody(found.spaceId, found.row.type, id, opts);
  return body ? { row: found.row, body: publishedOnly(body) } : null;
}

/**
 * The thread an admin reads on a reviewable item: the review talk (the
 * author and the reviewers, `thread_scope` 'review'), plus the team's
 * comments while the item is shared with the team (every admin can read
 * what the team reads). Null when the item is not reviewable.
 */
export async function listReviewComments(id: string): Promise<NodeCommentDbRow[] | null>;
export async function listReviewComments(
  id: string,
  page: CommentPageQuery,
): Promise<CommentPage | null>;
export async function listReviewComments(
  id: string,
  page?: CommentPageQuery,
): Promise<NodeCommentDbRow[] | CommentPage | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  const where = and(
    eq(nodeComments.nodeId, id),
    found.row.sharing === 'team' ? undefined : eq(nodeComments.threadScope, 'review'),
  );
  // With `page`: one page of it (the thread route pages every read, I2).
  if (page) return commentPage(where, page);
  return db.select().from(nodeComments).where(where).orderBy(asc(nodeComments.createdAt));
}

/** The reviewer's side of the review talk: open while the item is submitted
 *  (the author is waiting for an answer). Stored with the brain's id, like
 *  every personal item's thread, so it survives Accept; always review talk,
 *  never the team's. The author reads it in their own thread. */
export async function addReviewComment(
  brainId: string,
  id: string,
  reviewer: { loginId: string; name: string },
  body: string,
): Promise<NodeCommentDbRow> {
  const text = body.trim().slice(0, COMMENT_BODY_MAX);
  if (!text) throw new ReviewError('invalid', 'A comment needs some text.');
  return db.transaction(async (tx) => {
    // Lock the state row: a Recall or an Accept cannot slip in between.
    const [si] = await tx
      .select({ state: spaceItems.reviewState })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(and(eq(spaceItems.nodeId, id), eq(spaces.kind, 'personal')))
      .for('share', { of: spaceItems })
      .limit(1);
    // Reviewable at all (a member's item), else it does not exist for an admin.
    if (!si || !(await reviewRow(id, tx))) throw notFound();
    if (si.state !== 'submitted') {
      throw new ReviewError('not-submitted', 'Only a submitted item takes review comments.');
    }
    const [c] = await tx
      .insert(nodeComments)
      .values({
        ownerId: brainId,
        nodeId: id,
        authorKind: 'owner',
        loginId: reviewer.loginId,
        authorName: reviewer.name.trim().slice(0, 200) || 'Admin',
        body: text,
        threadScope: 'review',
      })
      .returning();
    if (!c) throw new Error('addReviewComment: insert returned no row');
    await notifySpaceItemChanged(id, 'comment', undefined, tx);
    return c;
  });
}

/** Delete one of the caller's own review comments. */
export async function deleteReviewComment(
  id: string,
  loginId: string,
  commentId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await reviewRow(id, tx))) return false;
    const gone = await tx
      .delete(nodeComments)
      .where(
        and(
          eq(nodeComments.id, commentId),
          eq(nodeComments.nodeId, id),
          eq(nodeComments.authorKind, 'owner'),
          eq(nodeComments.loginId, loginId),
        ),
      )
      .returning({ id: nodeComments.id });
    if (gone.length) await notifySpaceItemChanged(id, 'comment', undefined, tx);
    return gone.length > 0;
  });
}

// ── The bundle (plan 6.2, member-bundle.ts) ────────────────────────────────

export { BUNDLE_MAX_ITEMS, type Bundle, type BundleItem } from './member-bundle';

const tooLarge = () =>
  new ReviewError(
    'too-large',
    `This item brings more than ${BUNDLE_MAX_ITEMS} items with it. Return it and ask for a smaller one.`,
  );

/**
 * The bundle an admin reviews and Accept moves, read on `via`:
 *  - a submitted item: the bundle recorded at Submit (frozen since, so what
 *    was reviewed is what moves); worked out now for an item submitted
 *    before the record existed (migration 0180);
 *  - a left-behind item (never submitted): only items that are themselves
 *    shared or submitted join (audit F18). Its author's private embeds stay
 *    behind, and no admin reads them;
 *  - a released taken item (its admin is gone): what was taken with it,
 *    never an item of that admin's own.
 */
async function reviewBundle(
  via: Pick<Tx, 'select'>,
  spaceId: string,
  row: ReviewItemRow,
): Promise<Bundle> {
  const root: BundleItem = { id: row.id, type: row.type, title: row.title };
  if (row.reviewState === 'taken') {
    // Released by a gone admin: what was taken with it, nothing of theirs.
    return withLinksStayingBehind(via, await takenGroup(via, spaceId, row.id));
  }
  if (row.reason === 'left-behind') {
    return computeBundle(via, spaceId, root, { sharedOnly: true, tooLarge });
  }
  const recorded = await recordedBundle(via, spaceId, row.id);
  if (!recorded) return computeBundle(via, spaceId, root, { tooLarge });
  return withLinksStayingBehind(via, recorded);
}

/** An item of an Accept's embed closure, at its current level. */
export type AcceptClosureItem = {
  id: string;
  type: string;
  title: string;
  audience: ViewerLevel;
};

/** What Accept would move, for the accept dialog, plus (given the brain)
 *  `closure`: the brain items the bundle embeds, transitively, at their
 *  current levels (workspace kinds only: nothing else ever goes below
 *  admin). The ones above the chosen level go DOWN with the Accept; for a
 *  client's item at client or public each needs a tick (`confirmedIds`).
 *  Null when not reviewable. */
export async function previewAccept(
  id: string,
  brainId?: string,
  /** The folder the admin picked (see AcceptOptions.folderId): the place is
   *  worked out for it instead of in place. */
  pick?: string | null,
): Promise<(Bundle & { closure?: AcceptClosureItem[]; place?: AcceptPlace }) | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  const bundle = await reviewBundle(db, found.spaceId, found.row);
  if (!brainId) return bundle;
  // Where it lands by default (folder plan phase 5): the brain folder it
  // was filed in, and the member's own folders made below it.
  const [node] = (await db.execute(sql`
    select type::text as type, path::text as path from nodes where id = ${found.row.id}`)) as unknown as Array<{
    type: string;
    path: string;
  }>;
  const place = node
    ? await acceptPlace(db, brainId, found.spaceId, { id: found.row.id, ...node }, pick)
    : null;
  return {
    ...bundle,
    closure: await acceptClosure(db, brainId, found.spaceId, bundle.items),
    ...(place ? { place } : {}),
  };
}

/** The brain items an Accept of `items` (still in `spaceId`) takes along:
 *  their embed closure in the brain, workspace kinds only. */
async function acceptClosure(
  via: Parameters<typeof brainEmbedsOf>[3],
  brainId: string,
  spaceId: string,
  items: readonly BundleItem[],
): Promise<AcceptClosureItem[]> {
  const found = await brainEmbedsOf(
    brainId,
    spaceId,
    items,
    via,
    items.map((b) => b.id),
  );
  return found
    .filter((c) => isWorkspaceKind(c.type))
    .map(({ id, type, title, audience }) => ({ id, type, title, audience }));
}

/**
 * The bytes of a file an admin may see: the reviewable item itself when it
 * is a file, or a file in its bundle (an image the submitted page shows).
 * Null otherwise.
 */
export async function openReviewFile(id: string, fileId: string): Promise<OpenedSpaceFile | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  if (fileId !== id) {
    const bundle = await reviewBundle(db, found.spaceId, found.row);
    if (!bundle.items.some((b) => b.id === fileId && b.type === 'file')) return null;
  }
  const file = await spaceFileOf(found.spaceId, fileId);
  if (!file) return null;
  const opened = await openSpaceFile(found.spaceId, fileId);
  return opened ? { file, spaceId: found.spaceId, ...opened } : null;
}

/** A drawing's saved SVG for an admin: the reviewable item, or a drawing in
 *  its bundle. Null otherwise. */
export async function reviewDrawSvg(id: string, drawId: string): Promise<string | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  if (drawId !== id) {
    const bundle = await reviewBundle(db, found.spaceId, found.row);
    if (!bundle.items.some((b) => b.id === drawId && b.type === 'draw')) return null;
  }
  return getDrawSvg(found.spaceId, drawId);
}

// ── Accept (plan 6.2) ───────────────────────────────────────────────────────

export type AcceptOptions = {
  /** The level the accepted item (and everything that moves with it) gets.
   *  Admin by default (decided 2026-09-25); team by default for an item a
   *  CLIENT wrote (client logins C1, see `acceptAudience`). */
  audience?: ViewerLevel;
  /** For an item a client wrote: the admin confirmed that it, and what it
   *  takes with it, goes down to client (every client login reads it) or
   *  public (anyone with its open link; client logins do not). Refused
   *  without it (`confirm-level`). */
  lowerConfirmed?: boolean;
  /** For an item a client wrote, at client or public: the ids of the brain
   *  items its Accept takes down (the preview's `closure` above the chosen
   *  level) that the admin ticked. Every one must be here, or the Accept is
   *  refused with `confirm-level` and the list in `goingDown`. */
  confirmedIds?: string[];
  /** DEPRECATED (folder phase 7): pages do not nest, so this is ignored. A
   *  page lands like every tree kind (`folderId`). */
  parentPageId?: string | null;
  /** The brain Files folder the bundle's files land in: the request of a
   *  client from before the tree (folder plan phase 5). Without `folderId`,
   *  it still files every file of the bundle there. */
  folderPath?: string | null;
  /** Where the item lands (folder plan phase 5, "Accept claims in place"):
   *  undefined keeps it in the brain folder it was filed in, with the
   *  member's own folders below recreated as brain folders; null is the
   *  kind's top level; an id is a brain folder of its kind (the member's
   *  folders still go below it). The rest of the bundle always lands in
   *  place. */
  folderId?: string | null;
  /** The admin saw, and accepts, that items land in a shared folder and are
   *  read above the chosen level there (the `visibility` refusal's list). */
  visibilityConfirmed?: boolean;
};

export type AcceptResult = {
  id: string;
  audience: ViewerLevel;
  /** The level the item is read at: the more open of `audience` and the
   *  share of the folder it landed in. */
  readAt: ViewerLevel;
  moved: BundleItem[];
  linksStayingBehind: number;
  /** Brain items it embeds that went down to its level with it (embedding
   *  means sharing: a Library image a member placed, say). Empty at admin. */
  alsoLowered: LoweredItem[];
  /** Set when the item's level was stored but its link could not be made;
   *  the admin can set the level again from the item. */
  levelWarning?: string;
};

/** The small-text cache a brain file carries (mirrors upsertFile). */
const TEXT_CACHE_MAX_BYTES = 1_000_000;

/** Ensure a brain root branch exists (lazy, like each kind's own create). */
async function ensureBrainRoot(tx: Tx, brainId: string, label: string, title: string) {
  await tx
    .insert(nodes)
    .values({ ownerId: brainId, type: 'branch', title, slug: label, path: label })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

/** A file name the brain folder does not hold yet. A file's slug is unique
 *  per folder (migration 0184), so the folder is the whole check. */
async function freeFileName(tx: Tx, brainId: string, folder: string, wanted: string) {
  const taken = await tx
    .select({ slug: nodes.slug, filename: sql<string | null>`${nodes.data}->>'filename'` })
    .from(nodes)
    .where(
      and(eq(nodes.ownerId, brainId), eq(nodes.type, 'file'), sql`${nodes.path}::text = ${folder}`),
    );
  const names = new Set<string>();
  for (const t of taken) {
    if (t.slug) names.add(t.slug);
    if (t.filename) names.add(t.filename);
  }
  return dedupeFilename(wanted, names);
}

/**
 * The level an Accept gives (client logins C1, plan section 3.4, N4). An
 * item a member wrote: the chosen level, admin by default. An item a CLIENT
 * wrote: team by default, because the author reads their accepted item from
 * the snapshot whatever its level, so publishing one client's request to
 * every client login must be an explicit choice. Client or public for it
 * needs `lowerConfirmed` (the admin ticked the list of what goes down).
 */
export function acceptAudience(authorRole: string | null, opts: AcceptOptions): ViewerLevel {
  const level = acceptLevel(authorRole, opts);
  if (needsLevelConfirm(authorRole, level) && opts.lowerConfirmed !== true) {
    throw confirmLevelError(level, []);
  }
  return level;
}

/** The level an Accept gives, before any confirmation (see acceptAudience). */
function acceptLevel(authorRole: string | null, opts: AcceptOptions): ViewerLevel {
  if (authorRole !== 'client') return opts.audience ?? 'admin';
  return opts.audience ?? 'team';
}

/** A client's item at client or public: the admin must confirm the level and
 *  every brain item that goes down with it. */
function needsLevelConfirm(authorRole: string | null, level: ViewerLevel): boolean {
  return authorRole === 'client' && (level === 'client' || level === 'public');
}

/** Who reads an item at `level`, in the words of the confirm-level refusal
 *  (client logins C1, decision 3: client logins read client items only). */
function readersAt(level: ViewerLevel): string {
  return level === 'public'
    ? 'anyone with its open link reads it; client logins do not'
    : 'every client login reads it';
}

function confirmLevelError(level: ViewerLevel, goingDown: EmbedItem[]): ReviewError {
  const names = goingDown.map((g) => `"${g.title}" (${g.type}, ${g.audience})`).join(', ');
  const also = goingDown.length
    ? ` It takes ${goingDown.length === 1 ? 'this brain item' : 'these brain items'} down to ${level} with it: ${names}; tick each one.`
    : ' What it embeds goes down with it.';
  return new ReviewError(
    'confirm-level',
    `A client wrote this. At ${level} level ${readersAt(level)}.${also} Confirm that, or accept it at team.`,
    goingDown,
  );
}

/** Items that would be read above the chosen level where they land. */
function visibilityError(
  changes: TreeVisibilityChange[],
  alsoEmbeds: TreeVisibilityChange[] = [],
): ReviewError {
  const n = changes.length;
  const what = n === 1 ? 'It lands' : `${n} items land`;
  return new ReviewError(
    'visibility',
    n > 0
      ? `${what} in a shared folder and would be read above the level you chose. ` +
          'Confirm that, or pick another folder.'
      : 'It lands in a shared folder, and what it embeds would be read there too. ' +
          'Confirm that, or pick another folder.',
    undefined,
    {
      changes: changes.slice(0, TREE_VISIBILITY_LIST_MAX),
      total: n,
      ...(alsoEmbeds.length ? { alsoEmbeds: alsoEmbeds.slice(0, TREE_VISIBILITY_LIST_MAX) } : {}),
    },
  );
}

/**
 * The brain's items the bundle embeds (through the edges its drafts carry,
 * migration 0208) that would be read more openly once it lands: each item
 * landing under a folder share passes that share on to what it reaches
 * through embeds, as nodes.embedded_level will. Dry, for the refusal's
 * list; the most open level wins when two items reach the same embed.
 */
async function embedsReadThrough(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  brainId: string,
  items: readonly { id: string }[],
  shares: ReadonlyMap<string, string | null>,
): Promise<TreeVisibilityChange[]> {
  const found = new Map<string, TreeVisibilityChange>();
  for (const b of items) {
    const share = shares.get(b.id);
    if (share !== 'team' && share !== 'client') continue;
    const rows = (await tx.execute(sql`
      select r.id::text as id, r.title, r."from", r."to", r.type from (
        select n.id, n.title, n.type::text as type,
               ${embedLevelSql(sql`n.embedded_level`)} as "from",
               ${embedLevelSql(sql`mantle_share_max(n.embedded_level, ${share}::text)`)} as "to"
          from nodes n
         where n.owner_id = ${brainId} and mantle_workspace_kind(n.type)
           and n.id in (select x.id from mantle_embeds_reached(${brainId}::uuid, array(
                 select e.to_id from node_embeds e where e.from_id = ${b.id}::uuid)) x)) r
       where r."from" is distinct from r."to"`)) as unknown as TreeVisibilityChange[];
    for (const r of rows) {
      const seen = found.get(r.id);
      if (!seen || levelAbove(seen.to as ViewerLevel, r.to as ViewerLevel)) found.set(r.id, r);
    }
  }
  return [...found.values()];
}

/** effectiveLevel in SQL over `n`'s own level and folder share and `embedded`. */
function embedLevelSql(embedded: SQL): SQL {
  return sql`(case
      when 'client' in (n.inherited_level, ${embedded}) and n.audience in ('admin', 'team') then 'client'
      when 'team' in (n.inherited_level, ${embedded}) and n.audience = 'admin' then 'team'
      else n.audience end)`;
}

/**
 * Accept a reviewable item into the brain (plan 6.2). One transaction: lock
 * the item's state row (a Recall that lands first wins: not found), take its
 * bundle (the one recorded at Submit), re-own every item in it (same ids),
 * stage its bytes, mark every space_items row accepted (the row stays: it
 * records the author), discard leftover drafts and set the level. Then,
 * after the commit, the bytes are put in place, each moved item is announced
 * to the extractor once, and the item's link follows its level.
 */
export async function acceptReviewItem(
  brainId: string,
  id: string,
  reviewer: { loginId: string },
  opts: AcceptOptions = {},
): Promise<AcceptResult> {
  // The level by the author's role (client logins C1): checked inside the
  // move's transaction, before anything moves (moveIntoBrain).
  return moveIntoBrain(brainId, id, opts, {
    locate: async (tx) => {
      // The state row, locked. A Recall, Return or second Accept waits.
      const [locked] = await tx
        .select({ kind: spaces.kind })
        .from(spaceItems)
        .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
        .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
        .where(eq(spaceItems.nodeId, id))
        .for('update', { of: spaceItems })
        .limit(1);
      if (!locked || locked.kind !== 'personal') throw notFound();
      const found = await reviewRow(id, tx);
      if (!found) throw notFound();
      return {
        spaceId: found.spaceId,
        root: { id, type: found.row.type, title: found.row.title },
        authorRole: found.row.author.role,
        bundle: () => reviewBundle(tx, found.spaceId, found.row),
      };
    },
    // The state rows: accepted, by whom. They stay: they record the author.
    settle: async (tx, ids, now) => {
      await tx
        .update(spaceItems)
        .set({
          reviewState: 'accepted',
          reviewedBy: reviewer.loginId,
          reviewedAt: now,
          acceptedAt: now,
          updatedAt: now,
          takenBy: null,
          takenAt: null,
          takenRoot: null,
          takenTitle: null,
        })
        .where(inArray(spaceItems.nodeId, ids));
      await detachFromGroups(tx, ids);
    },
  });
}

/**
 * An ADMIN accepts one of their OWN private items into the brain (member
 * logins Phase 7, Jason 2026-09-28): no review, no queue. The same move as a
 * reviewed Accept (bundle, same ids, re-own, bytes, drafts discarded, the
 * extractor told once per moved item, one transaction), with its own guard:
 * the item is in the caller's own personal space, the caller is a usable
 * admin login, the item is not accepted, and it has no unsaved edits (the
 * brain gets the SAVED version, as Submit sends it). Anything else is
 * `not-found` (another login's item looks like a missing one) or
 * `unsaved-draft`.
 *
 * The bundle's `space_items` rows of the admin's OWN items are DROPPED, not
 * marked accepted: an admin's own item has no author record, so it never
 * carries the "member-authored" badge (member-accepted.ts) and never lists
 * as a member's accepted item. A member's item the admin TOOK OVER (audit
 * F07, state `taken`) keeps its row: it goes to `accepted` with this admin
 * as the reviewer, and its author gets the accepted snapshot, exactly as
 * after a reviewed Accept.
 */
export async function acceptOwnItem(
  brainId: string,
  own: { spaceId: string; loginId: string },
  id: string,
  opts: AcceptOptions = {},
): Promise<AcceptResult> {
  return moveIntoBrain(brainId, id, opts, {
    locate: async (tx) => {
      // The item, locked, in the caller's own personal space.
      const [locked] = await tx
        .select({
          type: nodes.type,
          title: nodes.title,
          state: spaceItems.reviewState,
          author: spaceItems.authorLoginId,
          authorRole: spaceItems.authorRole,
        })
        .from(nodes)
        .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
        .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.id, id),
            eq(nodes.ownerId, own.spaceId),
            eq(spaces.kind, 'personal'),
            eq(spaces.loginId, own.loginId),
            inArray(nodes.type, [...SPACE_ITEM_KINDS]),
          ),
        )
        .for('update', { of: nodes })
        .limit(1);
      if (!locked || locked.state === 'accepted') throw spaceNotFound();
      // Only an admin accepts without review; a member never does.
      const [login] = await tx
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(
          and(
            eq(authUsers.id, own.loginId),
            eq(authUsers.role, 'admin'),
            isNull(authUsers.disabledAt),
          ),
        )
        .limit(1);
      if (!login) throw spaceNotFound();
      // A member's or a client's item this admin TOOK OVER (audit F07) is
      // accepted by its author's rule (audit A6): a client's goes to team by
      // default and needs the confirmation at client or public. The admin's
      // own item has no author record: admin by default, no confirmation.
      // A deleted author's role is the one stamped on the row (audit I6).
      let authorRole: string | null = null;
      if (locked.state === 'taken') {
        const [a] = locked.author
          ? await tx
              .select({ role: authUsers.role })
              .from(authUsers)
              .where(eq(authUsers.id, locked.author))
              .limit(1)
          : [];
        authorRole = a?.role ?? locked.authorRole ?? null;
      }
      const root: BundleItem = { id, type: locked.type as SpaceItemKind, title: locked.title };
      return {
        spaceId: own.spaceId,
        root,
        authorRole,
        // The brain gets the SAVED version of every item that moves (audit
        // F04): unsaved edits on the item, or on anything shown in it,
        // refuse, since Accept would drop them. The rows are locked first,
        // so the admin's own autosave cannot land between check and move.
        bundle: async () => {
          const bundle = await computeBundle(tx, own.spaceId, root, { tooLarge });
          await lockBundleRows(tx, bundle.items);
          const unsaved: BundleItem[] = [];
          for (const b of bundle.items) {
            if ((await savedState(b.type, b.id, tx)).unsaved) unsaved.push(b);
          }
          if (unsaved.some((b) => b.id === id)) {
            throw new SpaceItemStateError(
              'unsaved-draft',
              'This item has unsaved changes. Save a version first, then accept it.',
              [id],
            );
          }
          if (unsaved.length) {
            const names = unsaved.map((b) => `"${b.title}"`).join(', ');
            throw new SpaceItemStateError(
              'unsaved-draft',
              `Items shown in this one have unsaved changes: ${names}. Save a version of each, then accept.`,
              unsaved.map((b) => b.id),
            );
          }
          return bundle;
        },
      };
    },
    // No author record for an admin's own item; a taken member item keeps
    // its row, accepted by this admin (see above).
    settle: async (tx, ids, now) => {
      await tx
        .update(spaceItems)
        .set({
          reviewState: 'accepted',
          reviewedBy: own.loginId,
          reviewedAt: now,
          acceptedAt: now,
          updatedAt: now,
          takenBy: null,
          takenAt: null,
          takenRoot: null,
          takenTitle: null,
        })
        .where(and(inArray(spaceItems.nodeId, ids), eq(spaceItems.reviewState, 'taken')));
      await tx
        .delete(spaceItems)
        .where(and(inArray(spaceItems.nodeId, ids), ne(spaceItems.reviewState, 'accepted')));
      await detachFromGroups(tx, ids);
    },
  });
}

// ── Take over (audit F07) ───────────────────────────────────────────────────

export type TakeOverResult = { id: string; moved: BundleItem[] };

/**
 * Take a SUBMITTED member item out of the queue into the acting admin's OWN
 * private space (`actor`: the login and its personal space, never the
 * anchor's for another admin), to work on it there (Jason 2026-09-28, audit
 * F07). One transaction, with Accept's locks: the state row first (a Recall,
 * Return, Accept or second Take over waits, and then finds it gone), then
 * every row of the bundle. The item and the bundle recorded at Submit move
 * with the same node ids (member-takeover.ts `moveBetweenSpaces`: re-owned,
 * bytes and workbooks moved, file names made unique, leftover drafts
 * dropped). An item of the bundle that is itself submitted or accepted stays
 * where it is. Every moved item's `space_items` row stays (it names the
 * author) and goes to `taken`, with `taken_by`, `taken_at` and `taken_root`
 * (NULL on the item itself); sharing goes private. The recorded bundle is
 * cleared. The queue no longer lists it; nobody but this admin reads it.
 *
 * A taken item whose admin is gone (see `released`) is taken over the same
 * way, from that admin's space, with what was taken with it.
 *
 * Nothing is indexed, embedded or extracted: it stays a personal item.
 * Refused: `not-found` (not reviewable: a private, recalled, handled or
 * taken item), `not-submitted` (a left-behind item that was never submitted:
 * accept or discard it), `too-large`.
 */
export async function takeOverReviewItem(
  id: string,
  actor: { loginId: string; spaceId: string },
): Promise<TakeOverResult> {
  return withMoveHooks(async (tx, hooks) => {
    // The state row, locked, as Accept locks it.
    const [locked] = await tx
      .select({ kind: spaces.kind })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(eq(spaceItems.nodeId, id))
      .for('update', { of: spaceItems })
      .limit(1);
    if (!locked || locked.kind !== 'personal') throw notFound();
    const found = await reviewRow(id, tx);
    if (!found) throw notFound();
    if (found.row.reviewState !== 'submitted' && found.row.reviewState !== 'taken') {
      throw new ReviewError(
        'not-submitted',
        'Only a submitted item can be taken over. Accept or discard what a deactivated login left behind.',
      );
    }
    // The acting admin's own personal space, and an admin who can act.
    const [mine] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .innerJoin(authUsers, eq(authUsers.id, spaces.loginId))
      .where(
        and(
          eq(spaces.id, actor.spaceId),
          eq(spaces.kind, 'personal'),
          eq(spaces.loginId, actor.loginId),
          eq(authUsers.role, 'admin'),
          isNull(authUsers.disabledAt),
        ),
      )
      .limit(1);
    if (!mine || found.spaceId === actor.spaceId) throw notFound();

    const bundle = await reviewBundle(tx, found.spaceId, found.row);
    const still = await tx
      .select({ id: nodes.id, state: spaceItems.reviewState, title: nodes.title })
      .from(nodes)
      .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
      .where(
        and(
          inArray(
            nodes.id,
            bundle.items.map((b) => b.id),
          ),
          eq(nodes.ownerId, found.spaceId),
        ),
      )
      .for('update', { of: nodes });
    const stateOf = new Map(still.map((r) => [r.id, r.state]));
    if (!stateOf.has(id)) throw notFound();
    // Another submitted item (or an accepted one) is not this item's to take.
    const items = bundle.items.filter(
      (b) =>
        stateOf.has(b.id) &&
        (b.id === id || (stateOf.get(b.id) !== 'submitted' && stateOf.get(b.id) !== 'accepted')),
    );
    await lockBundleRows(tx, items);
    const ids = items.map((b) => b.id);
    const sharing = await tx
      .select({ id: spaceItems.nodeId, sharing: spaceItems.sharing })
      .from(spaceItems)
      .where(inArray(spaceItems.nodeId, ids));
    const wasTeam = new Set(sharing.filter((r) => r.sharing === 'team').map((r) => r.id));

    await moveBetweenSpaces(tx, found.spaceId, actor.spaceId, items, hooks);

    // Items made before state rows existed get one, so every moved item
    // names its author and goes back with the rest.
    const author = found.row.author.loginId;
    await tx
      .insert(spaceItems)
      .values(ids.map((nodeId) => ({ nodeId, authorLoginId: author })))
      .onConflictDoNothing({ target: spaceItems.nodeId });
    const now = new Date();
    await tx
      .update(spaceItems)
      .set({
        reviewState: 'taken',
        sharing: 'private',
        takenBy: actor.loginId,
        takenAt: now,
        takenRoot: id,
        updatedAt: now,
      })
      .where(and(inArray(spaceItems.nodeId, ids), ne(spaceItems.nodeId, id)));
    await tx
      .update(spaceItems)
      .set({
        reviewState: 'taken',
        sharing: 'private',
        takenBy: actor.loginId,
        takenAt: now,
        takenRoot: null,
        updatedAt: now,
      })
      .where(eq(spaceItems.nodeId, id));
    // The title each had when it was taken (audit L6): what the author's
    // list shows while the admin holds it, whatever the admin renames it
    // to. A taken item taken again (its admin is gone) keeps the first one.
    const titleOf = new Map(still.map((r) => [r.id, r.title]));
    for (const nodeId of ids) {
      await tx
        .update(spaceItems)
        .set({
          takenTitle:
            stateOf.get(nodeId) === 'taken'
              ? sql`coalesce(${spaceItems.takenTitle}, ${titleOf.get(nodeId) ?? ''})`
              : (titleOf.get(nodeId) ?? null),
        })
        .where(eq(spaceItems.nodeId, nodeId));
    }
    await clearBundles(tx, [id]);

    // The author's lists follow (their own space), and so do the teammates
    // who were showing a shared one.
    const home = (await personalSpaceOf(tx, author)) ?? found.spaceId;
    for (const b of items) {
      await notifySpaceItemChanged(b.id, 'state', { spaceId: home, team: wasTeam.has(b.id) }, tx);
    }
    return { id, moved: items };
  });
}

/** The two ends of an Accept that differ between a reviewed item and an
 *  admin's own: how the item is found and locked, and what happens to the
 *  bundle's state rows. Everything between is `moveIntoBrain`. */
type AcceptSteps = {
  /** Lock the item and prove the caller may accept it (throws otherwise);
   *  `bundle` then names what moves with it, read in the same transaction. */
  locate: (tx: Tx) => Promise<{
    spaceId: string;
    root: BundleItem;
    /** The role of the login that wrote the item (null: none, or gone). */
    authorRole: string | null;
    bundle: () => Promise<Bundle>;
  }>;
  /** Settle the bundle's `space_items` rows once everything has moved. */
  settle: (tx: Tx, ids: string[], now: Date) => Promise<void>;
};

/**
 * The move itself, shared by both Accepts: in one transaction, locate and
 * lock the item, take its bundle, lock what is still in the space, re-own
 * every item (same ids), stage its bytes, settle the state rows and discard
 * leftover drafts. After the commit the bytes are put in place, each moved
 * item is announced to the extractor once, and the item's link follows its
 * level.
 */
async function moveIntoBrain(
  brainId: string,
  id: string,
  opts: AcceptOptions,
  steps: AcceptSteps,
): Promise<AcceptResult> {
  if (opts.audience !== undefined && !isViewerLevel(opts.audience)) {
    throw new ReviewError('invalid', 'Pick a level.');
  }
  // A client from before the tree names one Files folder for every file.
  const legacyFolder = opts.folderId === undefined ? opts.folderPath?.trim() || null : null;
  if (legacyFolder && !isFilesPath(legacyFolder)) {
    throw new ReviewError('invalid', 'Pick a folder under Files.');
  }

  // Outside the transaction: lazy, idempotent, and it may create a directory.
  await ensureFilesRootBranch(brainId).catch((err) => {
    if (!isUniqueViolation(err)) throw err;
  });

  const onCommit: (() => Promise<unknown>)[] = [];
  const onRollback: (() => Promise<unknown>)[] = [];
  let result: AcceptResult;
  try {
    result = await db.transaction(async (tx) => {
      // 0. The brain's share lock (shared), before any row lock: a folder
      //    rename, move or delete holds it exclusive and then updates the
      //    drafts under the folder (carrySpaceRows), so taking a draft's row
      //    first and this lock after would deadlock (review F3). Held to the
      //    end, it also keeps the folders planned below from moving.
      await takeShareReadLock(tx, brainId);

      // 1. The item, located and locked by the caller's own rule, and its
      //    level by its author's role (client logins C1).
      const { spaceId, root, authorRole, bundle: bundleOf } = await steps.locate(tx);
      const audience = acceptLevel(authorRole, opts);

      // 2. Destinations are planned below (3a), every tree kind alike: pages
      //    do not nest (folder phase 7), so the old `parentPageId` is ignored.
      void root;

      // 3. The bundle, and every row in it locked, still in this space. An
      //    item another Accept moved first (a shared embed) is the brain's
      //    now: it is dropped here, never moved twice (audit F31).
      const bundle = await bundleOf();
      const still = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            inArray(
              nodes.id,
              bundle.items.map((b) => b.id),
            ),
            eq(nodes.ownerId, spaceId),
          ),
        )
        .for('update');
      const inSpace = new Set(still.map((r) => r.id));
      if (!inSpace.has(root.id)) throw notFound();
      const items = bundle.items.filter((b) => inSpace.has(b.id));
      const ids = items.map((b) => b.id);

      // 3a. Where each item lands, planned before anything moves (read
      //     only), and the share it is read at there (folder plan phase 5):
      //     in a shared folder an item is read at the more open of its level
      //     and the folder's share (migration 0204), so a landing that reads
      //     above the chosen level needs the admin's confirmation, listed
      //     item by item (the bundle too: its items land where they were
      //     filed). Refused before anything moves.
      const storedPath = new Map(
        (
          await tx
            .select({ id: nodes.id, path: nodes.path })
            .from(nodes)
            .where(inArray(nodes.id, ids))
        ).map((r) => [r.id, String(r.path)]),
      );
      const plans = new Map<string, PlacePlan>();
      const landingOf = new Map<string, string>();
      for (const b of items) {
        if (b.type === 'file' && legacyFolder) {
          landingOf.set(b.id, legacyFolder);
          continue;
        }
        const from = storedPath.get(b.id);
        if (!treeKindOfType(b.type) || from === undefined) continue;
        const plan = await planPlace(
          tx,
          brainId,
          spaceId,
          { type: b.type, path: from },
          b.id === id ? opts.folderId : undefined,
        );
        if (!plan) throw new ReviewError('invalid', 'That folder is not in the brain.');
        plans.set(b.id, plan);
        landingOf.set(b.id, plan.target);
      }
      // The brain folders at and above every landing, locked against a share
      // change until the Accept commits: the share read here is the share
      // it lands under (the share lock is held since step 0).
      const landings = [...new Set(landingOf.values())];
      if (landings.length) {
        await tx.execute(sql`
          select 1 from nodes
           where owner_id = ${brainId} and type = 'branch'
             and path @> any(${`{${landings.join(',')}}`}::ltree[])
           for share`);
      }
      const shares = await sharesAt(
        tx,
        brainId,
        items.flatMap((b) => {
          const at = landingOf.get(b.id);
          return at ? [{ id: b.id, path: at, type: b.type }] : [];
        }),
      );
      const readAtOf = (itemId: string): ViewerLevel =>
        effectiveLevel(audience, shares.get(itemId) ?? null) as ViewerLevel;
      const readAt = readAtOf(id);
      const exposed: TreeVisibilityChange[] = items
        .filter((b) => readAtOf(b.id) !== audience)
        .map((b) => ({ id: b.id, title: b.title, from: audience, to: readAtOf(b.id) }));
      if (opts.visibilityConfirmed !== true) {
        // What the bundle embeds is read through it at the folder's share
        // (0208) too, whoever wrote it: listed with it, before anything moves,
        // even when the item itself is read at the level chosen (review F1).
        const throughEmbeds = await embedsReadThrough(tx, brainId, items, shares);
        if (exposed.length || throughEmbeds.length) throw visibilityError(exposed, throughEmbeds);
      }

      // 3b. A client's item read at client or public (audit A28), by its
      //     level or by the folder it lands in: the admin confirmed the
      //     level AND ticked every brain item that goes down with it, read
      //     here on the locked rows. Refused before anything moves, with the
      //     list, so the dialog can show it.
      if (needsLevelConfirm(authorRole, readAt)) {
        const goingDown = (await acceptClosure(tx, brainId, spaceId, items)).filter((c) =>
          levelAbove(c.audience, readAt),
        );
        const ticked = new Set(opts.confirmedIds ?? []);
        if (opts.lowerConfirmed !== true || goingDown.some((g) => !ticked.has(g.id))) {
          throw confirmLevelError(readAt, goingDown);
        }
      }
      const sharing = await tx
        .select({ id: spaceItems.nodeId, sharing: spaceItems.sharing })
        .from(spaceItems)
        .where(inArray(spaceItems.nodeId, ids));
      const wasTeam = new Set(sharing.filter((s) => s.sharing === 'team').map((s) => s.id));

      if (items.some((b) => b.type === 'page')) {
        await ensureBrainRoot(tx, brainId, PAGES_ROOT_LABEL, 'Pages');
      }
      if (items.some((b) => b.type === 'note')) {
        await ensureBrainRoot(tx, brainId, NOTES_ROOT_LABEL, 'Notes');
      }
      if (items.some((b) => b.type === 'draw')) {
        await ensureBrainRoot(tx, brainId, DRAWS_ROOT_LABEL, 'Draw');
      }
      if (items.some((b) => b.type === 'table')) {
        await ensureBrainRoot(tx, brainId, TREE_KIND_SPECS.tables.root, 'Tables');
      }
      if (legacyFolder && items.some((b) => b.type === 'file')) {
        const [f] = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(
            and(
              eq(nodes.ownerId, brainId),
              eq(nodes.type, 'branch'),
              sql`${nodes.path}::text = ${legacyFolder}`,
            ),
          )
          .limit(1);
        if (!f) throw new ReviewError('invalid', 'That folder is not in the brain.');
      }

      /** Where a tree kind's item lands (planned in 3a): in place, or (the
       *  item itself) the admin's pick, with its brain folders made. */
      const fromPaths: string[] = [];
      const landing = async (b: BundleItem, stored: string): Promise<string> => {
        const plan = plans.get(b.id);
        if (!plan) throw new ReviewError('invalid', 'That folder is not in the brain.');
        await ensurePlaced(tx, brainId, plan);
        fromPaths.push(stored);
        return plan.target;
      };

      // 4. Re-own, kind by kind.
      // A file's name as filed, before the brain folder made it unique (a
      // `-2` says another file of that name is there): the name its
      // snapshot keeps (audit L7).
      const authorNames = new Map<string, string>();
      const now = new Date();
      for (const b of items) {
        const [n] = await tx.select().from(nodes).where(eq(nodes.id, b.id)).limit(1);
        if (!n) continue;
        const common = { ownerId: brainId, audience, updatedAt: now };
        switch (b.type) {
          case 'page': {
            // In its brain folder, like a note (folder phase 7); parent_id
            // means nothing for a page and is cleared.
            const at = await landing(b, String(n.path));
            await tx
              .update(nodes)
              .set({ ...common, parentId: null, path: sql`${at}::ltree` })
              .where(eq(nodes.id, b.id));
            await tx
              .update(pages)
              .set({ draftDoc: null, draftUpdatedAt: null })
              .where(eq(pages.nodeId, b.id));
            break;
          }
          case 'note': {
            const at = await landing(b, String(n.path));
            await tx
              .update(nodes)
              .set({ ...common, path: sql`${at}::ltree` })
              .where(eq(nodes.id, b.id));
            break;
          }
          case 'draw': {
            const at = await landing(b, String(n.path));
            await tx
              .update(nodes)
              .set({ ...common, path: sql`${at}::ltree` })
              .where(eq(nodes.id, b.id));
            await tx
              .update(draws)
              .set({ draftScene: null, draftUpdatedAt: null })
              .where(eq(draws.nodeId, b.id));
            break;
          }
          case 'table': {
            const at = await landing(b, String(n.path));
            const [t] = await tx
              .select({ storagePath: tables.storagePath })
              .from(tables)
              .where(eq(tables.nodeId, b.id))
              .limit(1);
            let storagePath = t?.storagePath ?? null;
            if (storagePath) {
              const src = resolveStoragePath(storagePath);
              const dest = publishedPath(brainId, b.id);
              // VACUUM INTO: a consistent copy even with a WAL beside it.
              snapshotFile(src, dest);
              onRollback.push(async () => removeTableFile(dest));
              onCommit.push(async () => {
                removeTableFile(draftAbsFor(storagePath!));
                removeTableFile(src);
              });
              storagePath = relativeStoragePath(brainId, b.id);
            }
            await tx
              .update(nodes)
              .set({ ...common, path: sql`${at}::ltree` })
              .where(eq(nodes.id, b.id));
            await tx
              .update(tables)
              .set({ storagePath, draftData: null, draftUpdatedAt: null })
              .where(eq(tables.nodeId, b.id));
            break;
          }
          case 'file': {
            const folder = legacyFolder ?? (await landing(b, String(n.path)));
            const data = { ...((n.data ?? {}) as Record<string, unknown>) };
            const display =
              typeof data.filename === 'string' && data.filename ? data.filename : n.title;
            const wanted = sanitizeFilename(display) || `file-${b.id.slice(0, 8)}`;
            authorNames.set(b.id, wanted);
            const name = await freeFileName(tx, brainId, folder, wanted);
            const dest = diskPathForFile(folder, name);
            if (!dest) throw new ReviewError('invalid', `Cannot file '${display}' in that folder.`);
            // Staged under a dot name, which the files watcher ignores: the
            // watcher must never see the bytes before the node is the brain's.
            const staged = path.join(path.dirname(dest), `.accept-${b.id}`);
            await mkdir(path.dirname(dest), { recursive: true });
            await copyFile(spaceFilePath(spaceId, b.id), staged);
            onRollback.push(() => rm(staged, { force: true }));
            onCommit.push(async () => {
              await rename(staged, dest);
              await removeSpaceFile(spaceId, b.id);
            });
            const extension = extOf(name);
            const size = Number(data.size_bytes ?? 0);
            delete data.storage;
            const content =
              TEXT_EXTS.has(extension) && size <= TEXT_CACHE_MAX_BYTES
                ? readFileSync(staged).toString('utf8')
                : undefined;
            await tx
              .update(nodes)
              .set({
                ...common,
                path: sql`${folder}::ltree`,
                slug: name,
                data: {
                  ...data,
                  filename: name,
                  extension,
                  mime_type: mimeForExt(extension),
                  ...(content !== undefined ? { content } : {}),
                },
              })
              .where(eq(nodes.id, b.id));
            break;
          }
        }
      }

      // 4a. The member's own folders that held what moved and hold nothing
      //     now go: their brain twins took their place.
      await dropEmptyOwnFolders(tx, spaceId, fromPaths);

      // 4b. Embedding means sharing: at a level below admin, what the item
      //     embeds that is already the brain's (a Library item) goes down
      //     with it, to the level the admin chose. The share of the folder it
      //     lands in reaches its embeds through the database instead
      //     (nodes.embedded_level, migration 0208), and goes again when the
      //     folder is unshared or the item moves out. The bundle itself took
      //     the level above.
      const { lowered: alsoLowered } = await lowerEmbedClosure(brainId, id, audience, tx);
      // What the moved pages, and the pages they reach through embeds,
      // index is their new level's (pages/level-text.ts, SQL only); the
      // extractor hears of the moved ones once, below, as before.
      const reached = (await tx.execute(sql`
        select r.id::text as id from mantle_embeds_reached(${brainId}::uuid, array[${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )}]) r`)) as unknown as Array<{ id: string }>;
      await refoldPageTexts(
        brainId,
        reached.map((r) => r.id),
        tx,
      );

      // 5. The state rows, settled by the caller's rule; the recorded
      //    bundles of what moved are done with. Every item now accepted
      //    with an author record gets its author's snapshot (audit F07): the
      //    version accepted, which is all the author reads from now on.
      await steps.settle(tx, ids, now);
      await clearBundles(tx, ids);
      await writeAcceptedSnapshots(tx, brainId, ids, { onRollback, fileNames: authorNames });

      // 6. The change events commit with the move: to the space it left,
      //    and to its author's own space when that is another one (an item
      //    an admin took over), so the author's lists follow.
      for (const b of items) {
        await notifySpaceItemChanged(b.id, 'state', { spaceId, team: wasTeam.has(b.id) }, tx);
      }
      const authors = await tx
        .select({ id: spaceItems.nodeId, author: spaceItems.authorLoginId })
        .from(spaceItems)
        .where(inArray(spaceItems.nodeId, ids));
      for (const a of authors) {
        const home = await personalSpaceOf(tx, a.author);
        if (home && home !== spaceId) {
          await notifySpaceItemChanged(a.id, 'state', { spaceId: home, team: false }, tx);
        }
      }
      return {
        id,
        audience,
        readAt,
        moved: items,
        linksStayingBehind: bundle.linksStayingBehind,
        alsoLowered,
      };
    });
  } catch (err) {
    for (const fn of onRollback) await fn().catch(() => {});
    if (isBusy(err)) throw new ReviewError('busy', BUSY_MESSAGE);
    throw err;
  }

  for (const fn of onCommit) {
    await fn().catch((err: unknown) =>
      console.error('[member-review] accept: moving bytes after commit failed:', err),
    );
  }
  // 7. Announced once per moved item, after the commit AND after the bytes
  //    are in place (audit F31): the extractor never opens a file that is
  //    still being renamed. Never for a rollback.
  for (const b of result.moved) {
    await db
      .execute(sql`select pg_notify('node_ingested', ${b.id}::text)`)
      .catch((err: unknown) =>
        console.error('[member-review] accept: announcing a moved item failed:', err),
      );
  }
  // The item's link follows its level (levels drive links). The level itself
  // is already stored for the whole bundle.
  if (result.audience !== 'admin') {
    try {
      await setItemLevel(brainId, id, result.audience);
    } catch (err) {
      result.levelWarning = err instanceof Error ? err.message : String(err);
    }
  }
  return result;
}

// ── Return (plan 2d) ────────────────────────────────────────────────────────

/** Return a submitted item to its author with a note: back to them to edit,
 *  the note shown as a banner. Only a submitted item can be returned. */
export async function returnReviewItem(
  id: string,
  reviewer: { loginId: string },
  note: string,
  /** The brain: needed to return a released taken item (its give-back
   *  checks the member's embed rule against the Library). */
  brainId?: string,
): Promise<void> {
  const text = note.trim().slice(0, 4000);
  if (!text) throw new ReviewError('invalid', 'Say what needs to change.');
  // A taken item whose admin is gone comes back to its author the way a
  // give-back does: out of that admin's space, bytes and all.
  const found = await reviewRow(id);
  if (found?.row.reviewState === 'taken') {
    if (!brainId) throw new Error('returnReviewItem: a taken item needs the brain id');
    await giveBackTaken(
      brainId,
      { spaceId: found.spaceId, reviewerId: reviewer.loginId },
      id,
      text,
      {
        // Still released under the lock (its admin did not come back).
        locate: async (tx) => (await reviewRow(id, tx))?.row.reviewState === 'taken',
        dropDrafts: true,
      },
    );
    return;
  }
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(spaceItems)
      .set({
        reviewState: 'returned',
        returnedNote: text,
        reviewedBy: reviewer.loginId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(spaceItems.nodeId, id),
          eq(spaceItems.reviewState, 'submitted'),
          sql`exists (select 1 from nodes n join spaces s on s.id = n.owner_id
                       where n.id = ${id} and s.kind = 'personal')`,
          // A member's or a client's item only: never an admin's own (Phase 7),
          // never a role this code does not know (client logins C1).
          sql`not exists (select 1 from auth.users u
                           where u.id = ${spaceItems.authorLoginId}
                             and u.role not in ('member', 'client'))`,
        ),
      )
      .returning({ sharing: spaceItems.sharing });
    if (!updated.length) throw notFound();
    // Back with the author: its bundle unfreezes.
    await clearBundles(tx, [id]);
    await notifySpaceItemChanged(id, 'state', undefined, tx);
  });
}

// ── Discard (plan 6.4) ──────────────────────────────────────────────────────

/**
 * Discard an item a deactivated (or deleted) login left behind: shared with
 * the team, or submitted, or taken over by an admin who is gone too (then
 * with everything taken with it). An active author's item is never
 * discarded here (Return it instead). The bytes go once the delete has
 * committed.
 */
export async function discardLeftBehind(id: string): Promise<void> {
  const onCommit: (() => unknown)[] = [];
  await db.transaction(async (tx) => {
    // The state row, locked as Accept locks it: a Recall, Return or Accept
    // of this item waits, or wins.
    const [locked] = await tx
      .select({ id: spaceItems.nodeId })
      .from(spaceItems)
      .where(eq(spaceItems.nodeId, id))
      .for('update')
      .limit(1);
    if (!locked) throw notFound();
    const found = await reviewRow(id, tx);
    if (!found) throw notFound();
    if (!found.row.author.inactive) {
      throw new ReviewError(
        'not-left-behind',
        'The author can still sign in. Return the item instead of discarding it.',
      );
    }
    const { spaceId } = found;
    // A released taken item goes with what was taken with it (all of it is
    // the gone author's, in the gone admin's space; nothing of the admin's).
    const doomed =
      found.row.reviewState === 'taken'
        ? await takenGroup(tx, spaceId, id)
        : [{ id, type: found.row.type, title: found.row.title }];
    const doomedIds = doomed.map((d) => d.id);
    // Deleted only while it is still in the space (audit F03): an Accept of
    // another item that moves this one along (a shared embed) re-owns it to
    // the brain, and the delete, re-checked on the new row, then matches
    // nothing. Never a brain row.
    const workbooks = await tx
      .select({ id: tables.nodeId, storagePath: tables.storagePath })
      .from(tables)
      .where(inArray(tables.nodeId, doomedIds));
    const gone = await tx
      .delete(nodes)
      .where(and(inArray(nodes.id, doomedIds), eq(nodes.ownerId, spaceId)))
      .returning({ id: nodes.id });
    const goneIds = new Set(gone.map((g) => g.id));
    if (!goneIds.has(id)) throw notFound();
    for (const d of doomed) {
      if (d.type === 'file' && goneIds.has(d.id)) {
        onCommit.push(() => removeSpaceFile(spaceId, d.id));
      }
    }
    for (const w of workbooks) {
      const sp = w.storagePath;
      if (!sp || !goneIds.has(w.id)) continue;
      onCommit.push(() => {
        removeTableFile(draftAbsFor(sp));
        removeTableFile(resolveStoragePath(sp));
      });
    }
    await notifySpaceItemChanged(
      id,
      'deleted',
      { spaceId, team: found.row.sharing === 'team' },
      tx,
    );
  });
  for (const fn of onCommit) {
    try {
      await fn();
    } catch (err) {
      console.error('[member-review] discard: removing bytes failed:', err);
    }
  }
}
