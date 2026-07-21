import { NextResponse } from 'next/server';
import { and, desc, eq, sql } from 'drizzle-orm';
import { agents, db, runItems, runs } from '@mantle/db';
import { isRunsEnabled } from '@mantle/runs';
import { getOwnerOr401 } from '@/lib/auth';

/** GET /api/debug/runs — recent runs (newest first), the feature-gate state,
 *  and the per-worker first-pass acceptance rate (plan §9: accepted /
 *  (accepted + redone) over worker_invoke items — the metric that decides
 *  when cheaper worker tiers are justified). */
const LIMIT = 50;

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const rows = await db
    .select({
      id: runs.id,
      title: runs.title,
      status: runs.status,
      createdAt: runs.createdAt,
      completedAt: runs.completedAt,
      costMicroUsd: sql<string>`coalesce((select sum(${runItems.costMicroUsd}) from ${runItems} where ${runItems.runId} = ${runs.id}), 0)`,
      itemCount: sql<number>`(select count(*) from ${runItems} where ${runItems.runId} = ${runs.id})::int`,
    })
    .from(runs)
    .where(eq(runs.ownerId, user.id))
    .orderBy(desc(runs.createdAt))
    .limit(LIMIT);

  // Acceptance per worker agent: done-and-not-superseded = accepted;
  // superseded = redone (a redo replaced it). Owner-scoped via the runs join.
  const acceptance = await db
    .select({
      agentId: runItems.agentId,
      accepted: sql<number>`count(*) filter (where ${runItems.state} = 'done')::int`,
      redone: sql<number>`count(*) filter (where ${runItems.state} = 'superseded')::int`,
      failed: sql<number>`count(*) filter (where ${runItems.state} = 'failed')::int`,
    })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(and(eq(runs.ownerId, user.id), eq(runItems.kind, 'worker_invoke')))
    .groupBy(runItems.agentId);
  const agentRows = await db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, model: agents.model })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.role, 'worker')));
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const workers = acceptance
    .filter((a) => a.accepted + a.redone + a.failed > 0)
    .map((a) => {
      const agent = a.agentId ? byId.get(a.agentId) : undefined;
      const judged = a.accepted + a.redone;
      return {
        agentId: a.agentId,
        slug: agent?.slug ?? '(deleted worker)',
        name: agent?.name ?? null,
        model: agent?.model ?? null,
        accepted: a.accepted,
        redone: a.redone,
        failed: a.failed,
        acceptanceRate: judged > 0 ? a.accepted / judged : null,
      };
    });

  return NextResponse.json({
    enabled: isRunsEnabled(),
    runs: rows.map((r) => ({ ...r, costMicroUsd: Number(r.costMicroUsd) })),
    workers,
  });
}
