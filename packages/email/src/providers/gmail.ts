import { google, type gmail_v1 } from 'googleapis';
import type { EmailAccount } from '@mantle/db';
import { parseAddress, parseAddressList } from '../addresses';
import { authClientForAccount } from '../oauth/google';
import type {
  EmailProvider,
  FullMessage,
  RawAttachment,
  RawAttachmentRef,
  RawMessage,
  SyncCursor,
} from '../types';

/**
 * Gmail adapter.
 *
 * Sync strategy is "list-by-date":
 *   - first run: query `after:<12-months-ago>`, paginate IDs, fetch each
 *     message's metadata, yield envelopes
 *   - subsequent: query `after:<latestInternalDate>`, same pagination —
 *     advances strictly by INTERNALDATE, so no risk of double-ingest
 *
 * This is simpler than `history.list` and works against archived /
 * label-changed messages too. The downside is per-message metadata
 * fetches on first sync. Users.messages.list returns IDs only, so we
 * trade calls for simplicity. A `history.list` upgrade can come later
 * with a fallback to date-list when historyId expires (>~30 days).
 *
 * Cursor shape: `{ gmail: { latestInternalDateMs: number } }`.
 */

const FIRST_SCAN_MONTHS = 12;
const PAGE_SIZE = 100;
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date', 'In-Reply-To'];

interface GmailCursor {
  latestInternalDateMs?: number;
}

function getCursor(account: EmailAccount, cursor: SyncCursor | undefined): GmailCursor {
  const raw = (cursor?.raw?.['gmail'] ?? account.syncState?.['gmail']) as GmailCursor | undefined;
  return raw ?? {};
}

/** Gmail's `q` parameter wants `after:YYYY/MM/DD`. */
function gmailDate(d: Date): string {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function decodeBase64Url(b64?: string | null): Buffer {
  if (!b64) return Buffer.alloc(0);
  return Buffer.from(b64, 'base64url');
}

/**
 * Walk Gmail's MIME tree, picking the first text/plain and text/html bodies
 * and collecting attachment refs. Inline images (parts with Content-ID)
 * are treated as attachments — the renderer ignores `cid:` schemes for
 * unstored senders but will use them once ingestion proper imports the
 * attachment.
 */
function walkPayload(
  part: gmail_v1.Schema$MessagePart | undefined,
  acc: { bodyText?: string; bodyHtml?: string; attachments: gmail_v1.Schema$MessagePart[] },
): void {
  if (!part) return;
  const mimeType = part.mimeType ?? '';

  if (part.parts && part.parts.length > 0) {
    for (const p of part.parts) walkPayload(p, acc);
    return;
  }

  const filename = part.filename;
  const isAttachment = !!filename && !!part.body?.attachmentId;
  if (isAttachment) {
    acc.attachments.push(part);
    return;
  }

  if (mimeType === 'text/plain' && part.body?.data && acc.bodyText === undefined) {
    acc.bodyText = decodeBase64Url(part.body.data).toString('utf8');
  } else if (mimeType === 'text/html' && part.body?.data && acc.bodyHtml === undefined) {
    acc.bodyHtml = decodeBase64Url(part.body.data).toString('utf8');
  }
}

function attachmentRefs(parts: gmail_v1.Schema$MessagePart[]): RawAttachmentRef[] {
  return parts.map((p) => ({
    providerAttachmentId: p.body?.attachmentId ?? '',
    filename: p.filename ?? 'unnamed',
    mimeType: p.mimeType ?? undefined,
    sizeBytes: p.body?.size ?? undefined,
  }));
}

function normalizeMessage(msg: gmail_v1.Schema$Message): RawMessage | undefined {
  const id = msg.id;
  if (!id) return undefined;
  const headers = msg.payload?.headers ?? undefined;

  const fromRaw = headerValue(headers, 'From');
  const from = fromRaw ? parseAddress(fromRaw) : undefined;
  if (!from) return undefined;

  const acc = { attachments: [] as gmail_v1.Schema$MessagePart[] } as {
    bodyText?: string;
    bodyHtml?: string;
    attachments: gmail_v1.Schema$MessagePart[];
  };
  if (msg.payload) walkPayload(msg.payload, acc);

  const labels = msg.labelIds ?? [];
  const internalDate = msg.internalDate
    ? new Date(Number(msg.internalDate))
    : new Date(0);

  return {
    providerMsgId: id,
    threadId: msg.threadId ?? undefined,
    fromAddr: from.address,
    fromName: from.name,
    toAddrs: parseAddressList(headerValue(headers, 'To')).map((a) => a.address),
    ccAddrs: parseAddressList(headerValue(headers, 'Cc')).map((a) => a.address),
    bccAddrs: parseAddressList(headerValue(headers, 'Bcc')).map((a) => a.address),
    subject: headerValue(headers, 'Subject'),
    snippet: msg.snippet ?? undefined,
    internalDate,
    labels,
    folder: labels.find((l) => l === 'INBOX' || l === 'SENT' || l === 'DRAFT') ?? undefined,
    isRead: !labels.includes('UNREAD'),
    isStarred: labels.includes('STARRED'),
    sizeBytes: msg.sizeEstimate ?? undefined,
    hasAttachments: acc.attachments.length > 0,
    attachments: attachmentRefs(acc.attachments),
  };
}

async function getMetadata(
  client: gmail_v1.Gmail,
  id: string,
): Promise<gmail_v1.Schema$Message | undefined> {
  try {
    const res = await client.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS,
    });
    return res.data;
  } catch (err) {
    // 404 means the message was deleted between list and get — skip it.
    if ((err as { code?: number }).code === 404) return undefined;
    throw err;
  }
}

