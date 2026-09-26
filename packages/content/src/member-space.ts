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
  withViewer,
  draws,
  nodes,
  pages,
  spaceItems,
  tables,
  type ReviewState,
  type SpaceSharing,
} from '@mantle/db';
import { existsSync } from 'node:fs';
import { createDraw, deleteDraw, getDraw, getDrawSvg, updateDraw, type DrawDetail } from './draws';
import { createNote, deleteNote, getNote, updateNote, type NoteRow } from './notes';
import { getPage } from './pages/read';
import { commitPage, updatePage, type CommitPageResult } from './pages/draft';
import { referencedDrawIds, referencedFileIds } from './doc-assets';
import { mentionRefs } from './mention-refs';
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
import {
  deleteMineFile,
  renameMineFile,
  spaceFileOf,
  type OpenedSpaceFile,
  type SpaceFile,
} from './member-space-files';
import { openSpaceFile } from '@mantle/files';
import {
  SpaceItemStateError,
  assertItemRoom,
  requireSpace,
  spaceNotFound as notFound,
} from './member-space-core';

export { SPACE_ITEM_LIMIT, SpaceItemStateError, assertItemRoom } from './member-space-core';

/** What a personal space holds. A table's workbook sits under
 *  TABLE_DB_DIR/<spaceId>/; a file's bytes under MANTLE_SPACES_ROOT/<spaceId>/
 *  (member-space-files.ts). */
export const SPACE_ITEM_KINDS = ['page', 'note', 'draw', 'table', 'file'] as const;
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
  | { type: 'draw'; draw: DrawDetail | null }
  /** Own: drafts included. A teammate: the saved version only. */
  | { type: 'table'; table: TableDetail }
  /** The metadata; the bytes stream from the item's bytes route. */
  | { type: 'file'; file: SpaceFile };

/** One own item with its body, drafts included (the author's working copy). */
export async function getMineItem(
  spaceId: string,
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await getMineRow(spaceId, id);
  if (!row) return null;
  const body = await bodyOf(spaceId, row.type, id, opts);
  return body ? { row, body } : null;
}

async function bodyOf(
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
): Promise<SpaceItemRow> {
  const { loginId } = requireSpace(spaceId);
  await assertItemRoom(spaceId);
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
  if (type === 'table') {
    const [t] = await db
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
  await notifySpaceItemChanged(id, 'state', { spaceId, team: row.sharing === 'team' });
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
  await notifySpaceItemChanged(id, 'state', { spaceId, team: row.sharing === 'team' });
  return (await getMineRow(spaceId, id))!;
}

/** Delete an own item. Refused while submitted (frozen). */
export async function deleteMineItem(spaceId: string, id: string): Promise<boolean> {
  const row = await assertEditable(spaceId, id);
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

/** "Save version" for an own table: publish its draft workbook (or a whole
 *  document the caller sends). With nothing to save it answers the item as
 *  it is: a second click on Save is not an error. Frozen while submitted. */
export async function saveMineTable(
  spaceId: string,
  id: string,
  doc?: TableDoc | WorkbookDoc,
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await assertEditable(spaceId, id);
  if (row.type !== 'table') return null;
  if (doc !== undefined || (await savedState('table', id)).unsaved) {
    const t = await commitTable(spaceId, id, doc);
    if (!t) return null;
    await notifySpaceItemChanged(id, 'saved');
  }
  return getMineItem(spaceId, id);
}

/**
 * The save-time embed rule (plan 2d; Jason 2026-09-26: never another
 * member's team-shared item). A personal page may embed or link only the
 * author's own items and Library items (brain items the team level can
 * read). Returns the ids it may not use: another member's item (shared or
 * not), an admin-only brain item, or an id that no longer resolves. Accept
 * (Phase 4) moves an item's embed closure into the brain, so a foreign id
 * here would drag someone else's work, or an admin secret's existence, along.
 */
export async function disallowedPageRefs(spaceId: string, doc: unknown): Promise<string[]> {
  requireSpace(spaceId);
  const ids = [
    ...new Set([...referencedFileIds(doc), ...referencedDrawIds(doc), ...mentionRefs(doc).nodeIds]),
  ];
  if (ids.length === 0) return [];
  const own = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, spaceId), inArray(nodes.id, ids)));
  const ok = new Set(own.map((r) => r.id));
  const rest = ids.filter((id) => !ok.has(id));
  if (rest.length) {
    // The Library, read as the team level reads it (row security decides).
    const lib = await withViewer('team', () =>
      db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(sql`${nodes.ownerId} = mantle_brain_id()`, inArray(nodes.id, rest))),
    );
    for (const r of lib) ok.add(r.id);
  }
  return ids.filter((id) => !ok.has(id));
}

/** "Save version" for an own page, under the embed rule. */
export async function saveMinePage(
  spaceId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } = {},
): Promise<CommitPageResult> {
  const bad = await disallowedPageRefs(spaceId, doc);
  if (bad.length) {
    throw new SpaceItemStateError(
      'embed',
      'This page uses items you cannot share: only your own items and Library items. Remove them, then save.',
      bad,
    );
  }
  const res = await commitPage(spaceId, id, doc, opts);
  if (res.ok) await notifySpaceItemChanged(id, 'saved');
  return res;
}

/** "Save version" for an own drawing (its SVG snapshot is what teammates see). */
export async function saveMineDraw(
  spaceId: string,
  id: string,
  scene: Record<string, unknown>,
  opts: { baseRev?: number; svg?: string } = {},
): Promise<CommitDrawResult> {
  requireSpace(spaceId);
  const res = await commitDraw(spaceId, id, scene, opts);
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
): Promise<{ row: SpaceItemRow; body: SpaceItemBody } | null> {
  const row = await assertEditable(spaceId, id);
  const { title, icon, content } = input;
  switch (row.type) {
    case 'page':
      await updatePage(spaceId, id, { title, icon });
      break;
    case 'note':
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
  const body = await bodyOf(joined.node.ownerId, row.type, id, opts);
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

/** A team-shared file's bytes, or null. Row security decides whether the
 *  caller may see the node; the bytes are then read from its own space. */
export async function openTeamDraftFile(id: string): Promise<OpenedSpaceFile | null> {
  requireTeamDrafts();
  const [n] = await db
    .select({ ownerId: nodes.ownerId })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.type, 'file'), eq(spaceItems.sharing, 'team')))
    .limit(1);
  if (!n) return null;
  const file = await spaceFileOf(n.ownerId, id);
  if (!file) return null;
  const opened = await openSpaceFile(n.ownerId, id);
  return opened ? { file, ...opened } : null;
}
