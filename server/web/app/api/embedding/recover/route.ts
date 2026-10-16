import { NextResponse } from '@/server/http-compat';
import { loadProviderAlerts } from '@mantle/content';
import { retryProvidersNow } from '@/lib/embedding-config';
import { ownerCaller } from '@/lib/auth';

/**
 * GET: the provider outages an admin sees (docs/embeddings.md "Provider
 * outages"), for the app-shell banner and the dashboard. Fixed reasons only,
 * never provider text. Admins only: getOwnerOr401 refuses a member or a
 * client login.
 */
export async function GET() {
  const user = ownerCaller();
  return NextResponse.json({ alerts: await loadProviderAlerts(user.id) });
}

/**
 * POST: "Try again". Every open alert probes on the agent's next tick, and
 * the agent is told at once: when the provider works it closes the alert,
 * resumes the extract queue, re-drives the dead letters and sweeps the
 * unextracted nodes, with no restart. Bounded by the agent: one tiny probe
 * call per alert, and a recovery at most once per 2 min.
 */
export async function POST() {
  const user = ownerCaller();
  const probing = await retryProvidersNow(user.id);
  return NextResponse.json({ ok: true, probing });
}
