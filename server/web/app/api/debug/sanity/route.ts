import { NextResponse } from 'next/server';

import { getOwnerOr401 } from '@/lib/auth';
import { runSanityChecks } from '@/lib/sanity/checks';

// Read-only system sanity checks: config/provisioning correctness (bucket
// exists, updater configured, required secrets, files root, public URL,
// embedder model, job schema). No writes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const report = await runSanityChecks(user.id);
  return NextResponse.json(report);
}
