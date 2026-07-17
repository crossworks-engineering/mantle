/**
 * Outbound mail — SMTP submission via the account's own provider.
 *
 * We never run our own MTA / send on port 25. Instead we hand the message to
 * the user's provider on the authenticated submission port (587 STARTTLS or
 * 465 implicit TLS) using the SAME app password that's already sealed in
 * `imapConfigEnc` — most providers accept one app-password for both IMAP and
 * SMTP. The provider relays with its own reputation + SPF/DKIM, so deliverability
 * is the provider's, not a fresh VPS IP's.
 */

import nodemailer from 'nodemailer';
import type { EmailAccount } from '@mantle/db';
import { unsealImapPassword } from './providers/imap';

/** A message attachment. With a `cid` set it becomes an inline (related) part
 *  an HTML body can reference via `<img src="cid:…">`; without one it's a normal
 *  download attachment. Maps directly onto nodemailer's attachment shape. */
export type EmailAttachment = {
  /** Raw bytes (Buffer) or a string payload. */
  content: Buffer | string;
  /** Display filename; optional for inline (cid) parts. */
  filename?: string;
  /** MIME type, e.g. 'image/png'. */
  contentType?: string;
  /** Content-ID for inline embedding; the HTML references it as `cid:<value>`. */
  cid?: string;
};

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  /** Plain-text body. At least one of text/html is required. */
  text?: string;
  /** HTML body (optional). */
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  /** Reply-To override; defaults to the account address. */
  replyTo?: string;
  /** RFC Message-ID this is a reply to (sets In-Reply-To + References so it
   *  threads in the recipient's client). */
  inReplyTo?: string;
  references?: string | string[];
  /** Inline (cid) or download attachments. */
  attachments?: EmailAttachment[];
};

export type SendEmailResult = {
  messageId: string;
  accepted: string[];
  rejected: string[];
};

/** True when the account has SMTP submission configured (sending enabled). */
export function accountCanSend(account: EmailAccount): boolean {
  return Boolean(account.smtpHost && account.smtpPort && account.imapConfigEnc);
}

/**
 * Send a message via the account's SMTP submission server. Throws on missing
 * config, auth failure, or a refused recipient — callers surface the message.
 */
export async function sendEmail(
  account: EmailAccount,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!account.smtpHost || !account.smtpPort) {
    throw new Error(
      `account ${account.address} has no SMTP host/port configured — set it on the account form to enable sending`,
    );
  }
  if (!input.text && !input.html) {
    throw new Error('email must have a text or html body');
  }
  const password = unsealImapPassword(account);

  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    // true → implicit TLS (465); false → STARTTLS upgrade on a plaintext port (587).
    secure: account.smtpSecure,
    auth: { user: account.address, pass: password },
  });

  const from = account.displayName
    ? `${account.displayName} <${account.address}>`
    : account.address;

  const info = await transport.sendMail({
    from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo ?? account.address,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
  });

  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/**
 * Verify SMTP credentials/host without sending — used by the account form's
 * "test" path. Returns true on a successful handshake + auth; throws otherwise.
 */
export async function probeSmtpConnection(opts: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}): Promise<boolean> {
  const transport = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
  });
  return transport.verify();
}
