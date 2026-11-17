import { NextResponse } from '@/server/http-compat';
import { latestSyncRuns, listAccounts, redactAccount } from '@mantle/email';
import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
});

/** List the owner's email accounts plus the latest sync run per account, for
 *  the Email reader's account list. The sealed IMAP credential is stripped
 *  before it leaves the process. Linking an account is gone from the brain:
 *  mail sync is rebuilt in the Sync service (docs/services.md, "Sync"). */
export async function GET() {
  const user = ownerCaller();
  const [accounts, runs] = await Promise.all([listAccounts(user.id), latestSyncRuns(user.id)]);
  return NextResponse.json({
    accounts: accounts.map(redactAccount),
    latestRuns: Object.fromEntries(runs),
  });
}
