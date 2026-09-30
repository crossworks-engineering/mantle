/**
 * "What clients see" (client logins C1, plan sections 7 and 10). Before
 * client logins, "client" meant "anyone with the link": setting an item to
 * client made an open link. From C1 it means signed-in clients. So before the
 * first client login on a box, an admin reads the list of every item at
 * client level (these are what every client login will read at once) and
 * acknowledges it. The report also shows, per item:
 *
 *  - its live open link, made under the old meaning (views, last view);
 *  - the addresses a page was emailed to with the page tool (invite hints);
 *  - what it names that a client may not read: a mention chip, a link or an
 *    embed pointing at a team or admin item (plan N6), whose title would
 *    otherwise reach the client page as a label.
 *
 *  - a live old link on a client folder that holds it or a client page that
 *    embeds it (client-old-links.ts): anyone with that link opens it too.
 *
 * Read-only, on the admin pool (an owner route calls it). The acknowledgement
 * is a row in client_report_acks (0187) with the ids the admin acknowledged;
 * the report asks again once an item not in that list is at client level.
 * The admin acknowledges by the report's fingerprint (a hash of EVERY
 * client-level id, not only the 2000 listed), so a brain with more client
 * items than the list shows can still be acknowledged (audit A7). Adding a
 * client login stays disabled until then (C2). No LLM work.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  authUsers,
  clientReportAcks,
  db,
  nodes,
  pages,
  shares,
  type ViewerLevel,
} from '@mantle/db';
import type {
  ClientReport,
  ClientReportAck,
  ClientReportItem,
  ClientReportRef,
} from '@mantle/client-types';
import type { MemberItemKind } from '@mantle/client-types/member-kinds';
import { isReadAt, readAtSql } from './item-level';
import { noteRefs, pageRefs } from './embed-refs';
import { refsOf } from './member-bundle';
import { oldLinksAbove } from './client-old-links';

/** The report lists at most this many items (newest first); `total` counts all. */
export const CLIENT_REPORT_MAX = 2000;

/** How far back the email hints look (the email_page steps). */
export const CLIENT_REPORT_EMAIL_DAYS = 400;

const LEVELS: readonly string[] = ['admin', 'team', 'client', 'public'];

/** The acknowledgement no longer matches the report: something went to or
 *  left client since the admin loaded it. The client reloads (409). */
export class ClientReportChangedError extends Error {
  readonly reason = 'report-changed';
  constructor() {
    super('The list changed since you opened it. Check it again, then acknowledge.');
    this.name = 'ClientReportChangedError';
  }
}

/** Every item id of the brain a client reads, newest first: at client by
 *  its own level or through a folder shared with clients. Ids only. */
async function clientItemIds(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), readAtSql(['client'])))
    .orderBy(desc(nodes.updatedAt), nodes.id);
  return rows.map((r) => r.id);
}

/** sha256 hex of the ids, sorted, joined by ','. The WHOLE client set. */
export function clientReportFingerprint(ids: readonly string[]): string {
  return createHash('sha256')
    .update(
      [...ids]
        .map((i) => i.toLowerCase())
        .sort()
        .join(','),
    )
    .digest('hex');
}

