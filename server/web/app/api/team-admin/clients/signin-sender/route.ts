/**
 * The client sign-in sender (client logins C2b): the email account client
 * sign-in codes are mailed from. Codes are off until an admin picks one.
 *
 * GET /api/team-admin/clients/signin-sender -> ClientSigninSender: the
 *     sender, the accounts that can be picked (the brain's own IMAP/SMTP
 *     accounts that can send), the sent-mail folders left out of its sync,
 *     and the daily count against the brain-wide cap (`capReached` is the
 *     admin's banner: requests still answer 200, nothing is sent).
 * PUT { accountId: string | null } -> the same, after the change. Picking a
 *     sender leaves its sent-mail folders out of mail sync (the second guard;
 *     the code mails also carry a Message-ID marker the sync skips anywhere).
 *     404 account-not-found, 400 account-cannot-send.
 *
 * Admin only: getOwnerOr401 refuses members and clients. Self-audited
 * (the path is under /api/team-admin/clients).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { CLIENT_CODE_DAILY_CAP, clientCodesSentLast24h, savePreferencesFor } from '@mantle/content';
import { excludeSentFolders, sentFolderNames } from '@mantle/email';
import { db, emailAccounts, eq, resolveSingleOwnerId } from '@mantle/db';
import type { ClientSigninSender } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  clientSenderCandidates,
  loadClientSigninSender,
  senderCandidateOf,
} from '@/lib/client-codes';

async function current(): Promise<ClientSigninSender> {
  const [sender, candidates, sentLast24h] = await Promise.all([
    loadClientSigninSender(),
    clientSenderCandidates(),
    clientCodesSentLast24h(),
  ]);
  return {
    sender: sender ? senderCandidateOf(sender) : null,
    candidates: candidates.map(senderCandidateOf),
    sentFoldersExcluded: sender ? sentFolderNames(sender.imapExcludedFolders) : [],
    dailyCap: CLIENT_CODE_DAILY_CAP,
    sentLast24h,
    capReached: sentLast24h >= CLIENT_CODE_DAILY_CAP,
  };
}

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json(await current());
}

const Body = z.object({ accountId: z.string().uuid().nullable() });

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Choose an email account, or none.' }, { status: 400 });
  }
  const { accountId } = parsed.data;
  if (accountId) {
    const candidates = await clientSenderCandidates();
    if (!candidates.some((c) => c.id === accountId)) {
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
    // Best effort: the Message-ID marker is what keeps codes out for sure.
    const brain = (await resolveSingleOwnerId()) ?? user.id;
    const excluded = await excludeSentFolders(brain, accountId);
    if (!excluded.ok) console.warn('[client-code] could not list sender folders:', excluded.error);
  }
  await savePreferencesFor(user.id, { clientSigninSenderId: accountId ?? '' });
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'client.signin_sender_set',
    method: 'PUT',
    path: '/api/team-admin/clients/signin-sender',
    detail: { accountId },
    ...requestMetaFrom(req),
  });
  return NextResponse.json(await current());
}
