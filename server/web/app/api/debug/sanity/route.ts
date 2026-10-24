import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { runSanityChecks } from '@/lib/sanity/checks';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
});

// Read-only system sanity checks: config/provisioning correctness (bucket
// exists, updater configured, required secrets, files root, public URL,
// embedder model, job schema). No writes.

export async function GET() {
  const user = ownerCaller();
  const report = await runSanityChecks(user.id);
  return NextResponse.json(report);
}
