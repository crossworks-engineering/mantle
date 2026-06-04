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

/**
 * A distinct sender seen in the recent-mail scan, with how many messages and
 * the latest one's date/subject. Powers the "discover unknown senders" view —
 * the caller filters these through the contact gate to show only the ones not
 * already allowed.
 */
export interface RecentSender {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: Date;
  subject?: string;
}

/**
 * Aggregate distinct senders from a bounded recent-mail scan. Read-through to
 * IMAP (via `provider.listRecent`); nothing is persisted. Returns the senders
 * sorted newest-first, capped at `limit`.
 */
export async function peekRecentSenders(
  account: EmailAccount,
  provider: EmailProvider,
  opts: { sinceDays?: number; limit?: number } = {},
): Promise<RecentSender[]> {
  const sinceDays = opts.sinceDays ?? 30;
  const limit = opts.limit ?? 50;
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const byAddr = new Map<string, RecentSender>();
  for await (const m of provider.listRecent(account, since)) {
    const addr = m.fromAddr.toLowerCase();
    if (!addr) continue;
    const prev = byAddr.get(addr);
    if (prev) {
      prev.count += 1;
      if (m.internalDate > prev.lastDate) {
        prev.lastDate = m.internalDate;
        prev.subject = m.subject;
        prev.fromName = m.fromName ?? prev.fromName;
      }
    } else {
      byAddr.set(addr, {
        fromAddr: addr,
        fromName: m.fromName,
        count: 1,
        lastDate: m.internalDate,
        subject: m.subject,
      });
    }
  }
  return [...byAddr.values()]
    .sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime())
    .slice(0, limit);
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
