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

  // First-pass acceptance per worker agent, classified against actual audit
  // verdicts (audit result.audited_item points at the judged worker item):
  //   superseded              → redone (a redo replaced it)
  //   done + audit pass       → accepted
  //   done + audit needs_human → needsHuman (an escalation is NOT a win)
  //   done + no/timed-out audit → unaudited (excluded from the rate — a plan
  //                               with no audits must not score 100%)
  //   failed                  → failed
  // Rate = accepted / (accepted + redone + needsHuman). Owner-scoped joins.
  const workerItems = await db
    .select({ id: runItems.id, agentId: runItems.agentId, state: runItems.state })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(and(eq(runs.ownerId, user.id), eq(runItems.kind, 'worker_invoke')));
  const auditRows = await db
    .select({
      state: runItems.state,
      auditedItem: sql<string | null>`${runItems.result} ->> 'audited_item'`,
      failureType: sql<string | null>`${runItems.result} -> 'failure' ->> 'type'`,
    })
    .from(runItems)
    .innerJoin(runs, eq(runs.id, runItems.runId))
    .where(and(eq(runs.ownerId, user.id), eq(runItems.kind, 'audit')));
  const auditByWorker = new Map(
    auditRows.filter((a) => a.auditedItem).map((a) => [a.auditedItem!, a]),
  );
  type Stat = { accepted: number; redone: number; needsHuman: number; failed: number; unaudited: number }; // prettier-ignore
  const stats = new Map<string | null, Stat>();
  for (const item of workerItems) {
    const s = stats.get(item.agentId) ?? {
      accepted: 0,
      redone: 0,
      needsHuman: 0,
      failed: 0,
      unaudited: 0,
    };
    const audit = auditByWorker.get(item.id);
    if (item.state === 'superseded') s.redone++;
    else if (item.state === 'failed') s.failed++;
    else if (item.state === 'done') {
      if (audit?.state === 'done') s.accepted++;
      else if (audit?.state === 'failed' && audit.failureType === 'needs_human') s.needsHuman++;
      else s.unaudited++;
    }
    stats.set(item.agentId, s);
  }
  const agentRows = await db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, model: agents.model })
    .from(agents)
    .where(and(eq(agents.ownerId, user.id), eq(agents.role, 'worker')));
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  const workers = [...stats.entries()]
    .filter(([, s]) => s.accepted + s.redone + s.needsHuman + s.failed + s.unaudited > 0)
    .map(([agentId, s]) => {
      const agent = agentId ? byId.get(agentId) : undefined;
      const judged = s.accepted + s.redone + s.needsHuman;
      return {
        agentId,
        slug: agent?.slug ?? '(deleted worker)',
        name: agent?.name ?? null,
        model: agent?.model ?? null,
        accepted: s.accepted,
        redone: s.redone,
        needsHuman: s.needsHuman,
        failed: s.failed,
        unaudited: s.unaudited,
        acceptanceRate: judged > 0 ? s.accepted / judged : null,
      };
    });

  return NextResponse.json({
    enabled: isRunsEnabled(),
    runs: rows.map((r) => ({ ...r, costMicroUsd: Number(r.costMicroUsd) })),
    workers,
  });
}
