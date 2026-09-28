/**
 * Team change-requests — the specialist review surface for the request→task→
 * correction loop. A team member's change ask is filed by `team_request_create`
 * as a task tagged `team-request` carrying a `data.teamRequest` provenance block
 * (contactId, contactName, threadMessageId, attachments). This module lists
 * those tasks for the /team-admin Requests view and closes the loop by posting
 * the owner's resolution back into the member's thread.
 */
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { TEAM_REQUEST_SOURCE, db, nodes, notifyNodeIngested } from '@mantle/db';
import { appendTeamMessage } from './team-messages';
import type { TeamRequest } from '@mantle/client-types';
export type { TeamRequest };

export const TEAM_REQUEST_TAG = 'team-request';

/**
 * How many requests a member may file through the team agent (audit F08).
 * Each one is an admin task in the review queue; the caps keep a runaway or
 * injected turn from flooding it. Per turn = per inbound message; per day =
 * the last 24 hours, per member login.
 */
export const TEAM_REQUESTS_PER_TURN = 3;
export const TEAM_REQUESTS_PER_DAY = 20;

/**
 * Team requests already filed: those stamped with this inbound message (the
 * turn), or by this requester since `since`. The tasks are admin level: a
 * caller on the limited team role (the team turn) must run this inside
 * `asSystem`, as `team_request_create` does, or it counts nothing and the cap
 * never closes.
 */
export async function countTeamRequestsFiled(
  ownerId: string,
  by:
    | { threadMessageId: string }
    | { loginId: string; since: Date }
    | { contactId: string; since: Date },
): Promise<number> {
  const conds = [
    eq(nodes.ownerId, ownerId),
    eq(nodes.type, 'task'),
    sql`${TEAM_REQUEST_TAG} = ANY(${nodes.tags})`,
  ];
  if ('threadMessageId' in by) {
    conds.push(sql`${nodes.data}->'teamRequest'->>'threadMessageId' = ${by.threadMessageId}`);
  } else {
    conds.push(gte(nodes.createdAt, by.since));
    conds.push(
      'loginId' in by
        ? sql`${nodes.data}->'teamRequest'->>'loginId' = ${by.loginId}`
        : sql`${nodes.data}->'teamRequest'->>'contactId' = ${by.contactId}`,
    );
  }
  const [row] = await db
    .select({ n: count() })
    .from(nodes)
    .where(and(...conds));
  return row?.n ?? 0;
}

/**
 * An admin acted on a team request (edited it, closed it, answered it): stamp
 * `data.reviewed_at` so the extractor may index it from now on
 * (extract-exempt.ts), and announce it once, as an ordinary task's insert is
 * announced. A no-op for any other task and for one already reviewed. Called
 * from the admin paths only (the task routes and tools, the Requests reply).
 */
export async function markTeamRequestReviewed(ownerId: string, taskId: string): Promise<boolean> {
  const rows = await db
    .update(nodes)
    .set({
      data: sql`coalesce(${nodes.data}, '{}'::jsonb) || jsonb_build_object('reviewed_at', ${new Date().toISOString()}::text)`,
    })
    .where(
      and(
        eq(nodes.id, taskId),
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'task'),
        sql`${nodes.data}->>'source' = ${TEAM_REQUEST_SOURCE}`,
        sql`coalesce(${nodes.data}->>'reviewed_at', '') = ''`,
      ),
    )
    .returning({ id: nodes.id });
  if (!rows.length) return false;
  await notifyNodeIngested(taskId);
  return true;
}

type TeamRequestData = {
  contactId?: string | null;
  /** The member login that filed it (team_request_create stamps both). */
  loginId?: string | null;
  contactName?: string | null;
  notifiedAt?: string | null;
};

/** Every team-request task for this owner, newest first. `contactId` narrows
 *  to one requester — the Members tab's per-person view (filtered in SQL, not
 *  by loading the whole queue and discarding most of it). */
