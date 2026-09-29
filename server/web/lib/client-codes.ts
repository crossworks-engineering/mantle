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
import { and, eq, sql } from 'drizzle-orm';
import { db, emailAccounts, resolveSingleOwnerId, type EmailAccount } from '@mantle/db';
import { env } from '@mantle/config';
import { CLIENT_CODE_HEADER, accountCanSend, clientCodeMessageId, sendEmail } from '@mantle/email';
import {
  createClientEmailCode,
  loadPreferencesFor,
  markClientEmailCodeSent,
  revokeClientEmailCode,
  type ClientCodeRequest,
  type ClientCodeSkipReason,
} from '@mantle/content';
import type { ClientSigninSenderCandidate } from '@mantle/client-types';
import { errorMessage } from '@mantle/std';

/** Queue name: the email-sync worker works it. */
export const CLIENT_CODE_QUEUE = 'mantle.client.code';

/**
 * The queue's options. A job carries an email and an address, so it is
 * kept briefly: a request not worked within an hour is dropped (the worker
 * drops one older than 10 minutes anyway), and a finished job is deleted
 * after a day (pg-boss keeps them 7 to 14 days by default). One retry, and
 * a job may run 10 minutes.
 */
export const CLIENT_CODE_QUEUE_OPTIONS = {
  retryLimit: 1,
  expireInSeconds: 600,
  retentionSeconds: 60 * 60,
  deleteAfterSeconds: 24 * 60 * 60,
} as const;

/** Create the queue, and put its options on a queue an older release made
 *  (createQueue leaves an existing queue as it was). */
export async function ensureClientCodeQueue(b: PgBoss): Promise<void> {
  await b.createQueue(CLIENT_CODE_QUEUE, CLIENT_CODE_QUEUE_OPTIONS);
  await b.updateQueue(CLIENT_CODE_QUEUE, CLIENT_CODE_QUEUE_OPTIONS);
}

let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL must be set to queue a sign-in code');
  const b = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await b.start();
  await ensureClientCodeQueue(b);
  _boss = b;
  return b;
}

/** Stop the queue client this module started (tests). */
export async function closeClientCodeQueue(): Promise<void> {
  const b = _boss;
  _boss = undefined;
  await b?.stop({ graceful: false, timeout: 5000 });
}

/** Queue one code request. The job carries the email and the request id,
 *  never a code. Throws when the queue is down (the route still answers 200). */
export async function enqueueClientCode(job: ClientCodeRequest): Promise<void> {
  const b = await boss();
  await b.send(CLIENT_CODE_QUEUE, job, CLIENT_CODE_QUEUE_OPTIONS);
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

/** How recently the email worker must have finished a job to count as up:
 *  its scheduler job runs every 2 minutes. */
const EMAIL_WORKER_WINDOW = '10 minutes';

/**
 * Whether an email worker serves the code queue on this box: it finished
 * (or is running) a job of its 2-minute mail scheduler, or a code job,
 * within the last 10 minutes. A box whose compose shape leaves the email
 * worker out (the brain core) never runs either, so codes are off there
 * whatever the sender. False when the queue tables cannot be read.
 */
export async function emailWorkerServesCodes(): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      select exists (
        select 1 from pgboss.job
         where name in ('mantle.email.scheduler', ${CLIENT_CODE_QUEUE})
           and ((state = 'completed' and completed_on > now() - ${EMAIL_WORKER_WINDOW}::interval)
             or (state = 'active' and started_on > now() - ${EMAIL_WORKER_WINDOW}::interval))
      ) as ok`)) as unknown as { ok: boolean }[];
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
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

export type ClientCodeJobDeps = { send?: typeof sendEmail; now?: Date };

/**
 * Run one queued request (the email-sync worker). No sender: nothing
 * happens. Everything that can fail before the mail (the sender, the brain
 * anchor, the site name) is read BEFORE a code is stored; then
 * createClientEmailCode decides; on send, the code is mailed from the
 * sender with the marker Message-ID the mail sync skips, and the outcome is
 * recorded (sent, or revoked with the reason). Anything that throws after
 * the code was stored revokes it, so a retried job never finds a code no
 * mail carried. A failed mail is not retried (a retry would only find the
 * request done). `send` is injectable for tests.
 */
export async function runClientCodeJob(
  job: ClientCodeRequest,
  deps: ClientCodeJobDeps = {},
): Promise<ClientCodeJobOutcome> {
  const sender = await loadClientSigninSender();
  if (!sender) return { kind: 'skipped', reason: 'no-sender' };
  const anchor = await resolveSingleOwnerId();
  const siteName = anchor ? ((await loadPreferencesFor(anchor)).siteName ?? null) : null;

  const decision = await createClientEmailCode(job, deps.now ?? new Date(), { ownerId: anchor });
  if (decision.kind === 'skip') return { kind: 'skipped', reason: decision.reason };
  try {
    const mail = clientCodeMail({ siteName, code: decision.code });
    await (deps.send ?? sendEmail)(sender, {
      to: decision.email,
      subject: mail.subject,
      text: mail.text,
      messageId: clientCodeMessageId(sender.address),
      headers: { [CLIENT_CODE_HEADER]: '1' },
    });
  } catch (err) {
    await revokeClientEmailCode(decision.codeId, new Date(), errorMessage(err)).catch((e) =>
      console.error('[client-code] revoke after a failed send failed:', errorMessage(e)),
    );
    console.error('[client-code] send failed:', errorMessage(err));
    return { kind: 'failed' };
  }
  // The mail went out: a failure to record it must not revoke the code.
  await markClientEmailCodeSent(decision.codeId).catch((e) =>
    console.error('[client-code] could not record the send:', errorMessage(e)),
  );
  return { kind: 'sent' };
}

/**
 * Work the code queue on `b` (the email-sync worker, and the queue test).
 * The log names the outcome only, never the email or the code.
 */
export async function workClientCodeQueue(
  b: PgBoss,
  deps: ClientCodeJobDeps = {},
): Promise<string> {
  await ensureClientCodeQueue(b);
  return b.work<ClientCodeRequest>(CLIENT_CODE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const outcome = await runClientCodeJob(job.data, deps);
      console.log(
        `[client-code] ${outcome.kind}${outcome.kind === 'skipped' ? ` (${outcome.reason})` : ''}`,
      );
    }
  });
}
