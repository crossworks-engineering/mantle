/**
 * Who may open or close an item's open link, and what may go on its served
 * list (workspaces plan 8.1, decision 12, R7).
 *
 *  - Open or close a link: a user who may edit the item (a Moderator of its
 *    home workspace, or a user of a workspace whose grant has Write on); an
 *    app: home Moderators only. The same rule as the Grant Access panel's
 *    `mayLink` (server/web/lib/grants.ts).
 *  - Add an item to a served list: the item is named or embedded by the
 *    link's item (a page's, note's, task's or event's text, a drawing's
 *    images, and the images of a drawing the item embeds) or, for a folder
 *    link, sits under the folder; and the caller may edit it. An id the
 *    caller cannot read is 404 (never named), one it reads but may not add
 *    403 `forbidden`. Taking an item off the list, or keeping one that is
 *    on it, needs no more than the link.
 *
 * A brain with no workspaces yet (never migrated) has no grants to ask: the
 * owner gate of the caller decides alone, as before workspaces.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, nodeEmbeds, nodes, pages } from '@mantle/db';
import { clientOwnUrl, docRefIds, noteRefIds } from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { canShareNode, ShareInputError, shareServedIds, type ShareDb } from './shares';

/** A refusal with its HTTP status: 404 for an item the caller may not read
 *  (never 403), 403 for one it reads but may not link or serve. */
export class LinkRefusedError extends Error {
  constructor(
    readonly status: 403 | 404,
    readonly code: 'forbidden' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'LinkRefusedError';
  }
}

const NOT_FOUND = () => new LinkRefusedError(404, 'not_found', 'Item not found.');

export type LinkRights = {
  id: string;
  type: string;
  path: string | null;
  /** One of the caller's workspaces holds a grant. */
  read: boolean;
  /** A Moderator of the home, or a Write grant in one of the caller's
   *  workspaces. */
  edit: boolean;
  /** A Moderator of the home. */
  manage: boolean;
};

/** The caller's rights on `ids` (the owner's items; an id with no row is
 *  left out). Keys lower-case. */
export async function linkRights(
  ownerId: string,
  loginId: string,
  ids: readonly string[],
  q: ShareDb = db,
): Promise<Map<string, LinkRights>> {
  const wanted = shareServedIds({ served: ids });
  if (!wanted.length) return new Map();
  const rows = (await q.execute(sql`
    with mine as (
      select u.workspace_id as ws, u.moderator
        from workspace_users u join workspaces w on w.id = u.workspace_id
       where u.login_id = ${loginId} and w.owner_id = ${ownerId} and w.archived_at is null
    ),
    migrated as (
      select exists (select 1 from workspaces where owner_id = ${ownerId} and is_admin) as yes
    )
    select n.id::text as id, n.type::text as type, n.path::text as path,
           (not m.yes or exists (select 1 from mine where mine.ws = any (n.read_ws))) as read,
           (not m.yes or exists (select 1 from mine where mine.ws = n.home_ws and mine.moderator))
             as manage,
           (not m.yes or exists (select 1 from mine where mine.ws = any (n.write_ws))) as write_any
      from nodes n cross join migrated m
     where n.owner_id = ${ownerId}
       and n.id = any (${`{${wanted.join(',')}}`}::uuid[])
  `)) as unknown as {
    id: string;
    type: string;
    path: string | null;
    read: boolean;
    manage: boolean;
    write_any: boolean;
  }[];
  return new Map(
    rows.map((r) => [
      r.id.toLowerCase(),
      {
        id: r.id.toLowerCase(),
        type: r.type,
        path: r.path,
        read: r.read === true,
        manage: r.manage === true,
        edit: r.manage === true || r.write_any === true,
      },
    ]),
  );
}

/**
 * The item if `loginId` may open or close its link, else a refusal: 404
 * when the caller cannot read it, {@link ShareInputError} when it cannot
 * carry a link, 403 when the caller may read but not edit it (an app: not
 * manage it).
 */
export async function assertMayLink(
  ownerId: string,
  loginId: string,
  nodeId: string,
  q: ShareDb = db,
): Promise<LinkRights> {
  const r = (await linkRights(ownerId, loginId, [nodeId], q)).get(nodeId.toLowerCase());
  if (!r || !r.read) throw NOT_FOUND();
  if (!canShareNode(r)) {
    throw new ShareInputError('not-shareable', `type '${r.type}' cannot carry a link here`);
  }
  if (!(r.type === 'app' ? r.manage : r.edit)) {
    throw new LinkRefusedError(
      403,
      'forbidden',
      r.type === 'app'
        ? "Only a Moderator of the app's home workspace may open or close its link."
        : 'Only someone who may edit this item may open or close its link.',
    );
  }
  return r;
}

/** At most this many items of a folder are offered for its link's served
 *  list (the Grant Access panel's `serveCandidates`). */
export const FOLDER_SERVE_OFFER_MAX = 500;

/** The ids the item may serve (see the top): named or embedded by it, or
 *  under it for a folder. `ids`: only these (a check); null: every one (the
 *  panel's offer; a folder's capped at FOLDER_SERVE_OFFER_MAX). */
