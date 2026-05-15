import { NextResponse, type NextRequest } from 'next/server';
import { db, emailAccounts } from '@mantle/db';
import { exchangeGoogleAuthCode, sealGoogleTokens } from '@mantle/email';
import { requireOwner } from '@/lib/auth';
import { accountBranchPath } from '@/lib/account-branch';

/**
 * Google OAuth callback. Exchanges the auth code for tokens via the
 * helper in @mantle/email (which also identifies the granted mailbox),
 * then upserts the email_accounts row sealed under this user. If the
 * same address is already connected, re-link replaces the old tokens.
 */
export async function GET(req: NextRequest) {
  const user = await requireOwner();
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const errorParam = url.searchParams.get('error');

  if (errorParam || !code) {
    const back = new URL('/settings/accounts', req.url);
    back.searchParams.set('error', errorParam ?? 'No code returned from Google.');
    return NextResponse.redirect(back);
  }

  try {
    const { tokens, address } = await exchangeGoogleAuthCode(code);

    if (!tokens.refresh_token) {
      // Without a refresh token we can't sync past the first hour. This
      // usually means the user has already granted Mantle access in
      // Google Account → Security and Google declined to re-issue one.
      // The fix is to revoke at https://myaccount.google.com/permissions
      // and re-connect.
      throw new Error(
        'No refresh_token returned. Revoke Mantle access at ' +
          'https://myaccount.google.com/permissions and try connecting again.',
      );
    }

    const sealed = sealGoogleTokens(tokens, { userId: user.id, address });

    await db
      .insert(emailAccounts)
      .values({
        userId: user.id,
        provider: 'gmail',
        address,
        oauthTokensEnc: sealed,
        ingestPolicy: 'approve_list',
        branchPath: accountBranchPath(address),
      })
      .onConflictDoUpdate({
        target: [emailAccounts.userId, emailAccounts.address],
        set: {
          oauthTokensEnc: sealed,
          enabled: true,
          lastSyncError: null,
          // branchPath intentionally not reset — preserves the existing
          // ltree location for already-ingested mail.
        },
      });

    const back = new URL('/settings/accounts', req.url);
    back.searchParams.set('connected', address);
    return NextResponse.redirect(back);
  } catch (err) {
    const back = new URL('/settings/accounts', req.url);
    back.searchParams.set('error', (err as Error).message);
    return NextResponse.redirect(back);
  }
}
