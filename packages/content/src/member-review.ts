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
 * that renders inside it (embed-refs.ts `embeds`, repeated until nothing new
 * joins) moves into the brain with the same node ids, so every link to it
 * stays valid. Only the author's own items join; links and mentions stay
 * where they are, and the admin is told how many point at items that stay in
 * a personal space. Bytes move beside the rows: staged before the commit,
 * put in place after it, removed again on a rollback.
 *
 * Cost-safety: Accept is the ONE place a personal item is announced to the
 * extractor, once per moved item, inside the transaction (delivered on
 * commit, never for a rollback). Nothing else here starts LLM work.
 */
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
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
  refLikeCells,
  relativeStoragePath,
  resolveStoragePath,
  snapshotFile,
} from '@mantle/tabledb';
import { cellRefs, noteRefs, pageRefs, sceneRefs, type EmbedRefs } from './embed-refs';
import { COMMENT_BODY_MAX } from './node-comments';
import { notifySpaceItemChanged } from './member-space-events';
import {
  SPACE_ITEM_KINDS,
  spaceItemBody,
  type SpaceItemBody,
  type SpaceItemKind,
} from './member-space';
import { spaceFileOf, type OpenedSpaceFile } from './member-space-files';
import { DRAWS_ROOT_LABEL, getDrawSvg } from './draws';
import { NOTES_ROOT_LABEL } from './notes';
import { PAGES_ROOT_LABEL } from './pages/shared';
import { childPagePath } from './page-path';
import { draftAbsFor, removeTableFile } from './table-storage';
import { dedupeFilename } from './dedupe-filename';
import { setItemLevel } from './access';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Why a review action was refused. Routes answer 404 for `not-found` (a
 *  private item looks exactly like one that does not exist), 400 for
 *  `invalid`, 409 for the rest. */
export class ReviewError extends Error {
  constructor(
    readonly reason: 'not-found' | 'not-submitted' | 'not-left-behind' | 'invalid' | 'too-large',
    message: string,
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
 *  deactivated (or deleted) login while shared with the team. */
export type ReviewReason = 'submitted' | 'left-behind';

export type ReviewAuthor = {
  loginId: string | null;
  name: string;
  email: string | null;
  /** Deactivated, or the login is gone. */
  inactive: boolean;
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

/**
 * The one condition under which an admin reads a personal item (see the
 * module comment). `spaces.kind = 'personal'` keeps brain items out.
 */
const reviewable: SQL = and(
  eq(spaces.kind, 'personal'),
  inArray(nodes.type, [...SPACE_ITEM_KINDS]),
  or(
    eq(spaceItems.reviewState, 'submitted'),
    and(
      eq(spaceItems.sharing, 'team'),
      sql`${spaceItems.reviewState} <> 'accepted'`,
      authorInactive,
    ),
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
      },
    })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .leftJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId));
}

type Joined = Awaited<ReturnType<typeof reviewQuery>>[number];