async function serveCandidates(
  ownerId: string,
  item: { id: string; type: string; path: string | null },
  ids: readonly string[] | null,
  q: ShareDb,
): Promise<Set<string>> {
  if (ids && !ids.length) return new Set();
  if (item.type === 'branch') {
    if (!item.path) return new Set();
    const rows = await q
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          ids ? inArray(nodes.id, [...ids]) : undefined,
          sql`${nodes.path} <@ ${item.path}::ltree`,
          sql`${nodes.id} <> ${item.id}`,
        ),
      )
      .orderBy(nodes.id)
      .limit(ids ? ids.length : FOLDER_SERVE_OFFER_MAX);
    return new Set(rows.map((r) => r.id.toLowerCase()));
  }
  if (!['page', 'note', 'task', 'event', 'draw'].includes(item.type)) return new Set();

  const out = new Set<string>();
  const embeds = await q
    .select({ id: nodeEmbeds.toId, type: nodes.type })
    .from(nodeEmbeds)
    .innerJoin(nodes, eq(nodes.id, nodeEmbeds.toId))
    .where(eq(nodeEmbeds.fromId, item.id));
  for (const e of embeds) out.add(e.id.toLowerCase());
  if (item.type === 'draw') return out;

  // The images of a drawing the item embeds: its snapshot carries them.
  const draws = embeds.filter((e) => e.type === 'draw').map((e) => e.id);
  if (draws.length) {
    const hop = await q
      .select({ id: nodeEmbeds.toId })
      .from(nodeEmbeds)
      .where(inArray(nodeEmbeds.fromId, draws));
    for (const h of hop) out.add(h.id.toLowerCase());
  }

  // What its text names: a mention, a link into this brain, an embed.
  const ownUrl = clientOwnUrl(clientRedactOrigins());
  if (item.type === 'page') {
    const [p] = await q
      .select({ doc: pages.doc })
      .from(pages)
      .where(eq(pages.nodeId, item.id))
      .limit(1);
    for (const id of docRefIds(p?.doc, { ownUrl })) out.add(id.toLowerCase());
  } else {
    const [n] = await q
      .select({ data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.id, item.id), eq(nodes.ownerId, ownerId)))
      .limit(1);
    for (const md of linkTexts(item.type, n?.data)) {
      for (const id of noteRefIds(md, { ownUrl })) out.add(id.toLowerCase());
    }
  }
  return out;
}

/** What the caller may add to the served list of the link on `item` (the
 *  Grant Access panel's `serveCandidates`): the items it names or embeds
 *  (a folder: the items under it, at most FOLDER_SERVE_OFFER_MAX) that the
 *  caller may edit, by title. */
export async function listServeCandidates(
  ownerId: string,
  loginId: string,
  item: { id: string; type: string; path: string | null },
  q: ShareDb = db,
): Promise<Array<{ nodeId: string; title: string; kind: string }>> {
  const ids = [...(await serveCandidates(ownerId, item, null, q))].filter(
    (id) => id !== item.id.toLowerCase(),
  );
  if (!ids.length) return [];
  const rights = await linkRights(ownerId, loginId, ids, q);
  const ok = ids.filter((id) => rights.get(id)?.edit === true);
  if (!ok.length) return [];
  const rows = await q
    .select({ id: nodes.id, title: nodes.title, type: nodes.type })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ok)))
    .orderBy(sql`lower(${nodes.title})`, nodes.id);
  return rows.map((r) => ({ nodeId: r.id, title: r.title, kind: r.type }));
}

/** The markdown a note, task or event shows on its link. */
function linkTexts(type: string, data: unknown): string[] {
  const d = (data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (type === 'note') return [str(d.content)];
  if (type === 'event') return [str(d.body)];
  const todos = Array.isArray(d.todos)
    ? (d.todos as Array<Record<string, unknown>>).map((t) => str(t?.text))
    : [];
  return [str(d.body), ...todos];
}

/**
 * Check a served list for the link on `item` (see the top) and return it
 * normalized (lower-case, no repeats, the item itself left out). `current`:
 * the list the link holds now; only the ids it does not hold are checked.
 * Throws {@link LinkRefusedError}.
 */
export async function checkServeList(
  ownerId: string,
  loginId: string,
  item: { id: string; type: string; path: string | null },
  serve: readonly string[],
  current: readonly string[] = [],
  q: ShareDb = db,
): Promise<string[]> {
  const self = item.id.toLowerCase();
  const list = shareServedIds({ served: serve }).filter((id) => id !== self);
  const held = new Set(shareServedIds({ served: current }));
  const added = list.filter((id) => !held.has(id));
  if (!added.length) return list;
  const rights = await linkRights(ownerId, loginId, added, q);
  if (added.some((id) => !rights.get(id)?.read)) throw NOT_FOUND();
  const candidates = await serveCandidates(ownerId, item, added, q);
  for (const id of added) {
    if (!candidates.has(id) || !rights.get(id)?.edit) {
      throw new LinkRefusedError(
        403,
        'forbidden',
        item.type === 'branch'
          ? 'A folder link serves only items inside the folder that you may edit.'
          : 'A link serves only items its item names or embeds that you may edit.',
      );
    }
  }
  return list;
}
