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
import { and, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import {
  currentSpaceScope,
  currentViewerLevel,
  db,
  draws,
  nodes,
  pages,
  spaceItems,
  type ReviewState,
  type SpaceSharing,
} from '@mantle/db';
import { createDraw, deleteDraw, getDraw, getDrawSvg, type DrawDetail } from './draws';
import { createNote, deleteNote, getNote, type NoteRow } from './notes';
import { getPage } from './pages/read';
import { deletePage, createPage } from './pages/tree';
import type { PageDetail } from './pages/shared';

/** What a personal space holds in this release. Tables and files follow with
 *  the space disk root (their bytes live on disk, keyed by owner). */
export const SPACE_ITEM_KINDS = ['page', 'note', 'draw'] as const;
export type SpaceItemKind = (typeof SPACE_ITEM_KINDS)[number];

export function isSpaceItemKind(v: unknown): v is SpaceItemKind {
  return typeof v === 'string' && (SPACE_ITEM_KINDS as readonly string[]).includes(v);
}

export type SpaceItemRow = {
  id: string;
  type: SpaceItemKind;
  title: string;
  icon: string | null;
  sharing: SpaceSharing;
  reviewState: ReviewState;
  submittedAt: string | null;
  returnedNote: string | null;
  /** The login that wrote it (team drafts show whose it is). */
  authorLoginId: string | null;
  updatedAt: string;
};

/** Thrown when an item may not change now: it is submitted (frozen), or the
 *  requested move is not allowed from its state (routes answer 409), or it is
 *  not the caller's to change at all (`not-found`, routes answer 404: another
 *  member's item looks exactly like one that does not exist). */
export class SpaceItemStateError extends Error {
  constructor(
    readonly reason:
      'not-found' | 'frozen' | 'not-draft' | 'not-submitted' | 'unsaved-draft' | 'quota',
    message: string,
  ) {
    super(message);
    this.name = 'SpaceItemStateError';
  }
}

const notFound = () => new SpaceItemStateError('not-found', 'Not found.');

/** The caller's own space scope, or a loud error: every "Mine" function runs
 *  inside `withSpace` for exactly this space. */
function requireSpace(spaceId: string): { spaceId: string; loginId: string } {
  const scope = currentSpaceScope();
  if (!scope || scope.spaceId !== spaceId) {
    throw new Error('personal space read outside its space scope: wrap it in withSpace');
  }
  return scope;
}

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
    updatedAt: node.updatedAt.toISOString(),
  };
}

