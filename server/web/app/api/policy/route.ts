import { NextResponse } from '@/server/http-compat';
import type { BoxPolicyReport } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { policyReport } from '@/lib/policy-check';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

/**
 * GET /api/policy: the box policy the operator set in the box .env
 * (MANTLE_POLICY_*, docs/policy.md), for the read-only Policy panel under
 * Settings. Admin users with the settings area only. Nothing here changes
 * a rule: the app cannot turn a policy off.
 *
 * 404 when no policy is set, so the panel does not appear on a box that
 * has none. Else BoxPolicyReport: each rule, and every enabled assistant,
 * worker or embedder on a model the model block refuses.
 */
export async function GET() {
  ownerCaller();
  const report = await policyReport();
  if (!report) return NextResponse.json({ error: 'no policy set' }, { status: 404 });
  const body: BoxPolicyReport = {
    ...report,
    models: {
      deny: [...report.models.deny],
      providerAllow: report.models.providerAllow && [...report.models.providerAllow],
    },
    endpointAllow: report.endpointAllow && [...report.endpointAllow],
  };
  return NextResponse.json(body);
}
