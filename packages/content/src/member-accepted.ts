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
 * A page's doc, a note's text, a table's cells and a drawing's element links
 * are the version accepted, and an admin may have written them: an item an
 * admin TOOK OVER (audit F07) is accepted with the admin's edits, and an
 * admin may mention, link or embed any brain item at any level while it is
 * theirs. So what its author reads is REDACTED at the author's level (client
 * logins C5 audit, L1; tables and drawings in C6), with the client shared
 * reader's own redactors (client-redact.ts): a reference to anything the
 * author may not read is "Private item" (a mention, a link, a cell), an
 * embed of it is left out, and a drawing's link to it loses its href. The
 * author may read the brain's items at their level (team for a member,
 * client for a client), their own items, and the items they wrote that an
 * admin accepted (shown by their accepted title).
 *
 * Every function here runs on the ADMIN pool (the item may sit above the
 * author's level, and the limited roles hold no grant on `space_items`), so
 * the rule lives in every query, as in member-review.ts: the row names this
 * login as the author, its state is `accepted`, and the item belongs to this
 * brain. Nothing here writes, and nothing returns a draft.
 */
import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { pageFolderIdOf } from './pages/read';
import {
  acceptedSnapshots,
  asViewerLevel,
  authUsers,
  currentSpaceScope,
  currentViewerLevel,
  db,
  nodes,
  spaceItems,
  spaces,
  withViewer,
  type ViewerLevel,
} from '@mantle/db';
import type {
  ClientAcceptedItem,
  MemberAcceptedItem,
  MemberAcceptedRow,
  MemberItemAuthor,
} from '@mantle/client-types';
import { MEMBER_ITEM_KINDS, type MemberItemKind } from '@mantle/client-types/member-kinds';
import { getDrawSvg } from './draws';
import {
  cellRefIds,
  clientLinkHidden,
  clientOwnUrl,
  docRefIds,
  linkRefIds,
  noteRefIds,
  redactClientCell,
  redactClientDoc,
  redactClientNote,
  type ClientRedactOptions,
} from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { clientReadable } from './client-shared';
import { dropSvgLinks, svgLinkHrefs } from './scene-svg';
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
  /** The share it takes from a folder holding it (folder sharing): in the
   *  Library at that level too, whatever `audience` says. */
  inherited?: 'team' | 'client' | null;
  acceptedAt: string | null;
  updatedAt: string;
};

export type AcceptedItem =
  | (AcceptedRow & { type: 'page'; doc: unknown; folderId?: string | null })
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
    inherited:
      node.inheritedLevel === 'team' || node.inheritedLevel === 'client'
        ? node.inheritedLevel
        : null,
    acceptedAt: acceptedAt?.toISOString() ?? null,
    updatedAt: (snapAt ?? node.updatedAt).toISOString(),
  };
}

const snapCols = {
  snapTitle: acceptedSnapshots.title,
  snapIcon: acceptedSnapshots.icon,
  snapAt: acceptedSnapshots.acceptedAt,
};

/** The author's accepted items, newest accept first. `q` matches the title
 *  the row shows (the accepted title: an admin's later rename is the
 *  brain's, and a search on it would spell it out, audit L5); `outside`
 *  keeps only items read at none of those levels (own or folder share). `order: 'updated'` sorts by the row's
 *  own `updatedAt` instead (the one list merges on it). */
