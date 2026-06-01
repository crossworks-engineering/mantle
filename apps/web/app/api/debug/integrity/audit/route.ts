import { NextResponse } from 'next/server';

import { requireOwner } from '@/lib/auth';
import { runCorpusAudit } from '@/lib/integrity/audit';

// Read-only invariant scan over the existing corpus. No writes, no fixtures.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireOwner();
  const report = await runCorpusAudit(user.id);
  return NextResponse.json(report);
}
