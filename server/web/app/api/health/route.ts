import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { getSystemHealth } from '@/lib/system-health';

/**
 * Live system vitals for the dashboard's polling island. Owner-gated,
 * never cached. Host probes are timeout-bounded inside getSystemHealth so
 * this returns quickly even if a probe stalls.
 */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const health = await getSystemHealth(user.id);
  return NextResponse.json(health, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
