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
 * Read-only, on the admin pool (an owner route calls it). The acknowledgement
 * is a row in client_report_acks (0187) with the ids the admin saw; the
 * report asks again once an item not in that list is at client level.
 * Adding a client login stays disabled until then (C2). No LLM work.
 */
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
import { noteRefs, pageRefs } from './embed-refs';

/** The report lists at most this many items (newest first); `total` counts all. */
export const CLIENT_REPORT_MAX = 2000;

const LEVELS: readonly string[] = ['admin', 'team', 'client', 'public'];

/** The client-level items of the brain, newest first. */
async function clientItems(ownerId: string) {
  return db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      updatedAt: nodes.updatedAt,
      data: nodes.data,
    })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.audience, 'client')))
    .orderBy(desc(nodes.updatedAt));
}

/** Every id a page or note names (links, mention chips, embeds). */
async function namedIds(
  items: { id: string; type: string; data: unknown }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const pageIds = items.filter((i) => i.type === 'page').map((i) => i.id);
  if (pageIds.length) {
    const rows = await db
      .select({ id: pages.nodeId, doc: pages.doc })
      .from(pages)
      .where(inArray(pages.nodeId, pageIds));
    for (const r of rows) out.set(r.id, pageRefs(r.doc).ids);
  }
  for (const i of items) {
    if (i.type !== 'note') continue;
    const content = (i.data as { content?: unknown } | null)?.content;
    if (typeof content === 'string' && content) out.set(i.id, noteRefs(content).ids);
  }
  return out;
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
 *  since: the gate for adding a client login (C2). */
export async function clientReportAcknowledged(ownerId: string): Promise<boolean> {
  const [ack, items] = await Promise.all([newestAck(ownerId), clientItems(ownerId)]);
  return !!ack && items.every((i) => ack.ids.has(i.id));
}

/** The report (GET /api/access/client-report). */
export async function clientReport(ownerId: string): Promise<ClientReport> {
  const all = await clientItems(ownerId);
  const listed = all.slice(0, CLIENT_REPORT_MAX);
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

  // Who a page was emailed to (the email_page tool's own trace steps).
  const emailed = new Map<string, Set<string>>();
  const pageIds = listed.filter((i) => i.type === 'page').map((i) => i.id);
  if (pageIds.length) {
    const rows = (await db.execute(sql`
      select s.input->'args'->>'pageId' as id,
             concat_ws(',', s.input->'args'->>'to', s.input->'args'->>'cc') as addrs
        from trace_steps s join traces t on t.id = s.trace_id
       where t.owner_id = ${ownerId} and s.name = 'tool: email_page'
         and s.input->'args'->>'pageId' in (${sql.join(
           pageIds.map((i) => sql`${i}`),
           sql`, `,
         )})`)) as unknown as {
      id: string;
      addrs: string | null;
    }[];
    for (const r of rows) {
      const set = emailed.get(r.id) ?? new Set<string>();
      for (const a of (r.addrs ?? '').split(/[,;]/)) {
        const addr = a.trim().toLowerCase();
        if (addr.includes('@')) set.add(addr);
      }
      emailed.set(r.id, set);
    }
  }

  // What each names that a client may not read.
  const named = await namedIds(listed);
  const refIds = [...new Set([...named.values()].flat())];
  const refRows = refIds.length
    ? await db
        .select({
          id: nodes.id,
          ownerId: nodes.ownerId,
          type: nodes.type,
          title: nodes.title,
          audience: nodes.audience,
        })
        .from(nodes)
        .where(inArray(nodes.id, refIds))
    : [];
  const refById = new Map(refRows.map((r) => [r.id, r]));
  const refsAbove = (id: string): ClientReportRef[] =>
    (named.get(id) ?? []).flatMap((ref): ClientReportRef[] => {
      const r = refById.get(ref);
      if (!r) return [{ id: ref, type: null, title: null, audience: null }];
      const brain = r.ownerId === ownerId;
      if (brain && (r.audience === 'client' || ref === id)) return [];
      return [
        {
          id: ref,
          type: r.type,
          title: r.title,
          audience: brain && LEVELS.includes(r.audience) ? (r.audience as ViewerLevel) : null,
        },
      ];
    });

  const acked = await newestAck(ownerId);
  const newSinceAck = all.filter((i) => !acked?.ids.has(i.id)).map((i) => i.id);
  return {
    items: listed.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      updatedAt: i.updatedAt.toISOString(),
      link: links.get(i.id) ?? null,
      emailedTo: [...(emailed.get(i.id) ?? [])].sort(),
      refsAbove: refsAbove(i.id),
    })),
    total: all.length,
    acknowledgement: acked?.ack ?? null,
    acknowledged: !!acked && newSinceAck.length === 0,
    newSinceAck,
  };
}

/**
 * An admin acknowledges the report (POST /api/access/client-report/ack).
 * `seen` = the client-level item ids the admin was shown; only those that
 * are at client level now are recorded, so an item that went to client
 * between showing and clicking is never acknowledged unseen.
 */
export async function acknowledgeClientReport(
  ownerId: string,
  loginId: string,
  seen: readonly string[],
): Promise<{ acknowledgement: ClientReportAck; acknowledged: boolean }> {
  const current = await clientItems(ownerId);
  const seenSet = new Set(seen);
  const itemIds = current.filter((i) => seenSet.has(i.id)).map((i) => i.id);
  await db.insert(clientReportAcks).values({ ownerId, ackedBy: loginId, itemIds });
  const acked = (await newestAck(ownerId))!;
  return {
    acknowledgement: acked.ack,
    acknowledged: current.every((i) => acked.ids.has(i.id)),
  };
}
