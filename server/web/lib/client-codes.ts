/**
 * Email sign-in codes for client logins (client logins C2b), the web side:
 * the sender setting, the queue the sign-in route publishes to, and the job
 * the email-sync worker runs (server/web/workers/email-sync.ts). The code
 * logic itself is packages/content/src/client-codes.ts.
 *
 * Why a queue: POST /api/auth/client-code must answer the same way, in the
 * same time, for every email. It only enqueues; the lookup, the caps, the
 * code and the mail happen here, after the answer, so neither the response
 * nor its timing tells whether an email is a client. The mail is a plain
 * SMTP send from the chosen account: no agent, no LLM, no contact gate.
 */
import { PgBoss } from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, resolveSingleOwnerId, type EmailAccount } from '@mantle/db';
import { env } from '@mantle/config';
import {
  CLIENT_CODE_HEADER,
  accountCanSend,
  clientCodeMessageId,
  sendEmail,
} from '@mantle/email';
import {
  createClientEmailCode,
  loadPreferencesFor,
  revokeClientEmailCode,
  type ClientCodeRequest,
  type ClientCodeSkipReason,
} from '@mantle/content';
import type { ClientSigninSenderCandidate } from '@mantle/client-types';
import { errorMessage } from '@mantle/std';

/** Queue name: the email-sync worker works it. */
export const CLIENT_CODE_QUEUE = 'mantle.client.code';

let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set to queue a sign-in code');
  const b = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await b.start();
  await b.createQueue(CLIENT_CODE_QUEUE);
  _boss = b;
  return b;
}

/** Queue one code request. The job carries the email and the request id,
 *  never a code. Throws when the queue is down (the route still answers 200). */
export async function enqueueClientCode(job: ClientCodeRequest): Promise<void> {
  const b = await boss();
  await b.send(CLIENT_CODE_QUEUE, job, { retryLimit: 1, expireInSeconds: 600 });
}

/** An account codes can go out from: enabled, IMAP/SMTP (the Message-ID
 *  marker is honoured by the IMAP sync), with SMTP set up. */
function canSendCodes(a: EmailAccount): boolean {
  return a.enabled && a.provider === 'imap' && accountCanSend(a);
}

/** The accounts an admin can pick as the sign-in sender: the brain's own. */
export async function clientSenderCandidates(): Promise<EmailAccount[]> {
  const anchor = await resolveSingleOwnerId();
  if (!anchor) return [];
  const rows = await db.select().from(emailAccounts).where(eq(emailAccounts.userId, anchor));
  return rows.filter(canSendCodes);
}

export function senderCandidateOf(a: EmailAccount): ClientSigninSenderCandidate {
  return { id: a.id, address: a.address };
}

/** The chosen sign-in sender, when it can still send; else null (codes off). */
export async function loadClientSigninSender(): Promise<EmailAccount | null> {
  const anchor = await resolveSingleOwnerId();
  if (!anchor) return null;
  const id = (await loadPreferencesFor(anchor)).clientSigninSenderId;
  if (!id) return null;
  const [row] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, id), eq(emailAccounts.userId, anchor)))
    .limit(1);
  return row && canSendCodes(row) ? row : null;
}

/** The mail a client gets. Plain text; the code on a line of its own. */
export function clientCodeMail(opts: { siteName: string | null; code: string }): {
  subject: string;
  text: string;
} {
  const brain = opts.siteName?.trim() || 'your workspace';
  return {
    subject: `Your sign-in code for ${brain}`,
    text: [
      `Your sign-in code for ${brain} is:`,
      '',
      `    ${opts.code}`,
      '',
      'It works once, for 10 minutes, in the browser where you asked for it.',
      'If you did not ask for a code, you can ignore this mail.',
    ].join('\n'),
  };
}

export type ClientCodeJobOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: ClientCodeSkipReason | 'no-sender' }
  | { kind: 'failed' };

/**
 * Run one queued request (the email-sync worker). No sender: nothing
 * happens. Otherwise createClientEmailCode decides; on send, the code is
 * mailed from the sender with the marker Message-ID the mail sync skips.
 * A failed mail revokes the code and is not retried (a retry would only
 * find the request done). `send` is injectable for tests.
 */
export async function runClientCodeJob(
  job: ClientCodeRequest,
  deps: { send?: typeof sendEmail; now?: Date } = {},
): Promise<ClientCodeJobOutcome> {
  const sender = await loadClientSigninSender();
  if (!sender) return { kind: 'skipped', reason: 'no-sender' };
  const decision = await createClientEmailCode(job, deps.now ?? new Date());
  if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason };
  const anchor = await resolveSingleOwnerId();
  const siteName = anchor ? ((await loadPreferencesFor(anchor)).siteName ?? null) : null;
  const mail = clientCodeMail({ siteName, code: decision.code });
  try {
    await (deps.send ?? sendEmail)(sender, {
      to: decision.email,
      subject: mail.subject,
      text: mail.text,
      messageId: clientCodeMessageId(sender.address),
      headers: { [CLIENT_CODE_HEADER]: '1' },
    });
    return { kind: 'sent' };
  } catch (err) {
    await revokeClientEmailCode(decision.codeId);
    console.error('[client-code] send failed:', errorMessage(err));
    return { kind: 'failed' };
  }
}