export const gmail: EmailProvider = {
  async *listSince(account, cursor) {
    const client = google.gmail({ version: 'v1', auth: authClientForAccount(account) });
    const state = getCursor(account, cursor);

    const since = state.latestInternalDateMs
      ? new Date(state.latestInternalDateMs)
      : (() => {
          const d = new Date();
          d.setMonth(d.getMonth() - FIRST_SCAN_MONTHS);
          return d;
        })();

    const q = `after:${gmailDate(since)}`;
    let pageToken: string | undefined;
    let latestSeen = state.latestInternalDateMs ?? since.getTime();

    do {
      const res = await client.users.messages.list({
        userId: 'me',
        q,
        maxResults: PAGE_SIZE,
        pageToken,
      });
      pageToken = res.data.nextPageToken ?? undefined;
      const ids = res.data.messages ?? [];

      for (const { id } of ids) {
        if (!id) continue;
        const meta = await getMetadata(client, id);
        if (!meta) continue;
        const normalized = normalizeMessage(meta);
        if (!normalized) continue;
        // Gmail's `after:` filter is day-resolution; skip messages we've
        // already seen to avoid re-yielding day-boundary duplicates.
        if (normalized.internalDate.getTime() <= (state.latestInternalDateMs ?? 0)) continue;
        if (normalized.internalDate.getTime() > latestSeen) {
          latestSeen = normalized.internalDate.getTime();
        }
        yield {
          message: normalized,
          nextCursor: { raw: { gmail: { latestInternalDateMs: latestSeen } } },
        };
      }
    } while (pageToken);
  },

  async fetchFull(account, providerMsgId): Promise<FullMessage> {
    const client = google.gmail({ version: 'v1', auth: authClientForAccount(account) });
    const res = await client.users.messages.get({
      userId: 'me',
      id: providerMsgId,
      format: 'full',
    });
    const acc = { attachments: [] as gmail_v1.Schema$MessagePart[] } as {
      bodyText?: string;
      bodyHtml?: string;
      attachments: gmail_v1.Schema$MessagePart[];
    };
    if (res.data.payload) walkPayload(res.data.payload, acc);

    // Resolve each attachment's bytes. Gmail keeps attachment payloads in
    // a separate endpoint so the message fetch stays cheap.
    const attachments: RawAttachment[] = [];
    for (const part of acc.attachments) {
      const attId = part.body?.attachmentId;
      if (!attId) continue;
      const attRes = await client.users.messages.attachments.get({
        userId: 'me',
        messageId: providerMsgId,
        id: attId,
      });
      attachments.push({
        providerAttachmentId: attId,
        filename: part.filename ?? 'unnamed',
        mimeType: part.mimeType ?? undefined,
        sizeBytes: part.body?.size ?? undefined,
        content: decodeBase64Url(attRes.data.data),
      });
    }

    return {
      bodyText: acc.bodyText,
      bodyHtml: acc.bodyHtml,
      attachments,
    };
  },

  async *listFromSender(account, senderAddress, since): AsyncIterable<RawMessage> {
    const client = google.gmail({ version: 'v1', auth: authClientForAccount(account) });
    const q = `from:${senderAddress} after:${gmailDate(since)}`;
    let pageToken: string | undefined;

    do {
      const res = await client.users.messages.list({
        userId: 'me',
        q,
        maxResults: PAGE_SIZE,
        pageToken,
      });
      pageToken = res.data.nextPageToken ?? undefined;
      for (const { id } of res.data.messages ?? []) {
        if (!id) continue;
        const meta = await getMetadata(client, id);
        if (!meta) continue;
        const normalized = normalizeMessage(meta);
        if (normalized) yield normalized;
      }
    } while (pageToken);
  },
};
