/**
 * GET /api/access/client-report -> "What clients see" (client logins C1):
 * every item at client level, its live open link from before client logins,
 * the addresses a page was emailed to, what it names that a client may not
 * read, and whether an admin has acknowledged the list. Owner only,
 * read-only, no model call. See @mantle/content client-report.ts.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { clientReport } from '@mantle/content';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await clientReport(user.id));
}