function rowOf({ node, item, author }: Joined): ReviewItemRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const inactive = !author?.id || author.disabledAt !== null;
  return {
    id: node.id,
    type: node.type as SpaceItemKind,
    title: node.title,
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    sharing: item.sharing,
    reviewState: item.reviewState,
    submittedAt: item.submittedAt?.toISOString() ?? null,
    updatedAt: node.updatedAt.toISOString(),
    reason: item.reviewState === 'submitted' ? 'submitted' : 'left-behind',
    author: {
      loginId: author?.id ?? null,
      name: author?.displayName?.trim() || author?.email?.split('@')[0] || 'Removed login',
      email: author?.email ?? null,
      inactive,
    },
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** Everything waiting for an admin: submitted items (oldest first), then
 *  what deactivated logins left shared with the team. */
export async function listReviewQueue(): Promise<{
  items: ReviewItemRow[];
  counts: { submitted: number; leftBehind: number };
}> {
  const rows = await reviewQuery()
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

/** How many items wait for review (the nav badge). */
export async function countSubmitted(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .where(and(eq(spaces.kind, 'personal'), eq(spaceItems.reviewState, 'submitted')));
  return r?.n ?? 0;
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
export async function listReviewComments(id: string): Promise<NodeCommentDbRow[] | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  return db
    .select()
    .from(nodeComments)
    .where(
      and(
        eq(nodeComments.nodeId, id),
        found.row.sharing === 'team' ? undefined : eq(nodeComments.threadScope, 'review'),
      ),
    )
    .orderBy(asc(nodeComments.createdAt));
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
    if (!si || (si.state !== 'submitted' && !(await reviewRow(id, tx)))) throw notFound();
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

// ── The bundle (plan 6.2) ───────────────────────────────────────────────────

export type BundleItem = { id: string; type: SpaceItemKind; title: string };

export type Bundle = {
  /** The item first, then what it brings along. */
  items: BundleItem[];
  /** Links and mentions that point at items that stay in a personal space:
   *  they will not open for anyone who reads the accepted item. */
  linksStayingBehind: number;
};

/** A bundle bigger than this is refused: nobody reviews that much at once. */
export const BUNDLE_MAX_ITEMS = 200;

/** The references one item carries, read from its SAVED version. */
async function refsOf(via: Pick<Tx, 'select'>, item: BundleItem): Promise<EmbedRefs[]> {
  switch (item.type) {
    case 'page': {
      const [p] = await via
        .select({ doc: pages.doc })
        .from(pages)
        .where(eq(pages.nodeId, item.id))
        .limit(1);
      return p ? [pageRefs(p.doc)] : [];
    }
    case 'note': {
      const [n] = await via
        .select({ data: nodes.data })
        .from(nodes)
        .where(eq(nodes.id, item.id))
        .limit(1);
      const content = (n?.data as Record<string, unknown> | null)?.content;
      return typeof content === 'string' ? [noteRefs(content)] : [];
    }
    case 'draw': {
      const [d] = await via
        .select({ scene: draws.scene, fileRefs: draws.fileRefs })
        .from(draws)
        .where(eq(draws.nodeId, item.id))
        .limit(1);
      if (!d) return [];
      // A drawing's own images are its file refs: they render inside it.
      const files = Object.values((d.fileRefs ?? {}) as Record<string, string>).filter(
        (v) => typeof v === 'string',
      );
      return [sceneRefs(d.scene), { ids: files, refused: [], embeds: files }];
    }
    case 'table': {
      const [t] = await via
        .select({ storagePath: tables.storagePath })
        .from(tables)
        .where(eq(tables.nodeId, item.id))
        .limit(1);
      if (!t?.storagePath) return [];
      const file = resolveStoragePath(t.storagePath);
      return existsSync(file) ? [cellRefs(refLikeCells(file))] : [];
    }
    case 'file':
      return [];
  }
}

/**
 * The item plus everything that renders inside it, repeated until nothing new
 * joins. Only items of the SAME space join (the author's own); a child page
 * joins with its parent. Read from saved versions on the given connection
 * (the accept transaction, so it sees what it locks).
 */
async function computeBundle(
  via: Pick<Tx, 'select'>,
  spaceId: string,
  root: BundleItem,
): Promise<Bundle> {
  const items: BundleItem[] = [root];
  const inBundle = new Set([root.id]);
  const links = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const embeds = new Set<string>();
    for (const r of await refsOf(via, item)) {
      for (const id of r.embeds) embeds.add(id);
      for (const id of r.ids) if (!r.embeds.includes(id)) links.add(id);
    }
    if (item.type === 'page') {
      const kids = await via
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(eq(nodes.parentId, item.id), eq(nodes.ownerId, spaceId), eq(nodes.type, 'page')),
        );
      for (const k of kids) embeds.add(k.id);
    }
    const fresh = [...embeds].filter((id) => !inBundle.has(id));
    if (!fresh.length) continue;
    const joined = await via
      .select({ id: nodes.id, type: nodes.type, title: nodes.title })
      .from(nodes)
      .where(
        and(
          inArray(nodes.id, fresh),
          eq(nodes.ownerId, spaceId),
          inArray(nodes.type, [...SPACE_ITEM_KINDS]),
        ),
      );
    for (const j of joined) {
      inBundle.add(j.id);
      items.push({ id: j.id, type: j.type as SpaceItemKind, title: j.title });
    }
    if (items.length > BUNDLE_MAX_ITEMS) {
      throw new ReviewError(
        'too-large',
        `This item brings more than ${BUNDLE_MAX_ITEMS} items with it. Return it and ask for a smaller one.`,
      );
    }
  }
  const rest = [...links].filter((id) => !inBundle.has(id));
  let linksStayingBehind = 0;
  if (rest.length) {
    const [r] = await via
      .select({ n: sql<number>`count(*)::int` })
      .from(nodes)
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(and(inArray(nodes.id, rest), eq(spaces.kind, 'personal')));
    linksStayingBehind = r?.n ?? 0;
  }
  return { items, linksStayingBehind };
}

/** What Accept would move, for the accept dialog. Null when not reviewable. */
export async function previewAccept(id: string): Promise<Bundle | null> {
  const found = await reviewRow(id);
  if (!found) return null;
  const { row } = found;
  return computeBundle(db, found.spaceId, { id: row.id, type: row.type, title: row.title });
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
    const { row } = found;
    const bundle = await computeBundle(db, found.spaceId, {
      id: row.id,
      type: row.type,
      title: row.title,
    });
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
    const { row } = found;
    const bundle = await computeBundle(db, found.spaceId, {
      id: row.id,
      type: row.type,
      title: row.title,
    });
    if (!bundle.items.some((b) => b.id === drawId && b.type === 'draw')) return null;
  }
  return getDrawSvg(found.spaceId, drawId);
}

