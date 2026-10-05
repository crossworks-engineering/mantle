import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { readServiceLog, readServiceRun } from '@/lib/services';
import type { ServiceRunPoll } from '@mantle/client-types';

/** GET /api/services/status — poll target while a switch runs: the run's
 *  phase and the tail of its output. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [run, log] = await Promise.all([readServiceRun(), readServiceLog()]);
  const body: ServiceRunPoll = { run, log };
  return NextResponse.json(body);
}
