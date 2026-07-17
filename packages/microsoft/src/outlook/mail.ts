/**
 * Microsoft Graph mail provider — implements `@mantle/email`'s `EmailProvider`
 * so Outlook/M365 mail flows through the SAME pipeline as IMAP: `syncAccount`
 * applies the contact gate, classifies, and inserts the node + emails row +
 * attachments. Nothing here re-implements ingestion; it only adapts Graph.
 *
 * Cursor model: a monotonic `receivedDateTime` watermark stored in
 * `email_accounts.sync_state.graph.mail.since`, mirroring IMAP's per-folder UID
 * watermark. We use `ge` (not `gt`) so the boundary message is re-yielded and
 * deduped — safe with the orchestrator's flush/persist model. (Graph delta would
 * additionally surface deletions/moves; the email pipeline is append-only, like
 * IMAP, so a watermark is sufficient — see docs/microsoft-graph-ingest.md.)
 *
 * v1 scans the Inbox only; other folders can be added later the way IMAP
 * discovers folders.
 */
import type { EmailAccount } from '@mantle/db';
import { classifyDelivery } from '@mantle/email';
import type {
  EmailProvider,
  FullMessage,
  RawAttachment,
  RawMessage,
  SyncCursor,
} from '@mantle/email';
import { graphGet } from '../client';
import type { GraphAttachment, GraphMessage, GraphRecipient } from './types';

const MAIL_SELECT =
  'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,hasAttachments,categories,flag,internetMessageHeaders';
const PAGE = 50;
/** Bound for the header-only discovery/backfill paths. */
const MAX_DISCOVERY_PAGES = 6;

interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

function msId(account: EmailAccount): string {
  if (!account.msAccountId) {
    throw new Error(`email account ${account.id} (provider=microsoft) is missing ms_account_id`);
  }
  return account.msAccountId;
}

function buildPath(base: string, params: Record<string, string>): string {
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${q}`;
}

function addrs(list: GraphRecipient[] | undefined): string[] {
  return (list ?? [])
    .map((r) => r.emailAddress?.address?.toLowerCase())
    .filter((a): a is string => !!a);
}

function stripAngles(id: string | undefined): string | undefined {
  return id ? id.replace(/^<|>$/g, '') : undefined;
}

/** Graph message → provider-agnostic RawMessage (+ delivery classification). */
function normalize(m: GraphMessage): RawMessage {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) headers[h.name.toLowerCase()] = h.value;
  const fromAddr = (
    m.from?.emailAddress?.address ??
    m.sender?.emailAddress?.address ??
    ''
  ).toLowerCase();

  let deliveryKind: RawMessage['deliveryKind'];
  try {
    deliveryKind = classifyDelivery({ headers, fromAddr, labels: m.categories ?? [] });
  } catch {
    deliveryKind = undefined; // orchestrator persists 'unknown'
  }

  return {
    providerMsgId: m.id,
    rfcMessageId: stripAngles(m.internetMessageId),
    threadId: m.conversationId,
    fromAddr,
    fromName: m.from?.emailAddress?.name,
    toAddrs: addrs(m.toRecipients),
    ccAddrs: addrs(m.ccRecipients),
    bccAddrs: addrs(m.bccRecipients),
    subject: m.subject,
    snippet: m.bodyPreview,
    internalDate: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
    labels: m.categories ?? [],
    folder: 'Inbox',
    isRead: m.isRead,
    isStarred: m.flag?.flagStatus === 'flagged',
    hasAttachments: !!m.hasAttachments,
    attachments: [], // refs not needed; bytes come from fetchFull
    deliveryKind,
  };
}

function sinceFromCursor(account: EmailAccount, cursor: SyncCursor | undefined): string {
  const raw = (cursor?.raw ?? account.syncState) as Record<string, unknown> | undefined;
  const graph = raw?.graph as { mail?: { since?: string } } | undefined;
  if (graph?.mail?.since) return graph.mail.since;
  // First scan: reach back `firstScanDays` (default 365).
  const days = account.firstScanDays ?? 365;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const graphMailProvider: EmailProvider = {
  async *listSince(account, cursor) {
    const since = sinceFromCursor(account, cursor);
    let url: string | undefined = buildPath('/me/mailFolders/inbox/messages', {
      $select: MAIL_SELECT,
      $top: String(PAGE),
      $orderby: 'receivedDateTime asc',
      $filter: `receivedDateTime ge ${since}`,
    });

    while (url) {
      const page: GraphPage<GraphMessage> = await graphGet(account.userId, msId(account), url);
      for (const m of page.value ?? []) {
        const message = normalize(m);
        // Watermark advances to THIS message's time — resuming re-yields it
        // (deduped), never skips past an un-ingested one.
        const nextCursor: SyncCursor = {
          raw: { graph: { mail: { since: m.receivedDateTime ?? since } } },
        };
        yield { message, nextCursor };
      }
      url = page['@odata.nextLink'];
    }
  },

  async fetchFull(account, providerMsgId): Promise<FullMessage> {
    const id = encodeURIComponent(providerMsgId);
    const m: GraphMessage = await graphGet(
      account.userId,
      msId(account),
      `/me/messages/${id}?$select=body,hasAttachments`,
    );
    const isHtml = m.body?.contentType?.toLowerCase() === 'html';
    const bodyHtml = isHtml ? m.body?.content : undefined;
    const bodyText = isHtml ? undefined : m.body?.content;

    const attachments: RawAttachment[] = [];
    if (m.hasAttachments) {
      const page: GraphPage<GraphAttachment> = await graphGet(
        account.userId,
        msId(account),
        `/me/messages/${id}/attachments`,
      );
      for (const a of page.value ?? []) {
        if (a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes) {
          attachments.push({
            providerAttachmentId: a.id ?? '',
            filename: a.name ?? 'attachment',
            mimeType: a.contentType,
            sizeBytes: a.size,
            content: Buffer.from(a.contentBytes, 'base64'),
          });
        }
      }
    }
    return { bodyText, bodyHtml, attachments };
  },

  async *listRecent(account, since) {
    let url: string | undefined = buildPath('/me/mailFolders/inbox/messages', {
      $select: MAIL_SELECT,
      $top: String(PAGE),
      $orderby: 'receivedDateTime desc',
      $filter: `receivedDateTime ge ${since.toISOString()}`,
    });
    for (let i = 0; url && i < MAX_DISCOVERY_PAGES; i++) {
      const page: GraphPage<GraphMessage> = await graphGet(account.userId, msId(account), url);
      for (const m of page.value ?? []) yield normalize(m);
      url = page['@odata.nextLink'];
    }
  },

  async *listFromSender(account, senderAddress, since) {
    const filter = `from/emailAddress/address eq '${senderAddress.replace(/'/g, "''")}' and receivedDateTime ge ${since.toISOString()}`;
    let url: string | undefined = buildPath('/me/messages', {
      $select: MAIL_SELECT,
      $top: String(PAGE),
      $filter: filter,
    });
    for (let i = 0; url && i < MAX_DISCOVERY_PAGES; i++) {
      const page: GraphPage<GraphMessage> = await graphGet(account.userId, msId(account), url);
      for (const m of page.value ?? []) yield normalize(m);
      url = page['@odata.nextLink'];
    }
  },
};
