/**
 * The client sign-in sender (client logins C2b): the email account client
 * sign-in codes are mailed from. Codes are off until an admin picks one.
 *
 * GET /api/team-admin/clients/signin-sender -> ClientSigninSender: the
 *     sender, the accounts that can be picked (the brain's own IMAP/SMTP
 *     accounts that can send), the sent-mail folders left out of its sync,
 *     the daily count against the brain-wide cap (`capReached` is the
 *     admin's banner: requests still answer 200, nothing is sent), what
 *     became of the code mails of the last 24 hours (delivered, failed, the
 *     newest failure), the requests skipped at a cap, and whether an email
 *     worker serves the code queue on this box (`emailWorker` false: codes
 *     are off whatever the sender).
 * PUT { accountId: string | null } -> the same, after the change. Picking a
 *     sender leaves its sent-mail folders out of mail sync (the second guard;
 *     the code mails also carry a Message-ID marker and a header the sync
 *     skips anywhere) and remembers exactly which folders it added; choosing
 *     another sender or None puts them back. Refused, with nothing saved:
 *     404 account-not-found, 400 account-cannot-send, 409 no-sent-folder
 *     (no sent folder found) or folders-unreadable (the folders cannot be
 *     listed). GET .../preview?accountId= says the same before the choice.
 *
 * Admin only: getOwnerOr401 refuses members and clients. Self-audited
 * (the path is under /api/team-admin/clients).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { CLIENT_CODE_DAILY_CAP, clientCodeStats, savePreferencesFor } from '@mantle/content';
import {
  excludeSentFolders,
  heldSentFolders,
  restoreSentFolders,
  sentFolderNames,
} from '@mantle/email';
import { resolveSingleOwnerId } from '@mantle/db';
import type { ClientSigninSender } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';
import { auditFireAndForget, requestMetaFrom } from '@/lib/audit';
import {
  clientSenderCandidates,
  emailWorkerServesCodes,
  loadClientSigninSender,
  senderCandidateOf,
} from '@/lib/client-codes';
import { SENT_FOLDER_REFUSALS, refuseNonCandidateSender } from '@/lib/client-sender';

async function current(): Promise<ClientSigninSender> {
  const [sender, candidates, stats, emailWorker] = await Promise.all([
    loadClientSigninSender(),
    clientSenderCandidates(),
    clientCodeStats(),
    emailWorkerServesCodes(),
  ]);
  const held = sender ? await heldSentFolders(sender.id) : [];
  const excluded = sender?.imapExcludedFolders ?? [];
  const sentFoldersExcluded = sender
    ? [...new Set([...held.filter((f) => excluded.includes(f)), ...sentFolderNames(excluded)])]
    : [];
  return {
    sender: sender ? senderCandidateOf(sender) : null,
    candidates: candidates.map(senderCandidateOf),
    sentFoldersExcluded,
    dailyCap: CLIENT_CODE_DAILY_CAP,
    // The cap counts every stored code, failed ones too; "sent" is what
    // the mail server took.
    sentLast24h: stats.delivered,
    capReached: stats.created >= CLIENT_CODE_DAILY_CAP,
    deliveredLast24h: stats.delivered,
    failedLast24h: stats.failed,
    lastFailure: stats.lastFailure
      ? { at: stats.lastFailure.at.toISOString(), reason: stats.lastFailure.reason }
      : null,
    emailWorker,
    capSkipsLast24h: stats.capSkips,
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
  const brain = (await resolveSingleOwnerId()) ?? user.id;
  let added: string[] = [];
  if (accountId) {
    const refused = await refuseNonCandidateSender(accountId);
    if (refused) return refused;
    const excluded = await excludeSentFolders(brain, accountId);
    if (!excluded.ok) {
      if (excluded.reason === 'account-not-found') {
        return NextResponse.json(
          { error: 'Email account not found.', reason: 'account-not-found' },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: SENT_FOLDER_REFUSALS[excluded.reason], reason: excluded.reason },
        { status: 409 },
      );
    }
    added = excluded.added;
  }
  await savePreferencesFor(user.id, { clientSigninSenderId: accountId ?? '' });
  // The folders an earlier choice left out come back (the new sender's stay).
  const restored = await restoreSentFolders(brain, accountId);
  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'client.signin_sender_set',
    method: 'PUT',
    path: '/api/team-admin/clients/signin-sender',
    detail: { accountId, foldersExcluded: added, foldersRestored: restored },
    ...requestMetaFrom(req),
  });
  return NextResponse.json(await current());
}
