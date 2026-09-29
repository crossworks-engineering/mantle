/**
 * A login's personal space (member logins, Phase 2; plan v3.1 section 2d).
 *
 * Three sources a member works with:
 *  - Mine: items in the caller's own space. Run inside `withSpace`: the space
 *    role and its row rules see and write that space only. Every item carries a
 *    `space_items` row: sharing (private | team) and review state.
 *  - Team drafts: other members' items shared with the team, published
 *    content only. Run inside `withTeamDrafts` (the team role, human flag on).
 *  - Library: brain items at the team level (member-library.ts).
 *
 * Nothing here learns: a personal item is never announced to the extractor,
 * never compiled into Recall, never searched by the brain (the brain's filters
 * key on the brain id; `notifyNodeIngested` and `isBrainOwnerId` refuse inside
 * a space scope). No save, share, submit or recall starts LLM work.
 *
 * The existing content functions do the work: each takes the space id as its
 * owner id. This module adds the space_items state machine and the frozen
 * rule (a submitted item is edited by nobody until Accept, Return or Recall;
 * the row rules hold it too).
 */
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  asSystem,
  authUsers,
  currentSpaceScope,
  currentViewerLevel,
  db,
  spaces,
  withViewer,
  draws,
  nodes,
  pages,
  spaceItems,
  spaceSubmissions,
  tables,
  type ReviewState,
  type SpaceSharing,
} from '@mantle/db';
import { existsSync } from 'node:fs';
import type {
  MemberReviewState,
  MemberSpaceFile,
  MemberSpaceItemBody,
  MemberSpaceItemRow,
  MemberSpaceSharing,
} from '@mantle/client-types';
import {
  MEMBER_ITEM_KINDS as SPACE_ITEM_KINDS,
  type MemberItemKind as SpaceItemKind,
} from '@mantle/client-types/member-kinds';
import { createDraw, deleteDraw, getDraw, getDrawSvg, updateDraw, type DrawDetail } from './draws';
import { createNote, deleteNote, getNote, updateNote, type NoteRow } from './notes';
import { getPage } from './pages/read';
import { commitPage, updatePage, type CommitPageResult } from './pages/draft';
import { cellRefs, noteRefs, pageRefs, sceneRefs, type EmbedRefs } from './embed-refs';
import { commitDraw, type CommitDrawResult } from './draws';
import { notifySpaceItemChanged } from './member-space-events';
import { deletePage, createPage } from './pages/tree';
import type { PageDetail } from './pages/shared';
import { getTable } from './tables/read';
import { createTable, deleteTable, updateTable } from './tables/write';
import { commitTable } from './tables/draft';
import type { TableDoc, WorkbookDoc } from '@mantle/content-core/table-model';
import type { TableDetail } from '@mantle/content-core/table-model';
import { draftAbsFor } from './table-storage';
import { refLikeCells, resolveStoragePath } from '@mantle/tabledb';
import {
  deleteMineFile,
  renameMineFile,
  spaceFileOf,
  type OpenedSpaceFile,
  type SpaceFile,
} from './member-space-files';
import { openSpaceFile } from '@mantle/files';
import { spaceLimits } from './space-limits';
import {
  SpaceItemStateError,
  assertItemRoom,
  requireSpace,
  spaceNotFound as notFound,
} from './member-space-core';
import {
  BUNDLE_MAX_ITEMS,
  bundleHolder,
  clearBundles,
  lockBundleRows,
  recordBundle,
  walkBundle,
  type BundleItem,
} from './member-bundle';

export { SPACE_ITEM_LIMIT, SpaceItemStateError, assertItemRoom } from './member-space-core';

/** What a personal space holds. A table's workbook sits under
 *  TABLE_DB_DIR/<spaceId>/; a file's bytes under MANTLE_SPACES_ROOT/<spaceId>/
 *  (member-space-files.ts). */
export {
  MEMBER_ITEM_KINDS as SPACE_ITEM_KINDS,
  isMemberItemKind as isSpaceItemKind,
  type MemberItemKind as SpaceItemKind,
} from '@mantle/client-types/member-kinds';

/**
 * Who writes a personal item. A member by default. An ADMIN working in their
 * own private space (member logins Phase 7) names the brain they administer:
 * the embed rule then allows that brain's items at any level, since the
 * admin can read them all. The rule re-reads the space's login and widens
 * only for a usable admin login of that brain; anything else keeps the
 * member rule.
 */
export type SpaceWriter = { adminOfBrain?: string };

/** The row is the published contract's own type (audit M3), so the wire
 *  shape the client reads cannot drift from what the brain sends. */
export type SpaceItemRow = MemberSpaceItemRow;

/**
 * A team draft sits in a MEMBER's space. Row security holds it too (0179),
 * but the same human scope also shows clients' submitted items (client
 * requests, 0194): a client's item is never a team draft, even one with a
 * 'team' sharing row, so every team-drafts query names it here.
 */
const inMemberSpace = sql`mantle_member_space(${nodes.ownerId})`;

