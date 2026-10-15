import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { getSystemHealth } from '@/lib/system-health';
import { CACHE_CONTROL } from '@/lib/cache-control';

/**
 * Live system vitals for the dashboard's polling island. Owner-gated,
 * never cached. Host probes are timeout-bounded inside getSystemHealth so
 * this returns quickly even if a probe stalls.
 */

export async function GET() {
  const user = ownerCaller();
  const health = await getSystemHealth(user.id);
  return NextResponse.json(health, {
    headers: { 'Cache-Control': CACHE_CONTROL.noneRevalidate },
  });
}
