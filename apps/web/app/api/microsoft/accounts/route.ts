import { NextResponse } from 'next/server';
import { listAccounts, redactMsAccount } from '@mantle/microsoft';
import { getOwnerOr401 } from '@/lib/auth';

/** Connected Microsoft 365 accounts for the owner. Sealed OAuth tokens are
 *  replaced with presence flags (`hasAccessToken`/`hasRefreshToken`) before the
 *  rows leave the process. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const accounts = await listAccounts(user.id);
  return NextResponse.json({ accounts: accounts.map(redactMsAccount) });
}
