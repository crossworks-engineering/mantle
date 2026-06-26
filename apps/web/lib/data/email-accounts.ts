/**
 * Data module for the email-accounts settings screen — the first adopter of the
 * remote-data seam (the DB-less-dev pattern). In normal dev/prod it calls the
 * `@mantle/email` package in-process; under `MANTLE_REMOTE_API` it fetches the
 * same shape from a deployed Mantle's `/api/email/accounts`. Either way the page
 * gets one typed `AccountsView` and never touches `@mantle/db`.
 *
 * This is the template every screen follows as we make the frontend DB-less:
 * keep the page dumb, branch once here on `isRemoteData()`.
 */
import {
  latestSyncRuns,
  listAccounts,
  redactAccount,
  type PublicEmailAccount,
  type SyncRun,
} from '@mantle/email';
import { isRemoteData, remoteGet } from '@/lib/remote-data';

export interface AccountsView {
  accounts: PublicEmailAccount[];
  /** accountId → latest sync run. (Over the remote path, run dates arrive as ISO
   *  strings; the screen only reads non-date fields, and formatDateTime accepts
   *  both, so this is rendered identically either way.) */
  latestRuns: Map<string, SyncRun>;
}

export async function loadAccountsView(userId: string): Promise<AccountsView> {
  if (isRemoteData()) {
    const data = await remoteGet<{
      accounts: PublicEmailAccount[];
      latestRuns: Record<string, SyncRun>;
    }>('/api/email/accounts');
    return { accounts: data.accounts, latestRuns: new Map(Object.entries(data.latestRuns)) };
  }
  const [accounts, latestRuns] = await Promise.all([listAccounts(userId), latestSyncRuns(userId)]);
  return { accounts: accounts.map(redactAccount), latestRuns };
}
