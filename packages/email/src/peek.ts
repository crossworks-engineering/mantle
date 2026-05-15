import type { EmailAccount } from '@mantle/db';
import type { EmailProvider, RawMessage } from './types';

/**
 * Live-preview the latest message from one sender.
 *
 * Used by the senders curation page so users can decide approve/deny on
 * pending senders without us having stored anything in the DB. Everything
 * here is read-through to the IMAP server; nothing is persisted.
 *
 * Scope: searches the last 12 months across all non-excluded folders for
 * the sender, picks the message with the most recent internalDate, and
 * does one `fetchFull` to retrieve the body + attachment metadata.
 */
export interface SenderPreview {
  fromAddr: string;
  fromName?: string;
  subject?: string;
  internalDate: Date;
  folder?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: Array<{ filename: string; mimeType?: string; sizeBytes?: number }>;
}

export async function peekLatestFromSender(
  account: EmailAccount,
  provider: EmailProvider,
  senderAddress: string,
): Promise<SenderPreview | null> {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);

  let latest: RawMessage | undefined;
  for await (const message of provider.listFromSender(account, senderAddress, since)) {
    if (message.fromAddr.toLowerCase() !== senderAddress.toLowerCase()) continue;
    if (!latest || message.internalDate > latest.internalDate) latest = message;
  }
  if (!latest) return null;

  const full = await provider.fetchFull(account, latest.providerMsgId);

  return {
    fromAddr: latest.fromAddr,
    fromName: latest.fromName,
    subject: latest.subject,
    internalDate: latest.internalDate,
    folder: latest.folder,
    bodyText: full.bodyText,
    bodyHtml: full.bodyHtml,
    attachments: full.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
  };
}
