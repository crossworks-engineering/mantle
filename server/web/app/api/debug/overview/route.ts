import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { contentIndexCoverage, duplicateEdgeStats } from '@/lib/debug';
import {
  duplicateSuppressionStats,
  embedderCacheStats,
  factCostCapStats,
  recentFailures,
  spendByAgent,
  spendByDay,
  topErrors,
  trafficWindow,
} from '@/lib/metrics';

/**
 * GET /api/debug/overview — the Debug overview bundle: system health at a glance
 * (traffic, spend, cache, failures, duplicate edges/calls, fact-cap drops,
 * daily spend, index coverage). Owner-scoped. The client computes the cheap
 * derived percentages/totals from these raw aggregations.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [
    traffic24h,
    spend7d,
    cache7d,
    errors7d,
    recentFails,
    daily14d,
    dupes,
    coverage,
    dupCalls7d,
    factCap7d,
  ] = await Promise.all([
    trafficWindow(user.id, 24),
    spendByAgent(user.id, 7),
    embedderCacheStats(user.id, 7),
    topErrors(user.id, 7, 5),
    recentFailures(user.id, 10),
    spendByDay(user.id, 14),
    duplicateEdgeStats(user.id),
    contentIndexCoverage(user.id),
    duplicateSuppressionStats(user.id, 7),
    factCostCapStats(user.id, 7),
  ]);
  return NextResponse.json({
    traffic24h,
    spend7d,
    cache7d,
    errors7d,
    recentFails,
    daily14d,
    dupes,
    coverage,
    dupCalls7d,
    factCap7d,
  });
}