/** Team drafts run on the team role with the human flag; never at admin. */
function requireTeamDrafts(): void {
  if (currentViewerLevel() === 'admin' || currentSpaceScope()) {
    throw new Error('team drafts read outside withTeamDrafts');
  }
}

type Joined = { node: typeof nodes.$inferSelect; item: typeof spaceItems.$inferSelect | null };

function rowOf({ node, item }: Joined): SpaceItemRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    type: node.type as SpaceItemKind,
    title: node.title,
    icon: typeof d.icon === 'string' && d.icon.trim() ? d.icon : null,
    sharing: item?.sharing ?? 'private',
    reviewState: item?.reviewState ?? 'draft',
    submittedAt: item?.submittedAt?.toISOString() ?? null,
    returnedNote: item?.returnedNote ?? null,
    authorLoginId: item?.authorLoginId ?? null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

function titleFilter(q: string | undefined) {
  const t = q?.trim();
  return t ? ilike(nodes.title, `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined;
}

export type ListSpaceOpts = {
  kind?: SpaceItemKind;
  /** Without `kind`: only these kinds (a CLIENT's space lists pages, notes
   *  and files, client logins C5). Default: every personal kind. */
  kinds?: readonly SpaceItemKind[];
  q?: string;
  /** Only items in these review states (audit U10: the member home's
   *  "Returned" and "Waiting for review" lists read the whole space, not
   *  the first page). An item with no state row counts as a draft.
   *  `with-admin` selects the items an admin has taken over (`withAdmin`). */
  reviewStates?: readonly (ReviewState | 'with-admin')[];
  /** The order, as the brain lists sort (default `edited`, newest save
   *  first): an admin's private rows merge into those lists. */
  sort?: SpaceListSort;
  /** Only items shared this way (the one list's State filter). An item with
   *  no state row counts as private. */
  sharing?: SpaceSharing;
  /** The MEMBER's own list (audit F07): page 1 also carries the caller's
   *  items an admin has taken over, as `with-admin` rows (title and kind
   *  only), before the own rows; `total` counts them. */
  withAdmin?: boolean;
  limit?: number;
  offset?: number;
};

function reviewFilter(all?: readonly (ReviewState | 'with-admin')[]) {
  if (!all?.length) return undefined;
  const states = all.filter((s): s is ReviewState => s !== 'with-admin');
  if (!states.length) return sql`false`;
  const listed = inArray(spaceItems.reviewState, states);
  return states.includes('draft') ? or(isNull(spaceItems.reviewState), listed) : listed;
}

export type SpaceListSort = 'edited' | 'newest' | 'oldest' | 'title';

/** The brain lists' orders (pageOrderBy and its siblings), with the id as
 *  the tie-break so paging is stable. */
function spaceOrderBy(sort: SpaceListSort | undefined) {
  switch (sort) {
    case 'newest':
      return [desc(nodes.createdAt), desc(nodes.id)];
    case 'oldest':
      return [asc(nodes.createdAt), asc(nodes.id)];
    case 'title':
      return [asc(nodes.title), asc(nodes.id)];
    default:
      return [desc(nodes.updatedAt), desc(nodes.id)];
  }
}

function sharingFilter(sharing?: SpaceSharing) {
  if (!sharing) return undefined;
  const listed = eq(spaceItems.sharing, sharing);
  return sharing === 'private' ? or(isNull(spaceItems.sharing), listed) : listed;
}

/** One kind, else the listed kinds, else every personal kind. */
function kindFilter(opts: Pick<ListSpaceOpts, 'kind' | 'kinds'>) {
  return opts.kind
    ? eq(nodes.type, opts.kind)
    : inArray(nodes.type, [...(opts.kinds ?? SPACE_ITEM_KINDS)]);
}

function page(opts: ListSpaceOpts) {
  return {
    limit: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    offset: Math.max(opts.offset ?? 0, 0),
  };
}

// ── Mine ─────────────────────────────────────────────────────────────────────

/** The caller's own items, newest first. */
export async function listMine(
  spaceId: string,
  opts: ListSpaceOpts = {},
): Promise<{ items: SpaceItemRow[]; total: number }> {
  requireSpace(spaceId);
  const { limit, offset } = page(opts);
  const where = and(
    eq(nodes.ownerId, spaceId),
    kindFilter(opts),
    titleFilter(opts.q),
    reviewFilter(opts.reviewStates),
    sharingFilter(opts.sharing),
  );
  const rows = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where)
    .orderBy(...spaceOrderBy(opts.sort))
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where);
  const own = { items: rows.map(rowOf), total: count?.n ?? 0 };
  if (!opts.withAdmin) return own;
  if (opts.reviewStates?.length && !opts.reviewStates.includes('with-admin')) return own;
  const held = await listWithAdmin(requireSpace(spaceId).loginId, opts);
  // Page 1 carries them; later pages keep the own rows' offsets, so paging
  // never skips or repeats a row.
  return {
    items: offset === 0 ? [...held, ...own.items] : own.items,
    total: own.total + held.length,
  };
}

/**
 * A member's items an admin has taken over (audit F07): title and kind
 * only, no content and no bytes, as `with-admin` rows. The item sits in the
 * admin's space, which the member's space role never reads, so this is read
 * on the admin pool with the rule in the query: written by this login, and
 * taken.
 */
export async function listWithAdmin(
  loginId: string,
  opts: Pick<ListSpaceOpts, 'kind' | 'kinds' | 'q'> = {},
): Promise<SpaceItemRow[]> {
  const rows = await asSystem(() =>
    db
      .select({
        id: nodes.id,
        type: nodes.type,
        title: nodes.title,
        takenAt: spaceItems.takenAt,
        submittedAt: spaceItems.submittedAt,
      })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
      .where(
        and(
          eq(spaceItems.authorLoginId, loginId),
          eq(spaceItems.reviewState, 'taken'),
          eq(spaces.kind, 'personal'),
          kindFilter(opts),
          titleFilter(opts.q),
        ),
      )
      .orderBy(desc(spaceItems.takenAt))
      .limit(200),
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type as SpaceItemKind,
    title: r.title,
    icon: null,
    sharing: 'private',
    reviewState: 'with-admin',
    submittedAt: r.submittedAt?.toISOString() ?? null,
    returnedNote: null,
    authorLoginId: loginId,
    updatedAt: (r.takenAt ?? new Date(0)).toISOString(),
  }));
}

/** True when `id` is this login's item and an admin holds it now (audit
 *  F07): the member routes answer 409 `with-admin` instead of a 404. Admin
 *  pool, the rule in the query. */
export async function isWithAdmin(loginId: string, id: string): Promise<boolean> {
  const [r] = await asSystem(() =>
    db
      .select({ id: spaceItems.nodeId })
      .from(spaceItems)
      .where(
        and(
          eq(spaceItems.nodeId, id),
          eq(spaceItems.authorLoginId, loginId),
          eq(spaceItems.reviewState, 'taken'),
        ),
      )
      .limit(1),
  );
  return !!r;
}

/** The 409 a member gets for an item an admin holds. */
export function withAdminError(): SpaceItemStateError {
  return new SpaceItemStateError(
    'with-admin',
    'An admin is working on this item. It comes back to you if they give it back; if they accept it, it shows under Accepted.',
  );
}

/** One own item's row (state included), or null. */
export async function getMineRow(spaceId: string, id: string): Promise<SpaceItemRow | null> {
  requireSpace(spaceId);
  const [row] = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(eq(nodes.id, id), eq(nodes.ownerId, spaceId), inArray(nodes.type, [...SPACE_ITEM_KINDS])),
    )
    .limit(1);
  return row ? rowOf(row) : null;
}

export type SpaceItemBody =
  | { type: 'page'; page: PageDetail }
  | { type: 'note'; note: NoteRow }
  /** Null for a teammate: the scene reader needs draft columns, so a team
   *  draft's drawing is shown from its published SVG route instead. */
  | { type: 'draw'; draw: DrawDetail | null }
  /** Own: drafts included. A teammate: the saved version only. */
  | { type: 'table'; table: TableDetail }
  /** The metadata; the bytes stream from the item's bytes route. */
  | { type: 'file'; file: SpaceFile };

// Compile-time locks (audit M3): what the brain sends must fit the published
// contract, and the database's enums must equal the contract's. Changing
// either side without the other fails the typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const contractLocks: [
  SpaceItemBody extends MemberSpaceItemBody ? true : false,
  Same<SpaceSharing, MemberSpaceSharing>,
  Same<ReviewState, MemberReviewState>,
  Same<SpaceFile, MemberSpaceFile>,
] = [true, true, true, true];
void contractLocks;

/** One own item with its body, drafts included (the author's working copy). */
export async function getMineItem(
  spaceId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await getMineRow(spaceId, id);
  if (!row) return null;
  const body = await spaceItemBody(spaceId, row.type, id, opts);
  return body ? { row, body } : null;
}

/** A personal item's body, read for the space that owns it. Drafts are
 *  read where the scope may (own space, or the admin pool: the review side
 *  strips them, member-review.ts). */
export async function spaceItemBody(
  ownerId: string,
  type: SpaceItemKind,
  id: string,
  opts: { tabId?: string } = {},
): Promise<SpaceItemBody | null> {
  switch (type) {
    case 'page': {
      const p = await getPage(ownerId, id);
      return p ? { type, page: p } : null;
    }
    case 'note': {
      const n = await getNote(ownerId, id);
      return n ? { type, note: n } : null;
    }
    case 'draw': {
      const d = await getDraw(ownerId, id);
      return d ? { type, draw: d } : null;
    }
    case 'table': {
      // getTable reads drafts only where the scope may (own space); a
      // teammate gets the saved version. An unknown tab reads the first.
      const t = await getTable(ownerId, id, { tabId: opts.tabId, unknownTabIsFirst: true });
      return t ? { type, table: t } : null;
    }
    case 'file': {
      const f = await spaceFileOf(ownerId, id);
      return f ? { type, file: f } : null;
    }
  }
}

export type CreateSpaceItemInput =
  | { type: 'page'; title: string; doc?: Record<string, unknown>; icon?: string }
  | { type: 'note'; title: string; content?: string }
  | { type: 'draw'; title: string; scene?: Record<string, unknown> }
  | { type: 'table'; title: string };

/** Create an item in the caller's space: private, draft. */
export async function createMineItem(
  spaceId: string,
  input: CreateSpaceItemInput,
  writer: SpaceWriter = {},
): Promise<SpaceItemRow> {
  const { loginId } = requireSpace(spaceId);
  await assertItemRoom(spaceId);
  // A new item starts published (page, drawing) or has no draft (note): the
  // embed rule holds from its first version.
  if (input.type === 'page' && input.doc)
    await assertEmbeds(spaceId, pageRefs(input.doc), 'page', writer);
  if (input.type === 'note' && input.content)
    await assertEmbeds(spaceId, noteRefs(input.content), 'note', writer);
  if (input.type === 'draw' && input.scene)
    await assertEmbeds(spaceId, sceneRefs(input.scene), 'drawing', writer);
  let id: string;
  switch (input.type) {
    case 'page':
      id = (await createPage(spaceId, { title: input.title, doc: input.doc, icon: input.icon })).id;
      break;
    case 'note':
      id = (await createNote(spaceId, { title: input.title, content: input.content ?? '' })).id;
      break;
    case 'draw':
      id = (await createDraw(spaceId, { title: input.title, scene: input.scene })).id;
      break;
    case 'table':
      id = (await createTable(spaceId, { title: input.title })).id;
      break;
  }
  await db.insert(spaceItems).values({ nodeId: id, authorLoginId: loginId });
  const row = await getMineRow(spaceId, id);
  if (!row) throw new Error('createMineItem: the new item is not readable');
  await notifySpaceItemChanged(id, 'created', { spaceId, team: false });
  return row;
}

/**
 * The frozen rule, as a clear error before a write: a submitted item, and
 * everything in the bundle it was submitted with (an embedded drawing or
 * file, a child page: audit F04), is edited by nobody until Accept, Return or
 * Recall. The row rules refuse the write anyway (it would match no row); this
 * turns that into a 409 the member can read. Returns the row for the
 * caller's convenience.
 */
export async function assertEditable(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  if (row.reviewState === 'submitted' || row.reviewState === 'accepted') {
    throw new SpaceItemStateError(
      'frozen',
      'This item is submitted for review. Recall it to make changes.',
    );
  }
  const holder = await bundleHolder(db, id);
  if (holder) throw frozenBy(holder);
  return row;
}

/** The 409 for an item frozen by the bundle of another submitted item. */
function frozenBy(holder: { id: string; title: string }): SpaceItemStateError {
  return new SpaceItemStateError(
    'frozen',
    `This item is part of "${holder.title}", which is submitted for review. Recall that item to make changes.`,
    [holder.id],
  );
}

/** Private or shared with the team. Allowed in any state before Accept: it
 *  changes who may read the item, never what it says. */
export async function setSharing(
  spaceId: string,
  id: string,
  sharing: SpaceSharing,
): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  await ensureItemRow(spaceId, id);
  await db
    .update(spaceItems)
    .set({ sharing, updatedAt: new Date() })
    .where(eq(spaceItems.nodeId, id));
  await notifySpaceItemChanged(id, 'state', {
    spaceId,
    team: sharing === 'team' || row.sharing === 'team',
  });
  return (await getMineRow(spaceId, id))!;
}

/** Items made before a space_items row existed get one on first touch. */
async function ensureItemRow(spaceId: string, id: string): Promise<void> {
  const { loginId } = requireSpace(spaceId);
  await db
    .insert(spaceItems)
    .values({ nodeId: id, authorLoginId: loginId })
    .onConflictDoNothing({ target: spaceItems.nodeId });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The saved version number of an item and whether it has unsaved edits.
 *  `via` reads on another connection (an admin's self-accept checks inside
 *  its own transaction, member-review.ts). */
export async function savedState(
  type: SpaceItemKind,
  id: string,
  via: Pick<Tx, 'select'> = db,
): Promise<{ version: number | null; unsaved: boolean }> {
  if (type === 'page') {
    const [p] = await via
      .select({ version: pages.version, hasDraft: sql<boolean>`${pages.draftDoc} IS NOT NULL` })
      .from(pages)
      .where(eq(pages.nodeId, id))
      .limit(1);
    return { version: p?.version ?? null, unsaved: p?.hasDraft ?? false };
  }
  if (type === 'draw') {
    const [d] = await via
      .select({ version: draws.version, hasDraft: sql<boolean>`${draws.draftScene} IS NOT NULL` })
      .from(draws)
      .where(eq(draws.nodeId, id))
      .limit(1);
    return { version: d?.version ?? null, unsaved: d?.hasDraft ?? false };
  }
  if (type === 'table') {
    const [t] = await via
      .select({
        version: tables.version,
        storagePath: tables.storagePath,
        hasDraft: sql<boolean>`${tables.draftData} IS NOT NULL`,
      })
      .from(tables)
      .where(eq(tables.nodeId, id))
      .limit(1);
    // A file-backed table's working copy is its draft workbook on disk.
    const draftFile = t?.storagePath ? existsSync(draftAbsFor(t.storagePath)) : false;
    return { version: t?.version ?? null, unsaved: (t?.hasDraft ?? false) || draftFile };
  }
  return { version: null, unsaved: false }; // notes and files have no draft
}

/**
 * Submit to an admin: draft or returned -> submitted. The admin reviews the
 * SAVED version, so unsaved edits refuse ("Save version first"): after Submit
 * nothing could save them until a Recall. That holds for the whole bundle
 * (audit F04): every item that renders inside this one is checked too, and
 * the bundle is recorded, so all of it stays frozen until Accept, Return or
 * Recall and Accept moves exactly what the admin reviewed. The rows are
 * locked first, so an autosave from a second tab cannot land between the
 * check and the change (audit F24).
 */
export async function submitItem(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  if (row.reviewState !== 'draft' && row.reviewState !== 'returned') {
    throw new SpaceItemStateError('not-draft', 'This item is already submitted.');
  }
  const holder = await bundleHolder(db, id);
  if (holder) throw frozenBy(holder);
  await ensureItemRow(spaceId, id);
  // The state row, locked (as Accept, Return and Recall lock it) and read
  // again: a Submit from another tab that committed first wins.
  const [state] = await db
    .select({ reviewState: spaceItems.reviewState })
    .from(spaceItems)
    .where(eq(spaceItems.nodeId, id))
    .for('update');
  if (state?.reviewState !== 'draft' && state?.reviewState !== 'returned') {
    throw new SpaceItemStateError('not-draft', 'This item is already submitted.');
  }
  await assertSubmitRoom(spaceId);

  // Lock, walk, lock what joined, until the bundle stops growing: a Save
  // version can add an embed until its row is locked.
  const root: BundleItem = { id, type: row.type, title: row.title };
  const locked = new Set<string>();
  let items: BundleItem[] = [root];
  for (;;) {
    const fresh = items.filter((b) => !locked.has(b.id));
    if (!fresh.length) break;
    await lockBundleRows(db, fresh);
    for (const b of fresh) locked.add(b.id);
    items = (
      await walkBundle(db, spaceId, root, {
        tooLarge: () =>
          new SpaceItemStateError(
            'too-large',
            `This item brings more than ${BUNDLE_MAX_ITEMS} items with it. Submit a smaller one.`,
          ),
      })
    ).items;
  }

  const unsaved: BundleItem[] = [];
  let version: number | null = null;
  for (const b of items) {
    const saved = await savedState(b.type, b.id);
    if (b.id === id) version = saved.version;
    if (saved.unsaved) unsaved.push(b);
  }
  if (unsaved.some((b) => b.id === id)) {
    throw new SpaceItemStateError(
      'unsaved-draft',
      'This item has unsaved changes. Save a version first, then submit.',
      [id],
    );
  }
  if (unsaved.length) {
    const names = unsaved.map((b) => `"${b.title}"`).join(', ');
    throw new SpaceItemStateError(
      'unsaved-draft',
      `Items shown in this one have unsaved changes: ${names}. Save a version of each, then submit.`,
      unsaved.map((b) => b.id),
    );
  }

  await recordBundle(db, id, items);
  const now = new Date();
  const changed = await db
    .update(spaceItems)
    .set({ reviewState: 'submitted', submittedAt: now, submittedVersion: version, updatedAt: now })
    .where(and(eq(spaceItems.nodeId, id), ne(spaceItems.reviewState, 'submitted')))
    .returning({ id: spaceItems.nodeId });
  // Submitted (or accepted) by a request that committed first.
  if (!changed.length)
    throw new SpaceItemStateError('not-draft', 'This item is already submitted.');
  // The ledger the daily cap counts: Recall does not take a row back.
  await db.insert(spaceSubmissions).values({ spaceId, nodeId: id });
  await notifySpaceItemChanged(id, 'state', { spaceId, team: row.sharing === 'team' });
  return (await getMineRow(spaceId, id))!;
}

/**
 * The submission caps of the space's role (client logins C5, plan section
 * 9): a client submits at most `submitsPerDay` times in 24 hours (counted in
 * the ledger, so Recall and Submit again cannot reset it) and holds at most
 * `openSubmissions` items submitted and not yet accepted or returned (an
 * item an admin took over counts until it is accepted or given back). A
 * member's space has no caps. The login's submits are serialized by a lock
 * held until the space transaction ends, so two tabs cannot both pass the
 * last place.
 */
async function assertSubmitRoom(spaceId: string): Promise<void> {
  const { loginId } = requireSpace(spaceId);
  const limits = spaceLimits();
  if (limits.submitsPerDay === null && limits.openSubmissions === null) return;
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`space-submit:${spaceId}`}, 0))`,
  );
  if (limits.submitsPerDay !== null) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(spaceSubmissions)
      .where(
        and(
          eq(spaceSubmissions.spaceId, spaceId),
          sql`${spaceSubmissions.createdAt} > now() - interval '24 hours'`,
        ),
      );
    if ((r?.n ?? 0) >= limits.submitsPerDay) {
      throw new SpaceItemStateError(
        'quota',
        `You can submit ${limits.submitsPerDay} items a day. Try again tomorrow.`,
      );
    }
  }
  if (limits.openSubmissions !== null) {
    // An item taken over sits in the admin's space, out of this space's
    // sight: counted on the admin pool by author, a number and nothing else.
    const [r] = await asSystem(() =>
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(spaceItems)
        .where(
          and(
            eq(spaceItems.authorLoginId, loginId),
            inArray(spaceItems.reviewState, ['submitted', 'taken']),
            // A bundle item of a taken root is not an open submission.
            isNull(spaceItems.takenRoot),
          ),
        ),
    );
    if ((r?.n ?? 0) >= limits.openSubmissions) {
      throw new SpaceItemStateError(
        'quota',
        `You have ${limits.openSubmissions} items waiting for review. Recall one, or wait for a reply.`,
      );
    }
  }
}

