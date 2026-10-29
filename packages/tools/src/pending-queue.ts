/**
 * Park an agent's tool call in Pending for the owner's decision. On approval
 * the same tool runs again with no agent context (the pending dispatch
 * passes only the owner), so the caller's `ctx.agent` branch is skipped and
 * the change applies. The caller has validated the call already.
 */
import { and, eq } from 'drizzle-orm';
import { agents, db, parkPendingCall } from '@mantle/db';
import { notifyPendingCreated } from './pending-notify';
import { pendingOriginNow } from './pending-origin';
import type { ToolHandlerContext, ToolHandlerResult } from './types';

export async function queueAgentCallForApproval(
  ctx: ToolHandlerContext & { agent: NonNullable<ToolHandlerContext['agent']> },
  toolSlug: string,
  args: Record<string, unknown>,
  message: string,
): Promise<ToolHandlerResult> {
  const [requester] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.ownerId, ctx.ownerId), eq(agents.slug, ctx.agent.slug)))
    .limit(1);
  // The approval queue is infrastructure: parked on the system pool
  // (packages/db pending-calls.ts), never by this caller's scoped write.
  const pendingId = await parkPendingCall({
    ownerId: ctx.ownerId,
    agentId: requester?.id ?? null,
    toolSlug,
    args,
    // The scope the asking turn runs in (0288).
    origin: await pendingOriginNow(ctx.surface),
  });
  if (pendingId) {
    void notifyPendingCreated({
      ownerId: ctx.ownerId,
      pendingId,
      toolSlug,
      args,
      via: `agent ${ctx.agent.slug}`,
    });
  }
  return {
    ok: true,
    output: {
      status: 'queued_for_approval',
      pending_id: pendingId,
      message: `${message} Queued at /pending; it applies once approved. Do not retry this turn.`,
    },
  };
}
