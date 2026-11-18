/**
 * Send for the Sync sidecar (Sync service plan M2; docs/email-send.md): SMTP
 * submission through the mailbox's own provider (587 STARTTLS or 465 TLS),
 * with the mailbox's app password. We never run an MTA: the provider relays
 * with its own reputation, SPF and DKIM.
 *
 * The brain checks first (POST /send comes only from it, with the token): the
 * box's send policy, the recipients against the contacts allowlist, and what
 * a page renders to. This module only sends.
 */
import nodemailer from 'nodemailer';
import { checkedAddress } from './net';
import type { HostPort, MailAccount } from './state';

export type SendInput = {
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

export type SendResult = { from: string; messageId: string; accepted: string[]; rejected: string[] };

/** A refusal the person can act on (its text is shown). */
export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendRefusedError';
  }
}

/** The mailbox to send from: the one at `from` (it must send), else the
 *  first enabled one that sends. */
export function senderFor(accounts: MailAccount[], from?: string): MailAccount {
  const sending = accounts.filter((a) => a.enabled && a.smtp);
  if (from) {
    const match = sending.find((a) => a.address.toLowerCase() === from.trim().toLowerCase());
    if (match) return match;
    throw new SendRefusedError(
      `No linked mailbox can send from ${from}. Link it, with its SMTP settings, in Settings > Sync.`,
    );
  }
  const first = sending[0];
  if (!first) {
    throw new SendRefusedError(
      'No linked mailbox can send. Add the SMTP settings to a mailbox in Settings > Sync.',
    );
  }
  return first;
}

async function transportFor(smtp: HostPort, user: string, pass: string) {
  const address = await checkedAddress(smtp.host);
  return nodemailer.createTransport({
    host: address,
    port: smtp.port,
    // true: implicit TLS (465); false: STARTTLS on a plain port (587).
    secure: smtp.secure,
    tls: { servername: smtp.host },
    auth: { user, pass },
  });
}

export async function sendMail(account: MailAccount, input: SendInput): Promise<SendResult> {
  if (!account.smtp) throw new SendRefusedError('This mailbox has no SMTP settings.');
  if (!input.text && !input.html) throw new SendRefusedError('A message needs a text or HTML body.');
  const transport = await transportFor(account.smtp, account.address, account.password);
  const from = account.displayName ? `${account.displayName} <${account.address}>` : account.address;
  const info = await transport.sendMail({
    from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: account.address,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      cid: a.cid,
      content: Buffer.from(a.contentB64, 'base64'),
    })),
  });
  return {
    from: account.address,
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map(String),
    rejected: (info.rejected ?? []).map(String),
  };
}

/** Log in to SMTP without sending: the check on save. */
export async function probeSmtp(smtp: HostPort, user: string, pass: string): Promise<void> {
  const transport = await transportFor(smtp, user, pass);
  await transport.verify();
}
