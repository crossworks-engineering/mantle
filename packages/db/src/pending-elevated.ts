/**
 * An elevated pending call on the system pool (A5 step 6d fix round 1):
 * the row the approval rule judges and then claims, whatever the deciding
 * scope reads. The rule (@mantle/tools pending-approval.ts) is who may
 * approve it, the owner or a login whose own scope passes the connector
 * rule, and its asker never: by definition not the login whose row it is,
 * so a workspace scope's row rule (pending_tool_calls: a login reads only
 * its own) would hide it from every approver on a scoped surface (a login's
 * own MCP). Pending calls are infrastructure (as execute-call.ts inserts
 * them), read here by id and only while elevated and pending; nothing else.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { systemDb } from './client';
import { pendingToolCalls, workspaces, type PendingToolCall } from './schema/index';

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
