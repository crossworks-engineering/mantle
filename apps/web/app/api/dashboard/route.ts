import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { recentFailures, spendByDay, topErrors } from '@/lib/metrics';
import {
  brainCounts,
  corpusCapacity,
  emailStats,
  graphIntegrity,
  heartbeatStats,
  nodesCreatedByDay,
  pendingToolCount,
  telegramStats,
  vectorCounts,
} from '@/lib/dashboard';

/**
 * GET /api/dashboard — the full "brain health" bundle for the web dashboard
 * (apps/web/app/(app)/page.tsx): brain/vector counts, 30d ingest + spend,
 * email/telegram/heartbeat ops, pending approvals, top errors + recent
 * failures, and graph integrity. Owner-scoped. (The compact mobile-companion
 * headline lives separately at /api/dashboard/summary.)
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const [brain, vectors, ingest, spend30, email, telegram, heartbeats, pendingTools, errs, fails, integrity, capacity] =
    await Promise.all([
      brainCounts(user.id),
      vectorCounts(user.id),
      nodesCreatedByDay(user.id, 30),
      spendByDay(user.id, 30),
      emailStats(user.id),
      telegramStats(user.id),
      heartbeatStats(user.id),
      pendingToolCount(user.id),
      topErrors(user.id, 7),
      recentFailures(user.id, 10),
      graphIntegrity(user.id),
      corpusCapacity(user.id),
    ]);

  return NextResponse.json({
    brain,
    vectors,
    ingest,
    spend30,
    capacity,
    email,
    telegram,
    heartbeats,
    pendingTools,
    errs,
    fails,
    integrity,
  });
}
