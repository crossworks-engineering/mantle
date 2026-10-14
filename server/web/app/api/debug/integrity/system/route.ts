import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { checkSystemIntegrity } from '@/lib/system-manifest';

// Read-only config-integrity check: the agent/skill/tool/worker link graph vs
// the manifest. No writes.

export async function GET() {
  const user = ownerCaller();
  const report = await checkSystemIntegrity(user.id);
  return NextResponse.json(report);
}
