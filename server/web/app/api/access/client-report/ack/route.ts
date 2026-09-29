/**
 * POST /api/access/client-report/ack -> the acknowledgement (client logins
 * C1). Body, one of:
 *  - `{ fingerprint }` (preferred): the report's fingerprint, a hash of EVERY
 *    client-level item. The server recomputes it: equal records them all;
 *    different answers 409 `report-changed` and the client reloads the
 *    report (audit A7: the list shows 2000 items at most, the fingerprint
 *    covers the rest).
 *  - `{ itemIds }` (older clients): the client-level items the admin was
 *    shown; only those still at client level are recorded.
 * Adding a client login stays disabled until the newest acknowledgement
 * covers every client-level item (C2). Owner only; audited by the owner gate.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { acknowledgeClientReport, ClientReportChangedError } from '@mantle/content';
import { firstIssue } from '@/lib/zod-issue';

const Body = z.union([
  z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/i, 'fingerprint must be sha256 hex') }),
  z.object({ itemIds: z.array(z.string().uuid()).max(10_000) }),
]);

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: firstIssue(parsed.error, 'fingerprint or itemIds required.') },
      { status: 400 },
    );
  }
  const seen = 'fingerprint' in parsed.data ? parsed.data : parsed.data.itemIds;
  try {
    return NextResponse.json(await acknowledgeClientReport(user.id, user.actor.id, seen));
  } catch (err) {
    if (err instanceof ClientReportChangedError) {
      return NextResponse.json(
        { error: 'conflict', reason: err.reason, message: err.message },
        { status: 409 },
      );
    }
    throw err;
  }
}
