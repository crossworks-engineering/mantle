import { NextResponse } from 'next/server';

import { getOwnerOr401 } from '@/lib/auth';
import { runCorpusAudit } from '@/lib/integrity/audit';

// Read-only invariant scan over the existing corpus. No writes, no fixtures.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const report = await runCorpusAudit(user.id);
  return NextResponse.json(report);
}