// ── Accept (plan 6.2) ───────────────────────────────────────────────────────

export type AcceptOptions = {
  /** The level the accepted item (and everything that moves with it) gets.
   *  Admin by default (decided 2026-09-25). */
  audience?: ViewerLevel;
  /** A brain page to nest the accepted page under (pages only). */
  parentPageId?: string | null;
  /** The brain Files folder the bundle's files land in (default `files`). */
  folderPath?: string | null;
};

export type AcceptResult = {
  id: string;
  audience: ViewerLevel;
  moved: BundleItem[];
  linksStayingBehind: number;
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

/** A file name the brain folder and the brain's slugs do not hold yet. */
async function freeFileName(tx: Tx, brainId: string, folder: string, wanted: string) {
  const taken = await tx
    .select({ slug: nodes.slug, filename: sql<string | null>`${nodes.data}->>'filename'` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, brainId),
        sql`${nodes.type} <> 'branch'`,
        or(
          sql`lower(${nodes.slug}) like lower(${`${wanted.replace(/\.[^.]*$/, '')}%`})`,
          and(eq(nodes.type, 'file'), sql`${nodes.path}::text = ${folder}`),
        ),
      ),
    );
  const names = new Set<string>();
  for (const t of taken) {
    if (t.slug) names.add(t.slug);
    if (t.filename) names.add(t.filename);
  }
  return dedupeFilename(wanted, names);
}

/**
 * Accept a reviewable item into the brain (plan 6.2). One transaction: lock
 * the item's state row (a Recall that lands first wins: not found), compute
 * the bundle, re-own every item in it (same ids), stage its bytes, mark every
 * space_items row accepted (the row stays: it records the author), discard
 * leftover drafts, set the level, and announce each moved item to the
 * extractor once. Then, after the commit, the bytes are put in
 * place and the item's link follows its level.
 */
