/**
 * Connected Microsoft 365 accounts — owner-scoped listing for the settings
 * surface (and `GET /api/microsoft/accounts`). The full row carries sealed
 * OAuth tokens; `redactMsAccount` strips them (keeping only presence flags)
 * before an account can cross the HTTP boundary.
 */
import { asc, eq } from 'drizzle-orm';
import { db, msAccounts, type MsAccount } from '@mantle/db';

/** Every connected MS account for the owner, ordered by UPN. */
export function listAccounts(userId: string): Promise<MsAccount[]> {
  return db
    .select()
    .from(msAccounts)
    .where(eq(msAccounts.userId, userId))
    .orderBy(asc(msAccounts.upn));
}

/** An MS account with sealed tokens replaced by presence flags — HTTP-safe. */
export type PublicMsAccount = Omit<MsAccount, 'accessTokenEnc' | 'refreshTokenEnc'> & {
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
};

/** Strip the sealed OAuth tokens before an account row leaves the process. */
export function redactMsAccount(account: MsAccount): PublicMsAccount {
  const { accessTokenEnc, refreshTokenEnc, ...rest } = account;
  return { ...rest, hasAccessToken: !!accessTokenEnc, hasRefreshToken: !!refreshTokenEnc };
}