export async function listTeamRequests(
  ownerId: string,
  opts: { status?: 'open' | 'done' | 'all'; limit?: number; contactId?: string } = {},
): Promise<TeamRequest[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conds = [
    eq(nodes.ownerId, ownerId),
    eq(nodes.type, 'task'),
    sql`${TEAM_REQUEST_TAG} = ANY(${nodes.tags})`,
  ];
  const status = opts.status ?? 'open';
  // 'open' here means UNRESOLVED. Tasks carry a 4-state lifecycle since the
  // Kanban upgrade, so equality on 'open' would silently drop a request the
  // owner dragged to In progress/Blocked — the member is still waiting.
  if (status === 'open') {
    conds.push(sql`coalesce(${nodes.data}->>'status', 'open') <> 'done'`);
  } else if (status !== 'all') {
    conds.push(sql`coalesce(${nodes.data}->>'status', 'open') = ${status}`);
  }
  if (opts.contactId) {
    conds.push(sql`${nodes.data}->'teamRequest'->>'contactId' = ${opts.contactId}`);
  }
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data, createdAt: nodes.createdAt })
    .from(nodes)
    .where(and(...conds))
    .orderBy(desc(nodes.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const tr = (d.teamRequest ?? {}) as TeamRequestData;
    return {
      taskId: r.id,
      title: r.title,
      body: typeof d.body === 'string' ? d.body : '',
      status: d.status === 'done' ? 'done' : 'open',
      priority: typeof d.priority === 'string' ? d.priority : 'normal',
      createdAt: r.createdAt.toISOString(),
      contactId: typeof tr.contactId === 'string' ? tr.contactId : null,
      loginId: typeof tr.loginId === 'string' && tr.loginId ? tr.loginId : null,
      contactName: typeof tr.contactName === 'string' ? tr.contactName : null,
      notifiedAt: typeof tr.notifiedAt === 'string' ? tr.notifiedAt : null,
    };
  });
}

export type NotifyTeamRequesterResult =
  { ok: true; contactId: string | null; loginId: string | null } | { ok: false; error: string };

/**
 * Close the loop on a team request: post the owner's reply into the requesting
 * member's thread (an outbound message with no agent, a human admin note),
 * stamp `data.teamRequest.notifiedAt`, and optionally mark the task done. The
 * message + the task stamp are the durable record; the member sees the reply
 * the next time they open their chat.
 *
 * A request a member LOGIN filed goes into that login's own thread (the one
 * the dock shows). Only a request from the retired team-code portal, with a
 * contact and no login, still lands in the contact's old thread, where
 * admins read it as history (Phase 6).
 */
export async function notifyTeamRequester(
  ownerId: string,
  taskId: string,
  opts: { text: string; markDone?: boolean },
): Promise<NotifyTeamRequesterResult> {
  const text = opts.text.trim();
  if (!text) return { ok: false, error: 'a reply message is required' };

  const [task] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  if (!task) return { ok: false, error: 'request not found' };

  const d = (task.data ?? {}) as Record<string, unknown>;
  const tr = (d.teamRequest ?? {}) as TeamRequestData;
  const loginId = typeof tr.loginId === 'string' && tr.loginId ? tr.loginId : null;
  const contactId = typeof tr.contactId === 'string' && tr.contactId ? tr.contactId : null;
  if (!loginId && !contactId) {
    return { ok: false, error: 'not a team request (no requester on file)' };
  }

  // The reply lands in the requester's thread as an outbound message. No
  // agentId: it is the brain admin speaking, not the responder.
  await appendTeamMessage({
    ownerId,
    contactId: loginId ? null : contactId,
    loginId,
    direction: 'outbound',
    text,
    channel: 'web',
  });

  // Stamp the request: notifiedAt (+ status done when resolving). Merge the
  // teamRequest sub-object so the rest of its provenance is preserved.
  const nowIso = new Date().toISOString();
  const mergedTeamRequest = { ...tr, notifiedAt: nowIso };
  const dataPatch: Record<string, unknown> = { teamRequest: mergedTeamRequest };
  if (opts.markDone) dataPatch.status = 'done';
  await db
    .update(nodes)
    .set({
      data: sql`coalesce(${nodes.data}, '{}'::jsonb) || ${JSON.stringify(dataPatch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(nodes.id, taskId), eq(nodes.ownerId, ownerId)));
  // Answering the member is an admin acting on the request: from now on the
  // extractor may index it (audit F08).
  await markTeamRequestReviewed(ownerId, taskId);

  return { ok: true, contactId, loginId };
}