/** Recall for correction: submitted -> draft, any time before Accept. The
 *  admin's review queue drops it, and its bundle unfreezes; the author edits
 *  and submits again. A Recall that loses to an Accept (the item is gone)
 *  is a 404, to a Return a 409 `not-submitted` (audit F24). */
export async function recallItem(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  if (row.reviewState !== 'submitted') {
    throw new SpaceItemStateError('not-submitted', 'Only a submitted item can be recalled.');
  }
  const changed = await db
    .update(spaceItems)
    .set({ reviewState: 'draft', submittedAt: null, updatedAt: new Date() })
    .where(and(eq(spaceItems.nodeId, id), eq(spaceItems.reviewState, 'submitted')))
    .returning({ id: spaceItems.nodeId });
  if (!changed.length) {
    if (!(await getMineRow(spaceId, id))) throw notFound();
    throw new SpaceItemStateError('not-submitted', 'Only a submitted item can be recalled.');
  }
  // After the state change: the rule keeps a submitted item's bundle.
  await clearBundles(db, [id]);
  await notifySpaceItemChanged(id, 'state', { spaceId, team: row.sharing === 'team' });
  return (await getMineRow(spaceId, id))!;
}

/** Delete an own item. Refused while submitted (frozen), and for an item an
 *  admin took over while its author can still take it back (audit F07:
 *  give it back instead; a deactivated or removed author's item may go). */
