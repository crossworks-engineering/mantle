import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getQueueHealth, listRunnerNames } from '@/lib/runners';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/runners/meta
 *
 * Sidecar bundle for the Runners header + filters: the runner queue's config +
 * live ENQUEUED/PENDING counts, plus the distinct runner function names for the
 * name filter. Polled by the client for live queue health. Owner-gated.
 */
export async function GET() {
  ownerCaller();
  const [queue, names] = await Promise.all([getQueueHealth(), listRunnerNames()]);
  return NextResponse.json({ queue, names });
}
