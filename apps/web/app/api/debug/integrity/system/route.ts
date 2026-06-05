import { NextResponse } from 'next/server';

import { requireOwner } from '@/lib/auth';
import { checkSystemIntegrity } from '@/lib/system-manifest';

// Read-only config-integrity check: the agent/skill/tool/worker link graph vs
// the manifest. No writes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireOwner();
  const report = await checkSystemIntegrity(user.id);
  return NextResponse.json(report);
}
