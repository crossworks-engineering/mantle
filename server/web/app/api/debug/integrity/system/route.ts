import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { checkSystemIntegrity } from '@/lib/system-manifest';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

// Read-only config-integrity check: the agent/skill/tool/worker link graph vs
// the manifest. No writes.

export async function GET() {
  const user = ownerCaller();
  const report = await checkSystemIntegrity(user.id);
  return NextResponse.json(report);
}