export async function listAccepted(
  anchorId: string,
  loginId: string,
  opts: {
    kind?: MemberItemKind;
    /** Without `kind`: only these kinds (a client's list, client logins C5). */
    kinds?: readonly MemberItemKind[];
    q?: string;
    /** Only items read at none of these levels, by their own level or
     *  through a shared folder: what the Library does not already list. */
    outside?: readonly ViewerLevel[];
    order?: 'accepted' | 'updated';
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: AcceptedRow[]; total: number }> {
  assertAdminPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const q = opts.q?.trim();
  const where = and(
    authoredWhere(anchorId, loginId),
    opts.kind
      ? eq(nodes.type, opts.kind)
      : opts.kinds
        ? inArray(nodes.type, [...opts.kinds])
        : undefined,
    q
      ? ilike(
          sql`coalesce(${acceptedSnapshots.title}, ${nodes.title})`,
          `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        )
      : undefined,
    opts.outside?.length
      ? and(
          notInArray(nodes.audience, [...opts.outside]),
          or(isNull(nodes.inheritedLevel), notInArray(nodes.inheritedLevel, [...opts.outside])),
          or(isNull(nodes.embeddedLevel), notInArray(nodes.embeddedLevel, [...opts.outside])),
        )
      : undefined,
  );
  // rowOf's updatedAt: the snapshot's time when there is one, else the node's.
  const order =
    opts.order === 'updated'
      ? [desc(sql`coalesce(${acceptedSnapshots.acceptedAt}, ${nodes.updatedAt})`), desc(nodes.id)]
      : [desc(spaceItems.acceptedAt), desc(nodes.updatedAt)];
  const [rows, [count]] = await Promise.all([
    db
      .select({ node: nodes, acceptedAt: spaceItems.acceptedAt, ...snapCols })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, nodes.id))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(spaceItems)
      .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
      .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, nodes.id))
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

/** The level an accepted item's author reads at: team for a member, client
 *  for a client. */
export type AcceptedReader = 'team' | 'client';

/**
 * The ids among `ids` an accepted item's AUTHOR may read in its body, each
 * with the title its chip shows (audit L1): the brain's items at the
 * author's level (read at that level, so row security decides; for a client
 * the client shared reader's own query), the author's own personal items,
 * and the items they wrote that an admin accepted (by their accepted title,
 * never an admin's later rename). Keys lower-case. Admin pool.
 */
async function authorReadable(
  anchorId: string,
  loginId: string,
  reader: AcceptedReader,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.map((i) => i.toLowerCase()))].filter((i) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(i),
  );
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const brain =
    reader === 'client'
      ? await withViewer('client', () => clientReadable(anchorId, wanted))
      : await withViewer('team', async () => {
          const rows = await db
            .select({ id: nodes.id, title: nodes.title })
            .from(nodes)
            .where(and(eq(nodes.ownerId, anchorId), inArray(nodes.id, wanted)));
          return new Map(rows.map((r) => [r.id.toLowerCase(), r.title]));
        });
  for (const [k, v] of brain) out.set(k, v);
  const own = await db
    .select({ id: nodes.id, title: nodes.title })
    .from(nodes)
    .innerJoin(spaces, eq(spaces.id, nodes.ownerId))
    .where(
      and(eq(spaces.kind, 'personal'), eq(spaces.loginId, loginId), inArray(nodes.id, wanted)),
    );
  for (const r of own) out.set(r.id.toLowerCase(), r.title);
  const accepted = await db
    .select({
      id: nodes.id,
      title: sql<string>`coalesce(${acceptedSnapshots.title}, ${nodes.title})`,
    })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .leftJoin(acceptedSnapshots, eq(acceptedSnapshots.nodeId, nodes.id))
    .where(and(inArray(spaceItems.nodeId, wanted), authoredWhere(anchorId, loginId)));
  for (const r of accepted) out.set(r.id.toLowerCase(), r.title);
  return out;
}

/** A page doc as its author reads it: see authorReadable. */
async function redactedDoc(
  anchorId: string,
  loginId: string,
  reader: AcceptedReader,
  doc: unknown,
): Promise<unknown> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await authorReadable(anchorId, loginId, reader, docRefIds(doc, { ownUrl }));
  const opts: ClientRedactOptions = { ownUrl, titles };
  return redactClientDoc(doc, new Set(titles.keys()), opts);
}

/** A note's text as its author reads it: see authorReadable. */
async function redactedNote(
  anchorId: string,
  loginId: string,
  reader: AcceptedReader,
  content: string,
): Promise<string> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await authorReadable(anchorId, loginId, reader, noteRefIds(content, { ownUrl }));
  const opts: ClientRedactOptions = { ownUrl, titles };
  return redactClientNote(content, new Set(titles.keys()), opts);
}

type AcceptedTable = NonNullable<Awaited<ReturnType<typeof getTable>>>;

/** A table's grid as its author reads it: a cell that names an item the
 *  author may not read (a link or lookup value such as `/n/<id>`, a
 *  `page:` ref, an absolute URL into this brain) reads "Private item"; a
 *  list cell is checked value by value. See authorReadable. */
async function redactedTable(
  anchorId: string,
  loginId: string,
  reader: AcceptedReader,
  table: AcceptedTable,
): Promise<AcceptedTable> {
  const opts = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
  const values = table.data.rows.flatMap((r) => Object.values(r.cells).flat());
  const ids = cellRefIds(values, opts);
  if (!ids.length) return table;
  const readable = new Set((await authorReadable(anchorId, loginId, reader, ids)).keys());
  return {
    ...table,
    data: {
      ...table.data,
      rows: table.data.rows.map((r) => ({
        ...r,
        cells: Object.fromEntries(
          Object.entries(r.cells).map(([k, v]) => [
            k,
            redactClientCell(v, readable, opts) as typeof v,
          ]),
        ),
      })),
    },
  };
}

/** A drawing's SVG as its author reads it: an element's link to an item the
 *  author may not read loses its href (the element stays, drawn as before,
 *  and points nowhere); links to readable items and external sites stay.
 *  See authorReadable. */
async function redactedSvgLinks(
  anchorId: string,
  loginId: string,
  reader: AcceptedReader,
  svg: string,
): Promise<string> {
  const hrefs = svgLinkHrefs(svg);
  if (!hrefs.length) return svg;
  const opts = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
  const readable = new Set(
    (await authorReadable(anchorId, loginId, reader, linkRefIds(hrefs, opts))).keys(),
  );
  return dropSvgLinks(svg, (href) => !clientLinkHidden(href, readable, opts));
}

/** One accepted item as ACCEPTED (its snapshot, never the brain's current
 *  version), for its author only: nothing of the live node an admin could
 *  have changed (a table carries no summary, description, tags or app
 *  link; the snapshot records none). `tabId` picks a table's tab. A page's doc,
 *  a note's text and a table's cells are redacted at `reader`, the author's
 *  level (team by default, a member; audit L1). A drawing's picture is its
 *  accepted SVG (acceptedDrawSvg, its links redacted the same way); a file's
 *  bytes come from the member files route while they are unchanged, and
 *  `changedByAdmin` says when they are not. */
export async function getAcceptedItem(
  anchorId: string,
  loginId: string,
  id: string,
  opts: { tabId?: string; reader?: AcceptedReader } = {},
): Promise<AcceptedItem | null> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (!found) return null;
  const { row: base, snap } = found;
  const reader = opts.reader ?? 'team';
  switch (base.type) {
    case 'page':
      return {
        ...base,
        type: 'page',
        doc: await redactedDoc(anchorId, loginId, reader, snap.doc),
        // Where it sits now (folder phase 7), for a Folder index block.
        folderId: await pageFolderIdOf(anchorId, base.id),
      };
    case 'note':
      return {
        ...base,
        type: 'note',
        content: await redactedNote(anchorId, loginId, reader, snap.content ?? ''),
      };
    case 'table': {
      const [node] = await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
        .limit(1);
      if (!node) return null;
      // Nothing of the LIVE node an admin could have changed since (C6):
      // the title, icon and time are the snapshot's; the extractor's
      // summary (written from the brain's version), the description, the
      // tags, the app link and the visibility are left out (the snapshot
      // records none of them). Only the id, the level and createdAt stay.
      const table = tableFromSnapshot(
        {
          ...node,
          title: snap.title,
          tags: [],
          data: snap.icon ? { icon: snap.icon } : {},
          updatedAt: snap.acceptedAt,
        },
        { storagePath: snap.tablePath, doc: snap.tableDoc },
        { tabId: opts.tabId },
      );
      return {
        ...base,
        type: 'table',
        table: await redactedTable(anchorId, loginId, reader, table),
      };
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

/**
 * One accepted item for its CLIENT author (client logins C5): the version
 * accepted, as getAcceptedItem reads it, of a kind a client writes (page,
 * note, file), without its level: a client never learns where an admin put
 * it. Its doc or text is redacted at the CLIENT level (audit L1: an admin
 * who took it over may have named team or admin items in it). Null for
 * anything else, the same answer as an id that does not exist.
 */
export async function getClientAcceptedItem(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<ClientAcceptedItem | null> {
  const item = await getAcceptedItem(anchorId, loginId, id, { reader: 'client' });
  if (!item) return null;
  const base = {
    id: item.id,
    title: item.title,
    icon: item.icon,
    acceptedAt: item.acceptedAt,
    updatedAt: item.updatedAt,
  };
  switch (item.type) {
    case 'page':
      return { ...base, type: 'page', doc: item.doc };
    case 'note':
      return { ...base, type: 'note', content: item.content };
    case 'file':
      return {
        ...base,
        type: 'file',
        filename: item.filename,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        ...(item.changedByAdmin ? { changedByAdmin: true } : {}),
      };
    default:
      return null;
  }
}

/** An accepted drawing's picture as accepted, for its author only: the SVG
 *  saved with the snapshot, and the image refs it was drawn with. A drawing
 *  accepted with no saved SVG shows the brain's SVG only while the drawing
 *  is still at the accepted version. Its element links are redacted at
 *  `reader`, the author's level (team by default, a member; audit L1): an
 *  admin who took it over may have linked an item the author may not read.
 *  Its images are the caller's (memberDrawSvg, with these image refs). */
export async function acceptedDrawSnapshot(
  anchorId: string,
  loginId: string,
  id: string,
  opts: { reader?: AcceptedReader } = {},
): Promise<{ svg: string; fileRefs: Record<string, unknown> } | null> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (found?.row.type !== 'draw') return null;
  const { snap } = found;
  const reader = opts.reader ?? 'team';
  const refs = (snap.fileRefs ?? {}) as Record<string, unknown>;
  let svg = snap.sceneSvg;
  if (!svg) {
    if (!(await acceptedDrawUnchanged(anchorId, id, snap))) return null;
    svg = await getDrawSvg(anchorId, id);
  }
  return svg
    ? { svg: await redactedSvgLinks(anchorId, loginId, reader, svg), fileRefs: refs }
    : null;
}

/** An accepted drawing's accepted SVG, for its author only (acceptedDrawSnapshot). */
export async function acceptedDrawSvg(
  anchorId: string,
  loginId: string,
  id: string,
  opts: { reader?: AcceptedReader } = {},
): Promise<string | null> {
  return (await acceptedDrawSnapshot(anchorId, loginId, id, opts))?.svg ?? null;
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

/** acceptedFileReadable, with the name and type the file was ACCEPTED with
 *  (audit L7): its bytes are served under the snapshot's name, never the
 *  brain file's current one (an admin's rename, or the name Accept made
 *  unique in its folder). Null when acceptedFileReadable is false. */
export async function acceptedFileMeta(
  anchorId: string,
  loginId: string,
  id: string,
): Promise<{ filename: string; mimeType: string | null } | null> {
  const found = await authoredSnapshot(anchorId, loginId, id);
  if (found?.row.type !== 'file') return null;
  if (!(await acceptedFileUnchanged(anchorId, id, found.snap))) return null;
  return { filename: found.snap.fileName ?? found.row.title, mimeType: found.snap.fileMime };
}

export type AcceptedAuthor = MemberItemAuthor;

/** Which of these brain items THIS login wrote and an admin accepted (the
 *  one list's `byMe`). Callers pass ids their reader may already see. */
export async function acceptedByLogin(
  anchorId: string,
  loginId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  assertAdminPool();
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: spaceItems.nodeId })
    .from(spaceItems)
    .innerJoin(nodes, eq(nodes.id, spaceItems.nodeId))
    .where(and(inArray(spaceItems.nodeId, [...ids]), authoredWhere(anchorId, loginId)));
  return new Set(rows.map((r) => r.id));
}

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
      role: authUsers.role,
      authorRole: spaceItems.authorRole,
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
    // The author's role is named: a client author is a client, never "A
    // member" (client logins audit B26), also once the login is deleted:
    // the role stamped on the row then (audit I6).
    const role = (r.role ?? r.authorRole) === 'client' ? 'client' : r.loginId ? 'member' : null;
    const name = r.loginId
      ? r.name?.trim() || (role === 'client' ? 'A client' : 'A member')
      : role === 'client'
        ? 'Removed client'
        : 'Removed member';
    out.set(r.id, { name, acceptedAt: r.acceptedAt?.toISOString() ?? null, role });
  }
  return out;
}
