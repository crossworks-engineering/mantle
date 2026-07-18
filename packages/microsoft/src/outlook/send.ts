/**
 * Outbound mail via Microsoft Graph — `POST /me/sendMail`.
 *
 * The SMTP path (packages/email/src/send.ts) needs an app password; OAuth
 * accounts don't have one, and tenants routinely disable SMTP AUTH anyway, so
 * Graph's first-class send action is the right transport. The message lands in
 * the account's Sent Items (`saveToSentItems: true`), relayed under the
 * provider's reputation exactly like SMTP submission.
 *
 * Requires the `Mail.Send` delegated scope. Accounts connected before that
 * scope joined `MS_SCOPES` don't have it — gate on `msAccountCanSend` and ask
 * the user to reconnect rather than letting Graph 403.
 *
 * Not supported here: `inReplyTo`/`references` threading headers — Graph only
 * accepts custom `internetMessageHeaders` prefixed `x-`, so RFC threading
 * headers can't be set on sendMail. No current caller passes them (there is no
 * reply tool); a future reply feature should use Graph's `createReply` on the
 * original message instead.
 */
import type { EmailAccount } from '@mantle/db';
import type { SendEmailInput, SendEmailResult } from '@mantle/email';
import { MAIL_SEND_SCOPE } from '../config';
import { graphPost } from '../client';

/** Graph caps the plain `sendMail` request around 4 MB; leave headroom for the
 *  ~4/3 base64 inflation + JSON envelope. Bigger mail needs upload sessions —
 *  not worth it until something real hits this. */
const MAX_ATTACHMENT_BYTES = 2_500_000;

/** True when the *granted* scopes (ms_accounts.scopes) allow sending. */
export function msAccountCanSend(scopes: string[]): boolean {
  return scopes.includes(MAIL_SEND_SCOPE);
}

interface GraphRecipientOut {
  emailAddress: { address: string };
}

function recipients(value: string | string[] | undefined): GraphRecipientOut[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

/**
 * Send from a `provider='microsoft'` companion account via Graph. Mirrors the
 * SMTP `sendEmail` contract; throws on missing link, oversized attachments, or
 * a Graph error (401 → the account needs reconnect). Graph replies 202 with no
 * body, so there's no provider message id to return — `messageId` is empty and
 * `accepted` optimistically lists every recipient (Graph reports later
 * delivery failures as bounce mail, like any provider).
 */
export async function sendViaGraph(
  account: EmailAccount,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  if (!account.msAccountId) {
    throw new Error(
      `email account ${account.address} (provider=microsoft) is missing ms_account_id`,
    );
  }
  if (!input.text && !input.html) {
    throw new Error('email must have a text or html body');
  }

  const attachments = (input.attachments ?? []).map((a) => {
    const buf = typeof a.content === 'string' ? Buffer.from(a.content) : a.content;
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename ?? (a.cid ? `${a.cid}` : 'attachment'),
      contentType: a.contentType,
      contentBytes: buf.toString('base64'),
      ...(a.cid ? { isInline: true, contentId: a.cid } : {}),
      _bytes: buf.length,
    };
  });
  const totalBytes = attachments.reduce((n, a) => n + a._bytes, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `attachments total ${Math.round(totalBytes / 1024)} KB — over the ${Math.round(
        MAX_ATTACHMENT_BYTES / 1024,
      )} KB Graph sendMail limit`,
    );
  }

  const toRecipients = recipients(input.to);
  const ccRecipients = recipients(input.cc);
  const bccRecipients = recipients(input.bcc);

  await graphPost(account.userId, account.msAccountId, '/me/sendMail', {
    saveToSentItems: true,
    message: {
      subject: input.subject,
      body: input.html
        ? { contentType: 'HTML', content: input.html }
        : { contentType: 'Text', content: input.text },
      toRecipients,
      ...(ccRecipients.length ? { ccRecipients } : {}),
      ...(bccRecipients.length ? { bccRecipients } : {}),
      replyTo: recipients(input.replyTo ?? account.address),
      ...(attachments.length
        ? { attachments: attachments.map(({ _bytes, ...rest }) => rest) }
        : {}),
    },
  });

  return {
    messageId: '',
    accepted: [...toRecipients, ...ccRecipients, ...bccRecipients].map(
      (r) => r.emailAddress.address,
    ),
    rejected: [],
  };
}
