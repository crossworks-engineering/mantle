/**
 * Client requests for members (client logins C5, decision 5 B): what a
 * CLIENT submitted for review, read only, by the team.
 *
 * Run inside `withHumanViewer('team')` (the team role, human flag on): row
 * security (migration 0194) shows a client's SUBMITTED item, and the items
 * submitted in its bundle so its embeds render, published columns only. A
 * client's draft, returned or accepted item never matches, and an agent (no
 * human flag) reads none of it.
 *
 * The same scope also shows teammates' team drafts and the Library, so every
 * query here names a CLIENT's space itself (`mantle_client_space`): a member's
 * draft or a brain item is never a client request. The list names only the
 * ROOT items (the submitted ones); a bundle item is read by id, for the embed
 * it is.
 *
 * Each row names its author: the client's display name, else "A client",
 * read on the admin pool by the row's author login (a name and nothing else).
 */
import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import {
  asSystem,
  authUsers,
  currentSpaceScope,
  currentViewerLevel,
  db,
  nodes,
  spaceItems,
} from '@mantle/db';
import type { MemberItemAuthor } from '@mantle/client-types';
import { CLIENT_ITEM_KINDS, type ClientItemKind } from '@mantle/client-types/member-kinds';
import { openSpaceFile } from '@mantle/files';
import { spaceItemBody, type SpaceItemBody, type SpaceItemRow } from './member-space';
import { spaceFileOf, type OpenedSpaceFile } from './member-space-files';

/** A client request as the member reads it: the space row and its author. */
export type ClientRequestRow = { row: SpaceItemRow; author: MemberItemAuthor };

/** Client requests run on the team role with the human flag; never at
 *  admin, never inside a personal space. */
function requireClientRequests(): void {
  if (currentViewerLevel() !== 'team' || currentSpaceScope()) {
    throw new Error("client requests read outside withHumanViewer('team')");
  }
}

/** The node sits in a CLIENT's personal space (never the brain, a member's
 *  or an admin's space). */
const inClientSpace = sql`mantle_client_space(${nodes.ownerId})`;

const isClientKind = (k: string): k is ClientItemKind =>
  (CLIENT_ITEM_KINDS as readonly string[]).includes(k);

function titleFilter(q: string | undefined) {
  const t = q?.trim();
  return t ? ilike(nodes.title, `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined;
}

type Joined = { node: typeof nodes.$inferSelect; item: typeof spaceItems.$inferSelect | null };

function rowOf({ node, item }: Joined): SpaceItemRow {
  const d = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    type: node.type as ClientItemKind,
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

/** The authors' names, on the admin pool: a CLIENT login's display name,
 *  else "A client". Only a name leaves this function. */
async function clientAuthors(loginIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(loginIds)];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const rows = await asSystem(() =>
    db
      .select({ id: authUsers.id, name: authUsers.displayName })
      .from(authUsers)
      .where(and(inArray(authUsers.id, ids), eq(authUsers.role, 'client'))),
  );
  for (const r of rows) out.set(r.id, r.name?.trim() || 'A client');
  return out;
}

function authorOf(row: SpaceItemRow, names: Map<string, string>): MemberItemAuthor {
  const name = (row.authorLoginId && names.get(row.authorLoginId)) || 'A client';
  return { name, acceptedAt: null, role: 'client' };
}

export type ListClientRequestsOpts = {
  /** Any member kind; a kind a client never writes lists nothing. */
  kind?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

/** Clients' submitted items (the roots, never a bundle item), newest save
 *  first, with the total. */
export async function listClientRequests(
  opts: ListClientRequestsOpts = {},
): Promise<{ items: ClientRequestRow[]; total: number }> {
  requireClientRequests();
  if (opts.kind && !isClientKind(opts.kind)) return { items: [], total: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = and(
    eq(spaceItems.reviewState, 'submitted'),
    inClientSpace,
    opts.kind
      ? eq(nodes.type, opts.kind as ClientItemKind)
      : inArray(nodes.type, [...CLIENT_ITEM_KINDS]),
    titleFilter(opts.q),
  );
  const rows = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where)
    .orderBy(desc(nodes.updatedAt), desc(nodes.id))
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .innerJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(where);
  const items = rows.map(rowOf);
  const names = await clientAuthors(
    items.flatMap((r) => (r.authorLoginId ? [r.authorLoginId] : [])),
  );
  return {
    items: items.map((row) => ({ row, author: authorOf(row, names) })),
    total: count?.n ?? 0,
  };
}

/** One client-request node the caller may read (a submitted root, or an
 *  item in its bundle: row security decides), or null. */
async function requestNode(id: string, type?: ClientItemKind): Promise<Joined | null> {
  const [joined] = await db
    .select({ node: nodes, item: spaceItems })
    .from(nodes)
    .leftJoin(spaceItems, eq(spaceItems.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.id, id),
        inClientSpace,
        type ? eq(nodes.type, type) : inArray(nodes.type, [...CLIENT_ITEM_KINDS]),
      ),
    )
    .limit(1);
  return joined ?? null;
}

/**
 * One client request with its published body (a page's doc, a note's text,
 * a file's metadata) and its author; null when the caller may not read it
 * (a draft, returned or accepted item, a member's or the brain's, or gone).
 * An item in a submitted root's bundle reads too, so the root's embeds
 * render.
 */
export async function getClientRequestItem(
  id: string,
  opts: { tabId?: string } = {},
): Promise<{ row: SpaceItemRow; body: SpaceItemBody; author: MemberItemAuthor } | null> {
  requireClientRequests();
  const joined = await requestNode(id);
  if (!joined) return null;
  const row = rowOf(joined);
  const body = await spaceItemBody(joined.node.ownerId, row.type, id, opts);
  if (!body) return null;
  const names = await clientAuthors(row.authorLoginId ? [row.authorLoginId] : []);
  return { row, body, author: authorOf(row, names) };
}

/** A client request's file bytes (a submitted file, or a file in a
 *  submitted root's bundle), or null. Row security decides whether the
 *  caller may see the node; the bytes are then read from the client's space. */
export async function openClientRequestFile(id: string): Promise<OpenedSpaceFile | null> {
  requireClientRequests();
  const joined = await requestNode(id, 'file');
  if (!joined) return null;
  const ownerId = joined.node.ownerId;
  const file = await spaceFileOf(ownerId, id);
  if (!file) return null;
  const opened = await openSpaceFile(ownerId, id);
  return opened ? { file, spaceId: ownerId, ...opened } : null;
}
