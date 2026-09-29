/**
 * The client sign-in sender routes' shared refusals (client logins C2b):
 * GET/PUT /api/team-admin/clients/signin-sender and its preview. Kept apart
 * from lib/client-codes.ts, which the email worker imports.
 */
import { NextResponse } from '@/server/http-compat';
import { db, emailAccounts, eq } from '@mantle/db';
import { clientSenderCandidates } from '@/lib/client-codes';

/** The sender routes' answer for an account that is not a candidate: 404
 *  account-not-found, 400 account-cannot-send; null for a candidate. */
export async function refuseNonCandidateSender(accountId: string): Promise<Response | null> {
  const candidates = await clientSenderCandidates();
  if (candidates.some((c) => c.id === accountId)) return null;
  const [exists] = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(eq(emailAccounts.id, accountId))
    .limit(1);
  return exists
    ? NextResponse.json(
        {
          error: 'That account cannot send sign-in codes (it needs IMAP and SMTP, enabled).',
          reason: 'account-cannot-send',
        },
        { status: 400 },
      )
    : NextResponse.json(
        { error: 'Email account not found.', reason: 'account-not-found' },
        { status: 404 },
      );
}

/** Why a sender whose sent folder cannot be left out is refused (409). */
export const SENT_FOLDER_REFUSALS = {
  'no-sent-folder':
    'No sent-mail folder was found in that mailbox, so its copies of the code mails could not be kept out of the brain. Choose another account.',
  'folders-unreadable':
    'The folders of that mailbox could not be listed, so its sent mail could not be kept out of the brain. Check the account and try again.',
} as const;
