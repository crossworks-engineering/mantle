/**
 * Team change-requests — the specialist review surface for the request→task→
 * correction loop. A team member's change ask is filed by `team_request_create`
 * as a task tagged `team-request` carrying a `data.teamRequest` provenance block
 * (contactId, contactName, threadMessageId, attachments). This module lists
 * those tasks for the /team-admin Requests view and closes the loop by posting
 * the owner's resolution back into the member's thread.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { appendTeamMessage } from './team-messages';

export const TEAM_REQUEST_TAG = 'team-request';

export type TeamRequest = {
  taskId: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  priority: string;
  createdAt: string;
  /** Provenance from data.teamRequest — null contactId means a malformed row
   *  (shouldn't happen; team_request_create always stamps it). */
  contactId: string | null;
  contactName: string | null;
  /** When the owner last posted a resolution to the member for this request. */
  notifiedAt: string | null;
};

type TeamRequestData = {
  contactId?: string;
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
  if (status !== 'all') {
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
      contactName: typeof tr.contactName === 'string' ? tr.contactName : null,
      notifiedAt: typeof tr.notifiedAt === 'string' ? tr.notifiedAt : null,
    };
  });
}

export type NotifyTeamRequesterResult =
  | { ok: true; contactId: string }
  | { ok: false; error: string };

/**
 * Close the loop on a team request: post the owner's reply into the requesting
 * member's thread (an outbound message with no agent — a human admin note),
 * stamp `data.teamRequest.notifiedAt`, and optionally mark the task done. The
 * message + the task stamp are the durable record; the member sees the reply
 * next time they open Team Chat.
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
  if (!tr.contactId) return { ok: false, error: 'not a team request (no requester on file)' };

  // The reply lands in the member's thread as an outbound message. No agentId —
  // it's the brain admin speaking, not the responder.
  await appendTeamMessage({
    ownerId,
    contactId: tr.contactId,
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

  return { ok: true, contactId: tr.contactId };
}