export async function acceptReviewItem(
  brainId: string,
  id: string,
  reviewer: { loginId: string },
  opts: AcceptOptions = {},
): Promise<AcceptResult> {
  const audience: ViewerLevel = opts.audience ?? 'admin';
  if (!isViewerLevel(audience)) throw new ReviewError('invalid', 'Pick a level.');
  const folder = opts.folderPath?.trim() || 'files';
  if (!isFilesPath(folder)) throw new ReviewError('invalid', 'Pick a folder under Files.');

  // Outside the transaction: lazy, idempotent, and it may create a directory.
  await ensureFilesRootBranch(brainId).catch((err) => {
    if (!(err instanceof Error) || !/duplicate|unique/i.test(err.message)) throw err;
  });

  const onCommit: (() => Promise<unknown>)[] = [];
  const onRollback: (() => Promise<unknown>)[] = [];
  let result: AcceptResult;
  try {
    result = await db.transaction(async (tx) => {
      // 1. The state row, locked. A Recall, Return or second Accept waits.
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
      const spaceId = found.spaceId;
      const root: BundleItem = { id, type: found.row.type, title: found.row.title };

      // 2. Destinations, checked before anything moves.
      let parent: { id: string; path: string } | null = null;
      if (opts.parentPageId) {
        if (root.type !== 'page') {
          throw new ReviewError('invalid', 'Only a page can go under a parent page.');
        }
        const [p] = await tx
          .select({ id: nodes.id, path: nodes.path })
          .from(nodes)
          .where(
            and(
              eq(nodes.id, opts.parentPageId),
              eq(nodes.ownerId, brainId),
              eq(nodes.type, 'page'),
            ),
          )
          .limit(1);
        if (!p) throw new ReviewError('invalid', 'That parent page is not in the brain.');
        parent = { id: p.id, path: String(p.path) };
      }

      // 3. The bundle, and every row in it locked.
      const bundle = await computeBundle(tx, spaceId, root);
      const ids = bundle.items.map((b) => b.id);
      await tx.select({ id: nodes.id }).from(nodes).where(inArray(nodes.id, ids)).for('update');
      const sharing = await tx
        .select({ id: spaceItems.nodeId, sharing: spaceItems.sharing })
        .from(spaceItems)
        .where(inArray(spaceItems.nodeId, ids));
      const wasTeam = new Set(sharing.filter((s) => s.sharing === 'team').map((s) => s.id));

      if (bundle.items.some((b) => b.type === 'page')) {
        await ensureBrainRoot(tx, brainId, PAGES_ROOT_LABEL, 'Pages');
      }
      if (bundle.items.some((b) => b.type === 'note')) {
        await ensureBrainRoot(tx, brainId, NOTES_ROOT_LABEL, 'Notes');
      }
      if (bundle.items.some((b) => b.type === 'draw')) {
        await ensureBrainRoot(tx, brainId, DRAWS_ROOT_LABEL, 'Draw');
      }
      if (bundle.items.some((b) => b.type === 'file')) {
        const [f] = await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(
            and(
              eq(nodes.ownerId, brainId),
              eq(nodes.type, 'branch'),
              sql`${nodes.path}::text = ${folder}`,
            ),
          )
          .limit(1);
        if (!f) throw new ReviewError('invalid', 'That folder is not in the brain.');
      }

      // 4. Re-own, kind by kind. Pages first in bundle order: a child's new
      //    path extends its parent's, which is set by then.
      const newPagePath = new Map<string, string>();
      const now = new Date();
      for (const b of bundle.items) {
        const [n] = await tx.select().from(nodes).where(eq(nodes.id, b.id)).limit(1);
        if (!n) continue;
        const common = { ownerId: brainId, audience, updatedAt: now };
        switch (b.type) {
          case 'page': {
            const inside = n.parentId ? newPagePath.get(n.parentId) : undefined;
            let parentId: string | null = null;
            let p = PAGES_ROOT_LABEL;
            if (inside !== undefined) {
              parentId = n.parentId;
              p = childPagePath(inside, b.id);
            } else if (b.id === id && parent) {
              parentId = parent.id;
              p = childPagePath(parent.path, b.id);
            }
            newPagePath.set(b.id, p);
            await tx
              .update(nodes)
              .set({ ...common, parentId, path: sql`${p}::ltree` })
              .where(eq(nodes.id, b.id));
            await tx
              .update(pages)
              .set({ draftDoc: null, draftUpdatedAt: null })
              .where(eq(pages.nodeId, b.id));
            break;
          }
          case 'note':
            await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
            break;
          case 'draw':
            await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
            await tx
              .update(draws)
              .set({ draftScene: null, draftUpdatedAt: null })
              .where(eq(draws.nodeId, b.id));
            break;
          case 'table': {
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
            await tx.update(nodes).set(common).where(eq(nodes.id, b.id));
            await tx
              .update(tables)
              .set({ storagePath, draftData: null, draftUpdatedAt: null })
              .where(eq(tables.nodeId, b.id));
            break;
          }
          case 'file': {
            const data = { ...((n.data ?? {}) as Record<string, unknown>) };
            const display =
              typeof data.filename === 'string' && data.filename ? data.filename : n.title;
            const wanted = sanitizeFilename(display) || `file-${b.id.slice(0, 8)}`;
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

      // 5. The state rows: accepted, by whom. They stay: they record the author.
      await tx
        .update(spaceItems)
        .set({
          reviewState: 'accepted',
          reviewedBy: reviewer.loginId,
          reviewedAt: now,
          acceptedAt: now,
          updatedAt: now,
        })
        .where(inArray(spaceItems.nodeId, ids));

      // 6. Announced once per moved item, in this transaction: the extractor
      //    hears of it on commit, when the item is the brain's.
      for (const b of bundle.items) {
        await tx.execute(sql`select pg_notify('node_ingested', ${b.id}::text)`);
        await notifySpaceItemChanged(b.id, 'state', { spaceId, team: wasTeam.has(b.id) }, tx);
      }
      return { id, audience, moved: bundle.items, linksStayingBehind: bundle.linksStayingBehind };
    });
  } catch (err) {
    for (const fn of onRollback) await fn().catch(() => {});
    throw err;
  }

  for (const fn of onCommit) {
    await fn().catch((err: unknown) =>
      console.error('[member-review] accept: moving bytes after commit failed:', err),
    );
  }
  // The item's link follows its level (levels drive links). The level itself
  // is already stored for the whole bundle.
  if (audience !== 'admin') {
    try {
      await setItemLevel(brainId, id, audience);
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
): Promise<void> {
  const text = note.trim().slice(0, 4000);
  if (!text) throw new ReviewError('invalid', 'Say what needs to change.');
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
        ),
      )
      .returning({ sharing: spaceItems.sharing });
    if (!updated.length) throw notFound();
    await notifySpaceItemChanged(id, 'state', undefined, tx);
  });
}

// ── Discard (plan 6.4) ──────────────────────────────────────────────────────

/**
 * Discard an item a deactivated (or deleted) login left behind: shared with
 * the team, or submitted. An active author's item is never discarded here
 * (Return it instead). The bytes go once the delete has committed.
 */
export async function discardLeftBehind(id: string): Promise<void> {
  const onCommit: (() => unknown)[] = [];
  await db.transaction(async (tx) => {
    const found = await reviewRow(id, tx);
    if (!found) throw notFound();
    if (!found.row.author.inactive) {
      throw new ReviewError(
        'not-left-behind',
        'The author can still sign in. Return the item instead of discarding it.',
      );
    }
    const { spaceId } = found;
    if (found.row.type === 'file') onCommit.push(() => removeSpaceFile(spaceId, id));
    if (found.row.type === 'table') {
      const [t] = await tx
        .select({ storagePath: tables.storagePath })
        .from(tables)
        .where(eq(tables.nodeId, id))
        .limit(1);
      const sp = t?.storagePath;
      if (sp) {
        onCommit.push(() => {
          removeTableFile(draftAbsFor(sp));
          removeTableFile(resolveStoragePath(sp));
        });
      }
    }
    await notifySpaceItemChanged(
      id,
      'deleted',
      { spaceId, team: found.row.sharing === 'team' },
      tx,
    );
    await tx.delete(nodes).where(eq(nodes.id, id));
  });
  for (const fn of onCommit) {
    try {
      await fn();
    } catch (err) {
      console.error('[member-review] discard: removing bytes failed:', err);
    }
  }
}
