import { NextResponse } from '@/server/http-compat';

import { getOwnerOr401 } from '@/lib/auth';
import { runCorpusAudit } from '@/lib/integrity/audit';

// Read-only invariant scan over the existing corpus. No writes, no fixtures.

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const report = await runCorpusAudit(user.id);
  return NextResponse.json(report);
}