function titleFilter(q: string | undefined) {
  const t = q?.trim();
  return t ? ilike(nodes.title, `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined;
}

export type ListSpaceOpts = { kind?: SpaceItemKind; q?: string; limit?: number; offset?: number };

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
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    titleFilter(opts.q),
  );
  const rows = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where)
    .orderBy(desc(nodes.updatedAt))
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(where);
  return { items: rows.map(rowOf), total: count?.n ?? 0 };
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
  | { type: 'draw'; draw: DrawDetail | null };

/** One own item with its body, drafts included (the author's working copy). */
export async function getMineItem(
  spaceId: string,
  id: string,
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await getMineRow(spaceId, id);
  if (!row) return null;
  const body = await bodyOf(spaceId, row.type, id);
  return body ? { row, body } : null;
}

async function bodyOf(
  ownerId: string,
  type: SpaceItemKind,
  id: string,
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
  }
}

export type CreateSpaceItemInput =
  | { type: 'page'; title: string; doc?: Record<string, unknown>; icon?: string }
  | { type: 'note'; title: string; content?: string }
  | { type: 'draw'; title: string; scene?: Record<string, unknown> };

/** Items one personal space may hold (plan section 8, quotas). Folders a
 *  space makes for itself (the per-kind roots) do not count. */
export const SPACE_ITEM_LIMIT = 2000;

/** Create an item in the caller's space: private, draft. */
export async function createMineItem(
  spaceId: string,
  input: CreateSpaceItemInput,
): Promise<SpaceItemRow> {
  const { loginId } = requireSpace(spaceId);
  const [held] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), ne(nodes.type, 'branch')));
  if ((held?.n ?? 0) >= SPACE_ITEM_LIMIT) {
    throw new SpaceItemStateError(
      'quota',
      `Your space is full (${SPACE_ITEM_LIMIT} items). Delete something first.`,
    );
  }
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
  }
  await db.insert(spaceItems).values({ nodeId: id, authorLoginId: loginId });
  const row = await getMineRow(spaceId, id);
  if (!row) throw new Error('createMineItem: the new item is not readable');
  return row;
}

/**
 * The frozen rule, as a clear error before a write: a submitted item is
 * edited by nobody until Accept, Return or Recall. The row rules refuse the
 * write anyway (it would match no row); this turns that into a 409 the member
 * can read. Returns the row for the caller's convenience.
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
  return row;
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

/** The saved version number of an item and whether it has unsaved edits. */
async function savedState(
  type: SpaceItemKind,
  id: string,
): Promise<{ version: number | null; unsaved: boolean }> {
  if (type === 'page') {
    const [p] = await db
      .select({ version: pages.version, hasDraft: sql<boolean>`${pages.draftDoc} IS NOT NULL` })
      .from(pages)
      .where(eq(pages.nodeId, id))
      .limit(1);
    return { version: p?.version ?? null, unsaved: p?.hasDraft ?? false };
  }
  if (type === 'draw') {
    const [d] = await db
      .select({ version: draws.version, hasDraft: sql<boolean>`${draws.draftScene} IS NOT NULL` })
      .from(draws)
      .where(eq(draws.nodeId, id))
      .limit(1);
    return { version: d?.version ?? null, unsaved: d?.hasDraft ?? false };
  }
  return { version: null, unsaved: false }; // notes save as they go
}

/**
 * Submit to an admin: draft or returned -> submitted. The admin reviews the
 * SAVED version, so unsaved edits refuse ("Save version first"): after Submit
 * nothing could save them until a Recall.
 */
export async function submitItem(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  if (row.reviewState !== 'draft' && row.reviewState !== 'returned') {
    throw new SpaceItemStateError('not-draft', 'This item is already submitted.');
  }
  const saved = await savedState(row.type, id);
  if (saved.unsaved) {
    throw new SpaceItemStateError(
      'unsaved-draft',
      'This item has unsaved changes. Save a version first, then submit.',
    );
  }
  await ensureItemRow(spaceId, id);
  await db
    .update(spaceItems)
    .set({
      reviewState: 'submitted',
      submittedAt: new Date(),
      submittedVersion: saved.version,
      updatedAt: new Date(),
    })
    .where(and(eq(spaceItems.nodeId, id), ne(spaceItems.reviewState, 'submitted')));
  return (await getMineRow(spaceId, id))!;
}

/** Recall for correction: submitted -> draft, any time before Accept. The
 *  admin's review queue drops it; the author edits and submits again. */
export async function recallItem(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row) throw notFound();
  if (row.reviewState !== 'submitted') {
    throw new SpaceItemStateError('not-submitted', 'Only a submitted item can be recalled.');
  }
  await db
    .update(spaceItems)
    .set({ reviewState: 'draft', submittedAt: null, updatedAt: new Date() })
    .where(and(eq(spaceItems.nodeId, id), eq(spaceItems.reviewState, 'submitted')));
  return (await getMineRow(spaceId, id))!;
}

/** Delete an own item. Refused while submitted (frozen). */
export async function deleteMineItem(spaceId: string, id: string): Promise<boolean> {
  const row = await assertEditable(spaceId, id);
  switch (row.type) {
    case 'page':
      return deletePage(spaceId, id);
    case 'note':
      return deleteNote(spaceId, id);
    case 'draw':
      return deleteDraw(spaceId, id);
  }
}

// ── Team drafts ──────────────────────────────────────────────────────────────

/** Other members' items shared with the team, newest first. The caller's own
 *  shared items are in Mine, not here. Published content only. */
export async function listTeamDrafts(
  loginId: string,
  opts: ListSpaceOpts = {},
): Promise<{ items: SpaceItemRow[]; total: number }> {
  requireTeamDrafts();
  const { limit, offset } = page(opts);
  const where = and(
    eq(spaceItems.sharing, 'team'),
    sql`${spaceItems.authorLoginId} IS DISTINCT FROM ${loginId}`,
    opts.kind ? eq(nodes.type, opts.kind) : inArray(nodes.type, [...SPACE_ITEM_KINDS]),
    titleFilter(opts.q),
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

/** One team draft with its published body, or null when the caller may not
 *  read it (private, the brain's, or gone). */
export async function getTeamDraftItem(
  id: string,
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
  const body = await bodyOf(joined.node.ownerId, row.type, id);
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
    .where(and(eq(nodes.id, id), eq(nodes.type, 'draw'), eq(spaceItems.sharing, 'team')))
    .limit(1);
  return n ? getDrawSvg(n.ownerId, id) : null;
}
