import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getQueueHealth, listRunnerNames } from '@/lib/runners';

/**
 * GET /api/runners/meta
 *
 * Sidecar bundle for the Runners header + filters: the runner queue's config +
 * live ENQUEUED/PENDING counts, plus the distinct runner function names for the
 * name filter. Polled by the client for live queue health. Owner-gated.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [queue, names] = await Promise.all([getQueueHealth(), listRunnerNames()]);
  return NextResponse.json({ queue, names });
}
