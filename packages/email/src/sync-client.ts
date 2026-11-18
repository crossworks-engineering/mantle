/**
 * The brain's calls to the Sync sidecar (Sync service plan M2;
 * docs/services.md "Sync"): send a message, and backfill a new contact's
 * recent mail. The sidecar listens at SYNC_URL on the stack's network and
 * takes SYNC_TOKEN in `x-mantle-sync-token`.
 *
 * While Sync is off a backfill is skipped (no mailbox syncs) and a send is
 * refused with SyncOffError (the tool says so).
 */
import {
  EMAIL_SEND_POLICY_OFF_MESSAGE,
  emailSendAllowed,
  env,
  serviceEnabled,
} from '@mantle/config';
import { NET_TIMEOUTS, defineDomainError, errorMessage, timeoutSignal } from '@mantle/std';

const TOKEN_HEADER = 'x-mantle-sync-token';

/** Sync is off on this box, or not wired (no token). */
export class SyncOffError extends Error {
  readonly code = 'sync_off';
  constructor() {
    super('Sync is turned off on this box. An admin can turn it on in Settings > Services.');
    this.name = 'SyncOffError';
  }
}
defineDomainError(SyncOffError, {
  reason: 'the optional Sync service is off; the message names where to turn it on',
  status: 409,
  body: (e) => ({ error: e.message, code: e.code }),
});

/** The sidecar answered a send with an error of its own (the SMTP server's
 *  refusal, a missing account). Its text is the sidecar's fixed message. */
export class SyncSendError extends Error {
  readonly code = 'sync_send_failed';
  constructor(message: string) {
    super(message);
    this.name = 'SyncSendError';
  }
}
defineDomainError(SyncSendError, {
  reason: 'the mail server refused the message; the text is the sidecar fixed summary',
  status: 502,
  body: (e) => ({ error: e.message, code: e.code }),
});

/** The sidecar refused an admin call with a text for the person (a bad
 *  field, an account it does not hold, a failed sign-in or login), or
 *  Microsoft answered with an error. The text is the sidecar's own. */
export class SyncAdminError extends Error {
  readonly code = 'sync_admin_refused';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SyncAdminError';
  }
}
defineDomainError(SyncAdminError, {
  reason: "the Sync sidecar refused an account action; the text is the sidecar's fixed summary",
  status: (e) => (e.status === 400 ? 400 : 502),
  body: (e) => ({ error: e.message, code: e.code }),
});

/** The code every email sending refusal carries (docs/policy.md). */
export const EMAIL_SEND_POLICY_OFF_CODE = 'policy_email_send_off';

/** The box policy switches email sending off (MANTLE_POLICY_EMAIL_SEND=off,
 *  docs/policy.md): no Mantle path sends while it is. */
export class EmailSendPolicyOffError extends Error {
  readonly code = EMAIL_SEND_POLICY_OFF_CODE;
  constructor() {
    super(EMAIL_SEND_POLICY_OFF_MESSAGE);
    this.name = 'EmailSendPolicyOffError';
  }
}
defineDomainError(EmailSendPolicyOffError, {
  reason: "the box policy switches email sending off (the operator's .env); the message names it",
  status: 403,
  body: (e) => ({ error: e.message, code: e.code }),
});

function wiring(): { url: string; token: string } | null {
  if (!serviceEnabled('sync')) return null;
  const token = env('SYNC_TOKEN');
  if (!token) return null;
  const url = (env('SYNC_URL') ?? 'http://sync:8099').replace(/\/+$/, '');
  return { url, token };
}

async function call(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  const w = wiring();
  if (!w) throw new SyncOffError();
  return fetch(`${w.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: w.token },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: timeoutSignal(timeoutMs),
  });
}

/** One admin call to the sidecar (/admin/*, /oauth/*; Sync service plan M3):
 *  its JSON answer. Throws SyncOffError, SyncAdminError. */
export async function syncAdmin<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await call(path, body, NET_TIMEOUTS.syncAdmin);
  const answer = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !answer) {
    throw new SyncAdminError(
      answer?.error ?? `the Sync service answered ${res.status}`,
      res.status,
    );
  }
  return answer;
}

/** A message for the sidecar to send from one of the owner's mailboxes. */
export type SyncSendInput = {
  /** Which of the owner's linked addresses sends it; none: the first linked
   *  mailbox that can send (the sidecar picks). */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: { filename?: string; contentType?: string; cid?: string; contentB64: string }[];
};

export type SyncSendResult = {
  /** The address it went out from. */
  from: string;
  messageId: string;
  accepted: string[];
  rejected: string[];
};

/** Send through the sidecar: the one send path of MantleOS's own mail.
 *  Throws EmailSendPolicyOffError, SyncOffError, SyncSendError. */
export async function sendViaSync(input: SyncSendInput): Promise<SyncSendResult> {
  if (!emailSendAllowed()) throw new EmailSendPolicyOffError();
  const res = await call('/send', input, NET_TIMEOUTS.syncSend);
  const body = (await res.json().catch(() => null)) as (SyncSendResult & { error?: string }) | null;
  if (!res.ok || !body || body.error) {
    throw new SyncSendError(body?.error ?? `the Sync service answered ${res.status}`);
  }
  return {
    from: body.from,
    messageId: body.messageId,
    accepted: body.accepted,
    rejected: body.rejected,
  };
}

/**
 * Pull each new contact entry's last 90 days of mail into the brain (an
 * address, or an `@domain` wildcard), across the owner's mailboxes. Best
 * effort and in the background on the sidecar: never fails the caller's
 * write, and does nothing while Sync is off.
 */
export async function enqueueBackfills(_ownerId: string, targets: string[]): Promise<void> {
  if (targets.length === 0 || !wiring()) return;
  try {
    const res = await call('/backfill', { targets }, NET_TIMEOUTS.syncBackfill);
    if (!res.ok) console.warn(`[sync] backfill not started: the sidecar answered ${res.status}`);
  } catch (err) {
    console.warn(`[sync] backfill not started: ${errorMessage(err)}`);
  }
}
