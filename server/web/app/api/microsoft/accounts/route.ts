import { NextResponse } from '@/server/http-compat';
import { listAccounts, redactMsAccount } from '@mantle/microsoft';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
});

/** Connected Microsoft 365 accounts for the owner. Sealed OAuth tokens are
 *  replaced with presence flags (`hasAccessToken`/`hasRefreshToken`) before the
 *  rows leave the process. */
export async function GET() {
  const user = ownerCaller();
  const accounts = await listAccounts(user.id);
  return NextResponse.json({ accounts: accounts.map(redactMsAccount) });
}