export async function deleteMineItem(spaceId: string, id: string): Promise<boolean> {
  const row = await assertEditable(spaceId, id);
  if (row.reviewState === 'taken' && (await authorCanTakeBack(id))) {
    throw new SpaceItemStateError(
      'taken',
      'A member wrote this and can still take it back. Give it back, or accept it, instead of deleting it.',
    );
  }
  let gone: boolean;
  switch (row.type) {
    case 'page':
      gone = await deletePage(spaceId, id);
      break;
    case 'note':
      gone = await deleteNote(spaceId, id);
      break;
    case 'draw':
      gone = await deleteDraw(spaceId, id);
      break;
    case 'table':
      gone = await deleteTable(spaceId, id);
      break;
    case 'file':
      gone = await deleteMineFile(spaceId, id);
      break;
  }
  if (gone) {
    await notifySpaceItemChanged(id, 'deleted', { spaceId, team: row.sharing === 'team' });
  }
  return gone;
}

/** The author of a taken item is a member or a client who can sign in:
 *  give-back would work (client logins C1: named roles, never "not admin").
 *  Admin pool (the space role reads no login row). */
async function authorCanTakeBack(id: string): Promise<boolean> {
  const [r] = await asSystem(() =>
    db
      .select({ id: authUsers.id })
      .from(spaceItems)
      .innerJoin(authUsers, eq(authUsers.id, spaceItems.authorLoginId))
      .where(
        and(
          eq(spaceItems.nodeId, id),
          inArray(authUsers.role, ['member', 'client']),
          isNull(authUsers.disabledAt),
        ),
      )
      .limit(1),
  );
  return !!r;
}

