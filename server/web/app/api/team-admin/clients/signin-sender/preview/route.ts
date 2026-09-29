/**
 * GET /api/team-admin/clients/signin-sender/preview?accountId=<id> ->
 * ClientSigninSenderPreview (client logins C2b; audit B4): what choosing
 * that account as the client sign-in sender would do, before the admin
 * confirms: the sent-mail folders it would leave out of mail sync, or why
 * it cannot be chosen (`canUse` false: no sent folder found, the folders
 * cannot be listed, or the account cannot send). Lists the mailbox's
 * folders (an IMAP round trip); writes nothing. 404 for an unknown account,
 * 400 for a malformed id.
 *
 * Admin only: getOwnerOr401 refuses members and clients.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { planSentFolders } from '@mantle/email';
import { resolveSingleOwnerId } from '@mantle/db';
import type { ClientSigninSenderPreview } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { refuseNonCandidateSender } from '@/lib/client-sender';

const Id = z.string().uuid();

export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Id.safeParse(new URL(req.url).searchParams.get('accountId'));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Choose an email account.' }, { status: 400 });
  }
  const accountId = parsed.data;
  const refused = await refuseNonCandidateSender(accountId);
  if (refused) {
    if (refused.status === 404) return refused;
    const body: ClientSigninSenderPreview = {
      sentFolders: [],
      canUse: false,
      reason: 'account-cannot-send',
    };
    return NextResponse.json(body);
  }
  const brain = (await resolveSingleOwnerId()) ?? user.id;
  const plan = await planSentFolders(brain, accountId);
  if (!plan.ok && plan.reason === 'account-not-found') {
    return NextResponse.json(
      { error: 'Email account not found.', reason: 'account-not-found' },
      { status: 404 },
    );
  }
  const body: ClientSigninSenderPreview = plan.ok
    ? { sentFolders: plan.sentFolders, canUse: true }
    : { sentFolders: [], canUse: false, reason: plan.reason as 'no-sent-folder' | 'folders-unreadable' };
  return NextResponse.json(body);
}
