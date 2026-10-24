import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { readServiceLog, readServiceRun } from '@/lib/services';
import type { ServiceRunPoll } from '@mantle/client-types';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/** GET /api/services/status — poll target while a switch runs: the run's
 *  phase and the tail of its output. */
export async function GET() {
  ownerCaller();
  const [run, log] = await Promise.all([readServiceRun(), readServiceLog()]);
  const body: ServiceRunPoll = { run, log };
  return NextResponse.json(body);
}