/** The listed items' rows (no `data`). */
async function itemRows(ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: nodes.id, type: nodes.type, title: nodes.title, updatedAt: nodes.updatedAt })
    .from(nodes)
    .where(inArray(nodes.id, [...ids]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}

/** Every id an item names (links, mention chips, embeds): pages and notes,
 *  and drawings (scene links and placed images) and tables (link cells),
 *  read the way the member bundle reads them (member-bundle.ts refsOf).
 *  Apps are not scanned: an app is code, not a document. */
async function namedIds(items: { id: string; type: string }[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const pageIds = items.filter((i) => i.type === 'page').map((i) => i.id);
  if (pageIds.length) {
    const rows = await db
      .select({ id: pages.nodeId, doc: pages.doc })
      .from(pages)
      .where(inArray(pages.nodeId, pageIds));
    for (const r of rows) out.set(r.id, pageRefs(r.doc).ids);
  }
  const noteIds = items.filter((i) => i.type === 'note').map((i) => i.id);
  if (noteIds.length) {
    const rows = await db
      .select({ id: nodes.id, data: nodes.data })
      .from(nodes)
      .where(inArray(nodes.id, noteIds));
    for (const r of rows) {
      const content = (r.data as { content?: unknown } | null)?.content;
      if (typeof content === 'string' && content) out.set(r.id, noteRefs(content).ids);
    }
  }
  for (const i of items) {
    if (i.type !== 'draw' && i.type !== 'table') continue;
    const refs = await refsOf(db, { id: i.id, type: i.type as MemberItemKind, title: '' });
    const ids = [...new Set(refs.flatMap((r) => r.ids))];
    if (ids.length) out.set(i.id, ids);
  }
  return out;
}

/** The addresses in a to / cc / bcc string: "Ann <ann@x.org>, bob@y.org"
 *  gives ann@x.org and bob@y.org (display names left out), lower case. */
export function emailAddresses(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (value ?? '').matchAll(/[^\s<>,;:"'()]+@[^\s<>,;:"'()]+/g)) {
    out.push(m[0].toLowerCase());
  }
  return out;
}

/** Who each page was emailed to with the page tool: successful sends only
 *  (a step that finished, not one queued for approval, with a message id
 *  from the mail server), to, cc and bcc, within CLIENT_REPORT_EMAIL_DAYS.
 *  Sends through the MCP surface write no step and are not seen. */
async function emailedTo(ownerId: string, pageIds: string[]): Promise<Map<string, Set<string>>> {
  const emailed = new Map<string, Set<string>>();
  if (!pageIds.length) return emailed;
  const rows = (await db.execute(sql`
    select s.input->'args'->>'pageId' as id,
           s.input->'args'->>'to' as "to",
           s.input->'args'->>'cc' as cc,
           s.input->'args'->>'bcc' as bcc
      from trace_steps s join traces t on t.id = s.trace_id
     where s.name = 'tool: email_page'
       and s.created_at > now() - make_interval(days => ${CLIENT_REPORT_EMAIL_DAYS})
       and s.status = 'success'
       and s.output ? 'messageId'
       and t.owner_id = ${ownerId}
       and s.input->'args'->>'pageId' in (${sql.join(
         pageIds.map((i) => sql`${i}`),
         sql`, `,
       )})`)) as unknown as {
    id: string;
    to: string | null;
    cc: string | null;
    bcc: string | null;
  }[];
  for (const r of rows) {
    const set = emailed.get(r.id) ?? new Set<string>();
    for (const a of [...emailAddresses(r.to), ...emailAddresses(r.cc), ...emailAddresses(r.bcc)]) {
      set.add(a);
    }
    emailed.set(r.id, set);
  }
  return emailed;
}

/** The newest acknowledgement, with its ids. */
async function newestAck(
  ownerId: string,
): Promise<{ ack: ClientReportAck; ids: Set<string> } | null> {
  const [row] = await db
    .select({
      ackedAt: clientReportAcks.ackedAt,
      ackedBy: clientReportAcks.ackedBy,
      itemIds: clientReportAcks.itemIds,
      name: authUsers.displayName,
      email: authUsers.email,
    })
    .from(clientReportAcks)
    .leftJoin(authUsers, eq(authUsers.id, clientReportAcks.ackedBy))
    .where(eq(clientReportAcks.ownerId, ownerId))
    .orderBy(desc(clientReportAcks.ackedAt))
    .limit(1);
  if (!row) return null;
  return {
    ack: {
      ackedAt: row.ackedAt.toISOString(),
      ackedBy: row.ackedBy
        ? { id: row.ackedBy, name: row.name?.trim() || row.email?.split('@')[0] || 'Admin' }
        : null,
      itemCount: row.itemIds.length,
    },
    ids: new Set(row.itemIds),
  };
}

/** Whether an admin acknowledged the report and nothing has gone to client
 *  since: the gate for adding a client login and issuing a sign-in link
 *  (C2). One query, no item bodies: the newest acknowledgement exists and no
 *  client-level item is missing from it. */
export async function clientReportAcknowledged(ownerId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    with ack as (
      select item_ids from client_report_acks
       where owner_id = ${ownerId}
       order by acked_at desc limit 1)
    select exists (select 1 from ack)
       and not exists (
         select 1 from nodes n
          where n.owner_id = ${ownerId}
            and (n.audience = 'client' or n.inherited_level = 'client')
            and not (n.id = any (coalesce((select item_ids from ack), '{}'::uuid[])))) as ok`)) as unknown as {
    ok: boolean;
  }[];
  return rows[0]?.ok === true;
}

/** The report (GET /api/access/client-report). `max`: how many items to
 *  list (tests lower it); `total` and the fingerprint always cover all. */
export async function clientReport(
  ownerId: string,
  opts: { max?: number } = {},
): Promise<ClientReport> {
  const allIds = await clientItemIds(ownerId);
  const listed = await itemRows(allIds.slice(0, opts.max ?? CLIENT_REPORT_MAX));
  const ids = listed.map((i) => i.id);

  // Live open links (made when client meant a link).
  const links = new Map<string, ClientReportItem['link']>();
  if (ids.length) {
    const rows = await db
      .select({
        id: shares.id,
        nodeId: shares.nodeId,
        createdAt: shares.createdAt,
        viewCount: shares.viewCount,
        lastViewedAt: shares.lastViewedAt,
        expiresAt: shares.expiresAt,
      })
      .from(shares)
      .where(
        and(
          eq(shares.ownerId, ownerId),
          inArray(shares.nodeId, ids),
          isNull(shares.revokedAt),
          sql`(${shares.expiresAt} is null or ${shares.expiresAt} > now())`,
        ),
      );
    for (const r of rows) {
      links.set(r.nodeId, {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        viewCount: r.viewCount,
        lastViewedAt: r.lastViewedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
      });
    }
  }

  const emailed = await emailedTo(
    ownerId,
    listed.filter((i) => i.type === 'page').map((i) => i.id),
  );
  const above = await oldLinksAbove(ownerId, ids);

  // What each names that a client may not read. Only the brain's own items
  // are looked up: a ref to anything else (a member's personal item, an
  // admin's private one) comes back with no type, title or level, so its
  // title never reaches the report (audit A8).
  const named = await namedIds(listed);
  const refIds = [...new Set([...named.values()].flat())];
  const refRows = refIds.length
    ? await db
        .select({
          id: nodes.id,
          type: nodes.type,
          title: nodes.title,
          audience: nodes.audience,
          inheritedLevel: nodes.inheritedLevel,
        })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, refIds)))
    : [];
  const refById = new Map(refRows.map((r) => [r.id, r]));
  const refsAbove = (id: string): ClientReportRef[] =>
    (named.get(id) ?? []).flatMap((ref): ClientReportRef[] => {
      const r = refById.get(ref);
      if (!r) return [{ id: ref, type: null, title: null, audience: null }];
      if (isReadAt(r.audience, r.inheritedLevel, ['client']) || ref === id) return [];
      return [
        {
          id: ref,
          type: r.type,
          title: r.title,
          audience: LEVELS.includes(r.audience) ? (r.audience as ViewerLevel) : null,
        },
      ];
    });

  const acked = await newestAck(ownerId);
  const newSinceAck = allIds.filter((i) => !acked?.ids.has(i));
  return {
    items: listed.map((i) => {
      const old = above.get(i.id);
      return {
        id: i.id,
        type: i.type,
        title: i.title,
        updatedAt: i.updatedAt.toISOString(),
        link: links.get(i.id) ?? null,
        emailedTo: [...(emailed.get(i.id) ?? [])].sort(),
        refsAbove: refsAbove(i.id),
        ...(old?.length ? { oldLinksAbove: old } : {}),
      };
    }),
    total: allIds.length,
    acknowledgement: acked?.ack ?? null,
    acknowledged: !!acked && newSinceAck.length === 0,
    newSinceAck,
    fingerprint: clientReportFingerprint(allIds),
  };
}

/**
 * An admin acknowledges the report (POST /api/access/client-report/ack).
 *
 *  - `{ fingerprint }` (preferred): the report's fingerprint. The server
 *    recomputes it over every client-level item now; equal records all of
 *    them, different throws ClientReportChangedError (409, the client
 *    reloads the report).
 *  - the ids the admin was shown (old clients): only those at client level
 *    now are recorded, so an item that went to client between showing and
 *    clicking is never acknowledged unseen.
 */
export async function acknowledgeClientReport(
  ownerId: string,
  loginId: string,
  seen: readonly string[] | { fingerprint: string },
): Promise<{ acknowledgement: ClientReportAck; acknowledged: boolean }> {
  const current = await clientItemIds(ownerId);
  let itemIds: string[];
  if ('fingerprint' in seen) {
    if (clientReportFingerprint(current) !== seen.fingerprint.toLowerCase()) {
      throw new ClientReportChangedError();
    }
    itemIds = current;
  } else {
    const seenSet = new Set(seen);
    itemIds = current.filter((i) => seenSet.has(i));
  }
  await db.insert(clientReportAcks).values({ ownerId, ackedBy: loginId, itemIds });
  const acked = (await newestAck(ownerId))!;
  return {
    acknowledgement: acked.ack,
    acknowledged: current.every((i) => acked.ids.has(i)),
  };
}
