import { NextResponse } from '@/server/http-compat';

import { ownerCaller } from '@/lib/auth';
import { runCorpusAudit } from '@/lib/integrity/audit';

// Read-only invariant scan over the existing corpus. No writes, no fixtures.

export async function GET() {
  const user = ownerCaller();
  const report = await runCorpusAudit(user.id);
  return NextResponse.json(report);
}