/** "Save version" for an own table: publish its draft workbook (or a whole
 *  document the caller sends). With nothing to save it answers the item as
 *  it is: a second click on Save is not an error. Frozen while submitted. */
export async function saveMineTable(
  spaceId: string,
  id: string,
  doc?: TableDoc | WorkbookDoc,
  writer: SpaceWriter = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await assertEditable(spaceId, id);
  if (row.type !== 'table') return null;
  if (doc !== undefined || (await savedState('table', id)).unsaved) {
    await assertEmbeds(spaceId, await tableRefs(id, doc), 'table', writer);
    const t = await commitTable(spaceId, id, doc);
    // No row under the registry lock: submitted since the check above (the
    // frozen rule hides it) or gone. Re-check so a frozen item says so.
    if (!t) {
      await assertEditable(spaceId, id);
      return null;
    }
    await notifySpaceItemChanged(id, 'saved');
  }
  return getMineItem(spaceId, id);
}

/**
 * The save-time embed rule (plan 2d; Jason 2026-09-26: never another
 * member's team-shared item). A personal item may embed or link only the
 * author's own items and Library items (brain items the team level can
 * read). Returns what it may not use: another member's item (shared or
 * not), an admin-only brain item, an id that no longer resolves, and what
 * embed-refs.ts refuses outright (a non-uuid id, an entity mention, an
 * external image). Accept (Phase 4) moves an item's embed closure into the
 * brain, so a foreign id here would drag someone else's work, or an admin
 * secret's existence, along.
 *
 * An admin in their own private space (Phase 7, Jason 2026-09-28) may also
 * use the brain's items at ANY level, admin included: they can read them
 * all. Never another login's personal item, admin or member.
 */
