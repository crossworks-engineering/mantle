/**
 * Operator-approved tool execution. The tool-loop enqueues rows here
 * when a `requires_confirm` tool is requested; this module owns the
 * approve/reject lifecycle and the post-approval dispatch.
 */

import { and, desc, eq } from 'drizzle-orm';
import {
  db,
  pendingToolCalls,
  type PendingToolCall,
  tools as toolsTable,
} from '@mantle/db';
import { dispatchTool } from './dispatch';
import { startTrace, step } from '@mantle/tracing';

export type PendingSummary = {
  id: string;
  toolSlug: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  agentId: string | null;
  traceId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

function toSummary(row: PendingToolCall): PendingSummary {
  return {
    id: row.id,
    toolSlug: row.toolSlug,
    args: (row.args ?? {}) as Record<string, unknown>,
    status: row.status,
    agentId: row.agentId,
    traceId: row.traceId,
    result: (row.result ?? null) as Record<string, unknown> | null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

export type ListPendingOptions = {
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  limit?: number;
};

export async function listPendingCalls(
  ownerId: string,
  opts: ListPendingOptions = {},
): Promise<PendingSummary[]> {
  const conds = [eq(pendingToolCalls.ownerId, ownerId)];
  if (opts.status) conds.push(eq(pendingToolCalls.status, opts.status));
  const rows = await db
    .select()
    .from(pendingToolCalls)
    .where(and(...conds))
    .orderBy(desc(pendingToolCalls.createdAt))
    .limit(opts.limit ?? 100);
  return rows.map(toSummary);
}

export async function countPending(ownerId: string): Promise<number> {
  const rows = await db
    .select({ id: pendingToolCalls.id })
    .from(pendingToolCalls)
    .where(
      and(
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
      ),
    );
  return rows.length;
}

export async function getPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingSummary | null> {
  const [row] = await db
    .select()
    .from(pendingToolCalls)
    .where(and(eq(pendingToolCalls.id, id), eq(pendingToolCalls.ownerId, ownerId)))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Mark a pending call rejected. No execution; just a status flip.
 * Returns the updated summary or null if not found / already decided.
 */
export async function rejectPendingCall(
  ownerId: string,
  id: string,
): Promise<PendingSummary | null> {
  const [row] = await db
    .update(pendingToolCalls)
    .set({
      status: 'rejected',
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
      ),
    )
    .returning();
  return row ? toSummary(row) : null;
}

/**
 * Approve a pending call — flips status, dispatches the tool, persists
 * the result. Wraps the dispatch in a `manual`-kind trace so the
 * execution shows up in /traces with its inputs + output + duration.
 *
 * Returns the updated summary. The row's `result` / `error` fields
 * reflect the dispatch outcome; status flips to `approved` regardless
 * of whether the tool succeeded — the operator already said yes.
 */
export async function approvePendingCall(
  ownerId: string,
  id: string,
): Promise<PendingSummary | null> {
  // Atomic claim — only act if still pending.
  const [claimed] = await db
    .update(pendingToolCalls)
    .set({ status: 'approved', decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(pendingToolCalls.id, id),
        eq(pendingToolCalls.ownerId, ownerId),
        eq(pendingToolCalls.status, 'pending'),
      ),
    )
    .returning();
  if (!claimed) return null;

  // Resolve the tool by slug (not the snapshot at queue time — the
  // operator might have edited the handler in the meantime).
  const [tool] = await db
    .select()
    .from(toolsTable)
    .where(
      and(
        eq(toolsTable.ownerId, ownerId),
        eq(toolsTable.slug, claimed.toolSlug),
        eq(toolsTable.enabled, true),
      ),
    )
    .limit(1);
  if (!tool) {
    const [errRow] = await db
      .update(pendingToolCalls)
      .set({
        error: `tool '${claimed.toolSlug}' is not registered or disabled`,
        executedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(pendingToolCalls.id, claimed.id))
      .returning();
    return errRow ? toSummary(errRow) : null;
  }

  // Execute under a fresh `manual` trace so the operator can audit the
  // run in /traces. The originating turn's trace is long closed by now.
  let outputJson: Record<string, unknown> | null = null;
  let errorText: string | null = null;
  await startTrace(
    {
      kind: 'manual',
      ownerId,
      subjectId: claimed.id,
      subjectKind: 'pending_tool_call',
      agentId: claimed.agentId,
      data: { toolSlug: claimed.toolSlug, args: claimed.args },
    },
    async () => {
      await step(
        {
          name: `tool: ${claimed.toolSlug}`,
          kind: 'compute',
          input: { slug: claimed.toolSlug, args: claimed.args },
        },
        async (handle) => {
          const res = await dispatchTool(
            tool,
            (claimed.args ?? {}) as Record<string, unknown>,
            {
              ownerId,
              step: {
                setMeta: (m) => handle.setMeta(m),
                setOutput: (o) => handle.setOutput(o),
              },
            },
          );
          if (res.ok) {
            outputJson =
              typeof res.output === 'object' && res.output !== null
                ? (res.output as Record<string, unknown>)
                : { value: res.output };
          } else {
            errorText = res.error;
            handle.setMeta({ error: res.error });
          }
        },
      );
    },
  );

  const [updated] = await db
    .update(pendingToolCalls)
    .set({
      result: outputJson,
      error: errorText,
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pendingToolCalls.id, claimed.id))
    .returning();
  return updated ? toSummary(updated) : null;
}
