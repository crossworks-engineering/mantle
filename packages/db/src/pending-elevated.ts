/**
 * An elevated pending call on the system pool: the row the approval rule judges and then claims, whatever the deciding
 * scope reads. The rule (@mantle/tools pending-approval.ts) is who may
 * approve it, the owner or a login whose own scope passes the connector
 * rule, and its asker never: by definition not the login whose row it is,
 * so a workspace scope's row rule (pending_tool_calls: a login reads only
 * its own) would hide it from every approver on a scoped surface (a login's
 * own MCP). Pending calls are infrastructure (as execute-call.ts inserts
 * them), read here by id and only while elevated and pending; nothing else.
 *
 * It also rejects one for a login the rule lets decide it,
 * names the live workspaces a re-checked call asked in by a turn that
 * answered no login still reads (liveWorkspaceIds), and reads any other
 * call an approval judges before it claims it (pendingCallToDecide): the
 * same reason, a deciding scope's row rule would hide it from its approver.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { systemDb } from './client';
import { agents, pendingToolCalls, workspaces, type PendingToolCall } from './schema/index';

const waiting = (ownerId: string, id: string) =>
  and(
    eq(pendingToolCalls.id, id),
    eq(pendingToolCalls.ownerId, ownerId),
    eq(pendingToolCalls.status, 'pending'),
    isNotNull(pendingToolCalls.elevated),
  );

/** The elevated call `id` while it waits for approval, or null. */
export async function elevatedPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingToolCall | null> {
  const [row] = await systemDb.select().from(pendingToolCalls).where(waiting(ownerId, id)).limit(1);
  return row ?? null;
}

/**
 * A call that is not elevated, while it waits for approval: the row an approval reads to judge it again before it claims it
 * (@mantle/tools pending.ts), on the system pool. The deciding scope's row
 * rule (0254: a login reads only its own rows of the workspaces it holds
 * now) would hide it from the owner's MCP scope, an Admin assistant's turn,
 * and from an asker who left the workspace it asked in, and the call would
 * then run unjudged. Who may decide it is not read here: the caller applies
 * its own rule (deciderFilter's, in code) to the row before it judges it.
 */
export async function pendingCallToDecide(
  ownerId: string,
  id: string,
): Promise<PendingToolCall | null> {
  const [row] = await systemDb
    .select()
    .from(pendingToolCalls)
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
        isNull(pendingToolCalls.elevated),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Claim the elevated call `id` the rule let its approver run: approved,
 *  if it still waits. The claimed row, or null (decided meanwhile). */
export async function claimElevatedPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingToolCall | null> {
  const now = new Date();
  const [row] = await systemDb
    .update(pendingToolCalls)
    .set({ status: 'approved', decidedAt: now, updatedAt: now })
    .where(waiting(ownerId, id))
    .returning();
  return row ?? null;
}

/** The workspace an elevated call was asked in: its own, else the brain's
 *  Admin workspace (a row with no workspace is Admin's, 0250). Which
 *  workspace is Admin grants nothing; the rule reads the connector there. */
export async function elevatedCallWorkspace(
  ownerId: string,
  row: Pick<PendingToolCall, 'workspaceId'>,
): Promise<string | null> {
  if (row.workspaceId) return row.workspaceId;
  const [admin] = await systemDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.ownerId, ownerId),
        eq(workspaces.isAdmin, true),
        sql`${workspaces.archivedAt} is null`,
      ),
    )
    .limit(1);
  return admin?.id ?? null;
}

/** Reject the elevated call `id` for a login the approval rule lets decide
 *  it (whoever may approve it may also reject it). The
 *  rejected row, or null (decided meanwhile). */
export async function rejectElevatedPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingToolCall | null> {
  const now = new Date();
  const [row] = await systemDb
    .update(pendingToolCalls)
    .set({ status: 'rejected', decidedAt: now, updatedAt: now })
    .where(waiting(ownerId, id))
    .returning();
  return row ?? null;
}

/** Which of `ids` are live workspaces of brain `ownerId` now:
 *  what a pending call asked by a turn that answered no login (a workspace
 *  assistant's heartbeat) still reads at approval. Only names: it grants
 *  nothing. */
export async function liveWorkspaceIds(ownerId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await systemDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.ownerId, ownerId),
        inArray(workspaces.id, [...ids]),
        sql`${workspaces.archivedAt} is null`,
      ),
    );
  return rows.map((r) => r.id.toLowerCase());
}

/** Which of `ids` the assistant `agentId` of brain `ownerId` still runs
 *  in: its workspace now, when it is one of `ids` and live. What a call
 *  asked by its turn that answered no login still holds at approval (its
 *  workspace, and Moderator seats the stamp named there). No agent (gone,
 *  or another brain's): nothing. Only names: it grants nothing. */
export async function assistantWorkspaceIds(
  ownerId: string,
  agentId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const [agent] = await systemDb
    .select({ ws: agents.workspaceId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
    .limit(1);
  const ws = agent?.ws?.toLowerCase();
  if (!ws || !ids.some((w) => w.toLowerCase() === ws)) return [];
  return liveWorkspaceIds(ownerId, [ws]);
}
