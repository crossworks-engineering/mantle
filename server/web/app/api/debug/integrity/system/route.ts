import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { checkSystemIntegrity } from '@/lib/system-manifest';

// Read-only config-integrity check: the agent/skill/tool/worker link graph vs
// the manifest. No writes.

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const report = await checkSystemIntegrity(user.id);
  return NextResponse.json(report);
}
