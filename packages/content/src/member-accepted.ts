/**
 * What a member wrote and an admin accepted into the brain, as its AUTHOR
 * reads it: the version ACCEPTED, from the snapshot taken at Accept
 * (member-snapshots.ts), never the brain's current version. The only reader
 * is the author's read-only snapshot copy
 * (server/web/lib/snapshot-copies.ts).
 *
 * A page's doc, a note's text and a table's cells are the version accepted,
 * and an admin may have written them: an item an admin TOOK OVER
 * is accepted with the admin's edits, and an admin may mention, link or
 * embed any brain item while it is theirs. So what its author reads is
 * REDACTED for the author, with the shared
 * reader's redactors (client-redact.ts): a reference to anything the author
 * may not read is "Private item" (a mention, a link, a cell), and an embed
 * of it is left out. The author may read the brain's items its workspaces
 * hold, its own personal items, and the items it wrote that an admin
 * accepted (shown by their accepted title).
 *
 * Every function here runs on the ADMIN pool (the item may sit outside the
 * author's workspaces, and the limited roles hold no grant on `space_items`),
 * so the rule lives in every query. Nothing here writes, and nothing returns
 * a draft.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pageFolderIdOf } from './pages/read';
import {
  acceptedSnapshots,
  currentSpaceScope,
  db,
  nodes,
  spaceItems,
  spaces,
  withViewer,
  isSystemScope,
} from '@mantle/db';
import { MEMBER_ITEM_KINDS, type MemberItemKind } from '@mantle/client-types/member-kinds';
import { forAcceptedKind } from '@mantle/client-types/kind-lists';
import {
  cellRefIds,
  clientOwnUrl,
  docRefIds,
  noteRefIds,
  redactClientCell,
  redactClientDoc,
  redactClientNote,
  type ClientRedactOptions,
} from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { tableFromSnapshot, type getTable } from './tables/read';
import {
  acceptedDrawUnchanged,
  acceptedFileUnchanged,
  snapshotOf,
  type AcceptedSnapshot,
} from './member-snapshots';
import { UUID_RE } from '@mantle/std';

export type AcceptedRow = {
  id: string;
  type: MemberItemKind;
  title: string;
  icon: string | null;
  /** Always null; kept for the row's shape. */
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
  if (!isSystemScope() || currentSpaceScope()) {
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

/**
 * The ids among `ids` an accepted item's AUTHOR may read in its body, each
 * with the title its chip shows: the brain's items the author's
 * workspaces hold (read in the author's scope, so row security decides),
 * the author's own personal items,
 * and the items they wrote that an admin accepted (by their accepted title,
 * never an admin's later rename). Keys lower-case. Admin pool.
 */
async function authorReadable(
  anchorId: string,
  loginId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.map((i) => i.toLowerCase()))].filter((i) => UUID_RE.test(i));
  const out = new Map<string, string>();
  if (!wanted.length) return out;
  const brain = await withViewer({ login: loginId }, async () => {
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
async function redactedDoc(anchorId: string, loginId: string, doc: unknown): Promise<unknown> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await authorReadable(anchorId, loginId, docRefIds(doc, { ownUrl }));
  const opts: ClientRedactOptions = { ownUrl, titles };
  return redactClientDoc(doc, new Set(titles.keys()), opts);
}

/** A note's text as its author reads it: see authorReadable. */
async function redactedNote(anchorId: string, loginId: string, content: string): Promise<string> {
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  const titles = await authorReadable(anchorId, loginId, noteRefIds(content, { ownUrl }));
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
  table: AcceptedTable,
): Promise<AcceptedTable> {
  const opts = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
  const values = table.data.rows.flatMap((r) => Object.values(r.cells).flat());
  const ids = cellRefIds(values, opts);
  if (!ids.length) return table;
  const readable = new Set((await authorReadable(anchorId, loginId, ids)).keys());
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

/** The login no row names: an author with no login left reads nothing
 *  beyond the item itself (every reference in it is redacted). */
const NOBODY = '00000000-0000-4000-8000-000000000000';

/**
 * An accepted item as its author reads it, for the author's read-only
 * snapshot copy: the accepted snapshot, redacted
 * for the author, without the author
 * rule (the caller holds space_item_homes' record instead). `authorLoginId`
 * null (a login that is gone): redacted for nobody. Also the snapshot, for
 * what the item shape does not carry (a drawing's scene). Null when the
 * item or its snapshot is gone. Admin pool.
 */
export async function acceptedItemForCopy(
  anchorId: string,
  authorLoginId: string | null,
  id: string,
): Promise<{ item: AcceptedItem; snap: AcceptedSnapshot } | null> {
  assertAdminPool();
  const [node] = await db
    .select({ id: nodes.id, type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
    .limit(1);
  if (!node || !(MEMBER_ITEM_KINDS as readonly string[]).includes(node.type)) return null;
  const snap = await snapshotOf(anchorId, id);
  if (!snap) return null;
  const at = snap.acceptedAt.toISOString();
  const row: AcceptedRow = {
    id: node.id,
    type: node.type as MemberItemKind,
    title: snap.title,
    icon: snap.icon ?? null,
    inherited: null,
    acceptedAt: at,
    updatedAt: at,
  };
  const item = await acceptedItemOf(anchorId, authorLoginId ?? NOBODY, id, { row, snap });
  return item ? { item, snap } : null;
}

/** One accepted item from its row and snapshot: see acceptedItemForCopy. */
async function acceptedItemOf(
  anchorId: string,
  loginId: string,
  id: string,
  found: { row: AcceptedRow; snap: AcceptedSnapshot },
  opts: { tabId?: string } = {},
): Promise<AcceptedItem | null> {
  const { row: base, snap } = found;
  // The one switch over an accepted item's kind.
  return (
    forAcceptedKind<AcceptedRow, Promise<AcceptedItem | null>>(base, {
      page: async () => ({
        ...base,
        type: 'page',
        doc: await redactedDoc(anchorId, loginId, snap.doc),
        // Where it sits now, for a Folder index block.
        folderId: await pageFolderIdOf(anchorId, base.id),
      }),
      note: async () => ({
        ...base,
        type: 'note',
        content: await redactedNote(anchorId, loginId, snap.content ?? ''),
      }),
      table: async () => {
        const [node] = await db
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, id), eq(nodes.ownerId, anchorId)))
          .limit(1);
        if (!node) return null;
        // Nothing of the LIVE node an admin could have changed since:
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
          table: await redactedTable(anchorId, loginId, table),
        };
      },
      draw: async () => {
        const changed = !snap.sceneSvg && !(await acceptedDrawUnchanged(anchorId, id, snap));
        return { ...base, type: 'draw', ...(changed ? { changedByAdmin: true } : {}) };
      },
      file: async () => {
        const changed = !(await acceptedFileUnchanged(anchorId, id, snap));
        return {
          ...base,
          type: 'file',
          filename: snap.fileName ?? base.title,
          mimeType: snap.fileMime,
          sizeBytes: snap.fileSize,
          ...(changed ? { changedByAdmin: true } : {}),
        };
      },
    }) ?? null
  );
}
