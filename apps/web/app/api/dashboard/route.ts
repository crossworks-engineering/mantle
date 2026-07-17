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
 *
 * This bundle is ~20 owner-scoped aggregate scans across a dozen tables, none
 * of which can use an index for count(*)/GROUP BY. The dashboard is polled and
 * often open in multiple tabs, so we memoize the assembled payload per user for
 * a few seconds — collapsing a burst of renders/polls into one DB pass. These
 * are health *trends*, not live counters, so a few seconds of staleness is
 * invisible. In-process (per web replica); no cross-instance coordination
 * needed since each instance just avoids its own redundant scans.
 */
const CACHE_TTL_MS = 5_000;
type Bundle = Record<string, unknown>;
const cache = new Map<string, { at: number; payload: Bundle }>();

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const cached = cache.get(user.id);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload);
  }

  const [
    brain,
    vectors,
    ingest,
    spend30,
    email,
    telegram,
    heartbeats,
    pendingTools,
    errs,
    fails,
    integrity,
    capacity,
  ] = await Promise.all([
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

  const payload: Bundle = {
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
  };
  cache.set(user.id, { at: Date.now(), payload });
  return NextResponse.json(payload);
}
