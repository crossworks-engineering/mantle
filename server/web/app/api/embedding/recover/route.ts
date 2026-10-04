import { NextResponse } from '@/server/http-compat';
import { requestProviderProbeNow } from '@mantle/db';
import { loadProviderAlerts } from '@mantle/content';
import { notifyProviderRecover } from '@/lib/embedding-config';
import { getOwnerOr401 } from '@/lib/auth';

/**
 * GET: the provider outages an admin sees (docs/embeddings.md "Provider
 * outages"), for the app-shell banner and the dashboard. Fixed reasons only,
 * never provider text. Admins only: getOwnerOr401 refuses a member or a
 * client login.
 */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const probing = await requestProviderProbeNow(user.id);
  await notifyProviderRecover(user.id);
  return NextResponse.json({ ok: true, probing });
}
