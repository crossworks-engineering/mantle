import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { spendByDay } from '@/lib/metrics';
import { brainCounts, vectorCounts, pendingToolCount } from '@/lib/dashboard';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/dashboard/summary — compact headline metrics for the mobile
 * companion's landing dashboard. Mirrors the web dashboard's KPI cards
 * (server/web/app/(app)/page.tsx): 7d spend (vs prior 7d), brain-graph counts,
 * embedded-vector total, and the pending-approval count. Owner-gated, so it
 * works with a session cookie or a mobile bearer token.
 */
export async function GET() {
  const owner = ownerCaller();

  const [brain, vectors, spend14, pendingCount] = await Promise.all([
    brainCounts(owner.id),
    vectorCounts(owner.id),
    spendByDay(owner.id, 14),
    pendingToolCount(owner.id),
  ]);

  const last7 = spend14.slice(-7).reduce((a, d) => a + d.costMicroUsd, 0);
  const prior7 = spend14.slice(-14, -7).reduce((a, d) => a + d.costMicroUsd, 0);

  return NextResponse.json({
    spend: { last7MicroUsd: last7, prior7MicroUsd: prior7 },
    brain: {
      nodesTotal: brain.nodesTotal,
      entitiesTotal: brain.entitiesTotal,
      edgesTotal: brain.edgesTotal,
      factsTotal: brain.factsTotal,
    },
    vectors: {
      vectorsTotal: vectors.vectorsTotal,
      nodesIndexed: vectors.nodesIndexed,
      nodesTotal: vectors.nodesTotal,
    },
    pendingCount,
  });
}