export async function disallowedRefs(
  spaceId: string,
  refs: EmbedRefs,
  writer: SpaceWriter = {},
): Promise<string[]> {
  const { loginId } = requireSpace(spaceId);
  const { ids, refused } = refs;
  if (ids.length === 0) return refused;
  const own = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), inArray(nodes.id, ids)));
  const ok = new Set(own.map((r) => r.id));
  const rest = ids.filter((id) => !ok.has(id));
  const adminBrain = writer.adminOfBrain ? await adminBrainOf(loginId, writer.adminOfBrain) : null;
  if (rest.length && adminBrain) {
    // The whole brain, at every level. The admin pool (asSystem): the
    // space role reads no brain row, and the rule is in the query (this
    // brain's own rows, never a personal space's).
    const brain = await asSystem(() =>
      db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.ownerId, adminBrain), inArray(nodes.id, rest))),
    );
    for (const r of brain) ok.add(r.id);
  } else if (rest.length) {
    // The Library, read as the team level reads it (row security decides).
    const lib = await withViewer('team', () =>
      db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(sql`${nodes.ownerId} = mantle_brain_id()`, inArray(nodes.id, rest))),
    );
    for (const r of lib) ok.add(r.id);
  }
  return [...refused, ...ids.filter((id) => !ok.has(id))];
}

