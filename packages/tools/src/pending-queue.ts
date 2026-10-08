/**
 * Park an agent's tool call in Pending for the owner's decision. On approval
 * the same tool runs again with no agent context (the pending dispatch
 * passes only the owner), so the caller's `ctx.agent` branch is skipped and
 * the change applies. The caller has validated the call already.
 */
import { and, eq } from 'drizzle-orm';
import { agents, db, pendingToolCalls } from '@mantle/db';
import { notifyPendingCreated } from './pending-notify';
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
  const [pending] = await db
    .insert(pendingToolCalls)
    .values({ ownerId: ctx.ownerId, agentId: requester?.id ?? null, toolSlug, args })
    .returning({ id: pendingToolCalls.id });
  if (pending?.id) {
    void notifyPendingCreated({
      ownerId: ctx.ownerId,
      pendingId: pending.id,
      toolSlug,
      args,
      via: `agent ${ctx.agent.slug}`,
    });
  }
  return {
    ok: true,
    output: {
      status: 'queued_for_approval',
      pending_id: pending?.id ?? null,
      message: `${message} Queued at /pending; it applies once approved. Do not retry this turn.`,
    },
  };
}