/**
 * The brain `brainId` when `loginId` may use it at every level: the login is
 * an admin that is not disabled, and `brainId` is a brain row. Null
 * otherwise (the member rule applies). Read on the admin pool: the space role
 * holds no grant on logins or spaces.
 */
async function adminBrainOf(loginId: string, brainId: string): Promise<string | null> {
  const [row] = await asSystem(() =>
    db
      .select({ id: spaces.id })
      .from(spaces)
      .innerJoin(authUsers, eq(authUsers.id, loginId))
      .where(
        and(
          eq(spaces.id, brainId),
          eq(spaces.kind, 'brain'),
          eq(authUsers.role, 'admin'),
          isNull(authUsers.disabledAt),
        ),
      )
      .limit(1),
  );
  return row?.id ?? null;
}

/** The embed rule for a page document (kept for its callers). */
export function disallowedPageRefs(spaceId: string, doc: unknown): Promise<string[]> {
  return disallowedRefs(spaceId, pageRefs(doc));
}

/** Refuse a save that breaks the embed rule (409 `embed` with the ids). */
async function assertEmbeds(
  spaceId: string,
  refs: EmbedRefs,
  what: string,
  writer: SpaceWriter = {},
): Promise<void> {
  const bad = await disallowedRefs(spaceId, refs, writer);
  if (bad.length) {
    throw new SpaceItemStateError(
      'embed',
      `This ${what} uses items you cannot share: only your own items and Library items. Remove them, then save.`,
      bad,
    );
  }
}

/** The references a table's working copy holds (the draft workbook, or the
 *  document sent with Save version). */
async function tableRefs(id: string, doc?: TableDoc | WorkbookDoc): Promise<EmbedRefs> {
  if (doc !== undefined) {
    const tabs = 'tabs' in doc && Array.isArray(doc.tabs) ? doc.tabs : [doc as TableDoc];
    return cellRefs(
      tabs.flatMap((t) => (t.rows ?? []).flatMap((r) => Object.values(r.cells ?? {}))),
    );
  }
  const [t] = await db
    .select({ storagePath: tables.storagePath })
    .from(tables)
    .where(eq(tables.nodeId, id))
    .limit(1);
  if (!t?.storagePath) return { ids: [], refused: [], embeds: [] };
  const draft = draftAbsFor(t.storagePath);
  const file = existsSync(draft) ? draft : resolveStoragePath(t.storagePath);
  return existsSync(file) ? cellRefs(refLikeCells(file)) : { ids: [], refused: [], embeds: [] };
}

/** "Save version" for an own page, under the embed rule. */
export async function saveMinePage(
  spaceId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } & SpaceWriter = {},
): Promise<CommitPageResult> {
  const { adminOfBrain, ...commit } = opts;
  await assertEmbeds(spaceId, pageRefs(doc), 'page', { adminOfBrain });
  const res = await commitPage(spaceId, id, doc, commit);
  if (res.ok) await notifySpaceItemChanged(id, 'saved');
  return res;
}

/** "Save version" for an own drawing (its SVG snapshot is what teammates see). */
export async function saveMineDraw(
  spaceId: string,
  id: string,
  scene: Record<string, unknown>,
  opts: { baseRev?: number; svg?: string } & SpaceWriter = {},
): Promise<CommitDrawResult> {
  requireSpace(spaceId);
  const { adminOfBrain, ...commit } = opts;
  await assertEmbeds(spaceId, sceneRefs(scene), 'drawing', { adminOfBrain });
  const res = await commitDraw(spaceId, id, scene, commit);
  if (res.ok) await notifySpaceItemChanged(id, 'saved');
  return res;
}

export type UpdateSpaceItemInput = { title?: string; icon?: string; content?: string };

/** Rename or re-icon an own item, or change a note's text. Frozen while
 *  submitted. Returns the item with its body, or null when it is gone. */
export async function updateMineItem(
  spaceId: string,
  id: string,
  input: UpdateSpaceItemInput,
  writer: SpaceWriter = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await assertEditable(spaceId, id);
  const { title, icon, content } = input;
  switch (row.type) {
    case 'page':
      await updatePage(spaceId, id, { title, icon });
      break;
    case 'note':
      // A note has no draft: its text is what teammates and a reviewer read,
      // so the embed rule holds on every change.
      if (content !== undefined) await assertEmbeds(spaceId, noteRefs(content), 'note', writer);
      await updateNote(spaceId, id, { title, content });
      break;
    case 'draw':
      await updateDraw(spaceId, id, { title, icon });
      break;
    case 'table':
      await updateTable(spaceId, id, { title, icon });
      break;
    case 'file':
      if (title !== undefined) await renameMineFile(spaceId, id, title);
      break;
  }
  await notifySpaceItemChanged(id, 'saved', { spaceId, team: row.sharing === 'team' });
  return getMineItem(spaceId, id);
}

// ── Team drafts ──────────────────────────────────────────────────────────────

/** Other members' items shared with the team, newest first. The caller's own
 *  shared items are in Mine, not here. Published content only.
 *  `reviewStates` narrows by review state as on Mine. */
export async function listTeamDrafts(
  loginId: string,
  opts: ListSpaceOpts = {},
): Promise<{ items: SpaceItemRow[]; total: number }> {
  requireTeamDrafts();
  const { limit, offset } = page(opts);
  const where = and(
    eq(spaceItems.sharing, 'team'),
    inMemberSpace,
    sql`${spaceItems.authorLoginId} IS DISTINCT FROM ${loginId}`,
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    titleFilter(opts.q),
    reviewFilter(opts.reviewStates),
  );
  const rows = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where)
    .orderBy(desc(nodes.updatedAt))
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where);
  return { items: rows.map(rowOf), total: count?.n ?? 0 };
}

/** One team draft's row (no body), or null when the caller may not read it. */
export async function getTeamDraftRow(id: string): Promise<SpaceItemRow | null> {
  requireTeamDrafts();
  const [joined] = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.id, id),
        eq(spaceItems.sharing, 'team'),
        inMemberSpace,
        inArray(nodes.type, [...SPACE_ITEM_KINDS]),
      ),
    )
    .limit(1);
  return joined ? rowOf(joined) : null;
}

/** One team draft with its published body, or null when the caller may not
 *  read it (private, the brain's, or gone). */
export async function getTeamDraftItem(
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  requireTeamDrafts();
  const [joined] = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.id, id),
        eq(spaceItems.sharing, 'team'),
        inMemberSpace,
        inArray(nodes.type, [...SPACE_ITEM_KINDS]),
      ),
    )
    .limit(1);
  if (!joined) return null;
  const row = rowOf(joined);
  if (row.type === 'draw') {
    // The scene reader asks for draft columns; a teammate gets the drawing's
    // published SVG through its own route instead.
    return { row, body: { type: 'draw', draw: null } };
  }
  const body = await spaceItemBody(joined.node.ownerId, row.type, id, opts);
  return body ? { row, body } : null;
}

/** A team-shared drawing's saved SVG, or null. Its owner is whichever space
 *  holds it; row security decides whether the caller may see it at all. */
export async function getTeamDraftDrawSvg(id: string): Promise<string | null> {
  requireTeamDrafts();
  const [n] = await db
    .select({ ownerId: nodes.ownerId })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(eq(nodes.id, id), eq(nodes.type, 'draw'), eq(spaceItems.sharing, 'team'), inMemberSpace),
    )
    .limit(1);
  return n ? getDrawSvg(n.ownerId, id) : null;
}

/** A team-shared file's bytes, or null. Row security decides whether the
 *  caller may see the node; the bytes are then read from its own space. */
export async function openTeamDraftFile(id: string): Promise<OpenedSpaceFile | null> {
  requireTeamDrafts();
  const [n] = await db
    .select({ ownerId: nodes.ownerId })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(eq(nodes.id, id), eq(nodes.type, 'file'), eq(spaceItems.sharing, 'team'), inMemberSpace),
    )
    .limit(1);
  if (!n) return null;
  const file = await spaceFileOf(n.ownerId, id);
  if (!file) return null;
  const opened = await openSpaceFile(n.ownerId, id);
  return opened ? { file, spaceId: n.ownerId, ...opened } : null;
}
