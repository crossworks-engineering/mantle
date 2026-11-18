/**
 * Outlook mail for the Sync sidecar (Sync service plan M3;
 * docs/email-ingest.md): a connected Microsoft account's inbox through
 * Microsoft Graph, as before M4. A watermark on receivedDateTime (no delta);
 * each page's envelopes go through the brain's one gate first, and only the
 * wanted messages are fetched in full and posted (mail.ts gateFor and
 * ingestFor, the IMAP path's own). Backfill and discover read the inbox too.
 */
import { classifyDelivery } from '@mantle/email/classify';
import { MAIL_MESSAGE_MAX_BYTES, type WireAttachment, type WireMessage } from '@mantle/email/wire';
import { accessToken, graph, graphJson } from './microsoft';
import type { MsAccount, MsCursor, State } from './state';

const MAIL_SELECT =
  'id,internetMessageId,conversationId,subject,bodyPreview,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,hasAttachments,categories,flag,internetMessageHeaders';
const PAGE = 50;
/** Pages one run reads at most (2 500 messages); the next run goes on. */
const RUN_PAGES = 50;
/** Pages a backfill or a discover scan reads at most. */
const SCAN_PAGES = 6;
/** How far a first run reaches. */
const FIRST_SCAN_DAYS = 365;

type Addr = { emailAddress?: { address?: string; name?: string } };
export type GraphMessage = {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: Addr;
  sender?: Addr;
  toRecipients?: Addr[];
  ccRecipients?: Addr[];
  bccRecipients?: Addr[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  flag?: { flagStatus?: string };
  internetMessageHeaders?: { name: string; value: string }[];
};

const lower = (a: Addr | undefined) => a?.emailAddress?.address?.trim().toLowerCase() ?? '';
const addrs = (l: Addr[] | undefined) => (l ?? []).map(lower).filter(Boolean);
const stripAngles = (v: string | undefined) => v?.trim().replace(/^<|>$/g, '') || undefined;

/** A Graph message's envelope and summary in the wire shape (no body yet). */
export function normalize(m: GraphMessage): Omit<WireMessage, 'attachments'> {
  const headers: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) headers[h.name.toLowerCase()] = h.value;
  const fromAddr = lower(m.from ?? m.sender);
  const labels = m.categories ?? [];
  return {
    providerMsgId: m.id,
    rfcMessageId: stripAngles(m.internetMessageId),
    threadId: m.conversationId,
    fromAddr,
    fromName: (m.from ?? m.sender)?.emailAddress?.name,
    toAddrs: addrs(m.toRecipients),
    ccAddrs: addrs(m.ccRecipients),
    bccAddrs: addrs(m.bccRecipients),
    subject: m.subject,
    snippet: m.bodyPreview,
    internalDate: m.receivedDateTime ?? new Date().toISOString(),
    labels,
    folder: 'Inbox',
    isRead: m.isRead,
    isStarred: m.flag?.flagStatus === 'flagged',
    inReplyTo: headers['in-reply-to'],
    references: headers['references'],
    clientCodeHeader: 'x-mantle-client-code' in headers,
    deliveryKind: classifyDelivery({ headers, fromAddr, labels }),
  };
}

type FileAttachment = {
  '@odata.type'?: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
};

/** One wanted message in full: its body and its file attachments. Null
 *  when it is over the message cap (skipped, as the IMAP path does). */
async function fetchFull(token: string, m: GraphMessage): Promise<WireMessage | null> {
  const id = encodeURIComponent(m.id);
  const full = await graphJson<{ body?: { contentType?: string; content?: string } }>(
    token,
    `/me/messages/${id}?$select=body,hasAttachments`,
  );
  const attachments: WireAttachment[] = [];
  let bytes = Buffer.byteLength(full.body?.content ?? '');
  if (m.hasAttachments) {
    const r = await graphJson<{ value?: FileAttachment[] }>(
      token,
      `/me/messages/${id}/attachments`,
    );
    for (const a of r.value ?? []) {
      if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || !a.contentBytes) continue;
      const size = Math.floor((a.contentBytes.length * 3) / 4);
      bytes += size;
      attachments.push({
        filename: a.name ?? 'attachment',
        mimeType: a.contentType,
        sizeBytes: a.size ?? size,
        contentB64: a.contentBytes,
      });
    }
  }
  if (bytes > MAIL_MESSAGE_MAX_BYTES) return null;
  const html = full.body?.contentType?.toLowerCase() === 'html';
  return {
    ...normalize(m),
    ...(html ? { bodyHtml: full.body?.content } : { bodyText: full.body?.content }),
    attachments,
  };
}

type Page = { value?: GraphMessage[]; '@odata.nextLink'?: string };

export type WantedOf = (envelopes: ReturnType<typeof normalize>[]) => Promise<string[]>;
export type OnMessage = (message: WireMessage) => Promise<void>;

/** Gate one page, fetch and post the wanted ones. How many it read. */
async function walkPage(
  token: string,
  messages: GraphMessage[],
  wantedOf: WantedOf,
  onMessage: OnMessage,
): Promise<number> {
  const normal = messages.filter((m) => m.id).map((m) => ({ m, n: normalize(m) }));
  const wanted = new Set(await wantedOf(normal.map((x) => x.n).filter((n) => n.fromAddr)));
  for (const { m } of normal) {
    if (!wanted.has(m.id)) continue;
    const full = await fetchFull(token, m);
    if (full) await onMessage(full);
    else console.warn('[sync] an Outlook message over the size cap was skipped');
  }
  return normal.length;
}

/** One run of an account's inbox from its watermark. The watermark moves
 *  after each page. */
export async function syncOutlook(
  state: State,
  account: MsAccount,
  wantedOf: WantedOf,
  onMessage: OnMessage,
): Promise<{ scanned: number }> {
  const token = await accessToken(state, account.id);
  const cursor: MsCursor = await state.msCursor(account.id);
  const since = cursor.since ?? new Date(Date.now() - FIRST_SCAN_DAYS * 86_400_000).toISOString();
  // `ge`: the boundary message comes back once more; the gate's dedup
  // drops it.
  let next: string | undefined =
    `/me/mailFolders/inbox/messages?$select=${MAIL_SELECT}&$top=${PAGE}` +
    `&$orderby=receivedDateTime asc&$filter=receivedDateTime ge ${since}`;
  let scanned = 0;
  for (let i = 0; next && i < RUN_PAGES; i++) {
    const page: Page = await graphJson<Page>(token, next);
    const messages = page.value ?? [];
    scanned += await walkPage(token, messages, wantedOf, onMessage);
    const last = messages[messages.length - 1]?.receivedDateTime;
    if (last) await state.putMsCursor(account.id, { since: last });
    next = page['@odata.nextLink'];
  }
  return { scanned };
}

const odataString = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** A new contact's recent inbox mail (an address, or `@domain`). */
export async function backfillOutlook(
  state: State,
  account: MsAccount,
  target: string,
  since: Date,
  wantedOf: WantedOf,
  onMessage: OnMessage,
): Promise<{ scanned: number }> {
  const token = await accessToken(state, account.id);
  const want = target.trim().toLowerCase().replace(/^@/, '');
  if (!want) return { scanned: 0 };
  const isDomain = !want.includes('@');
  const filter = isDomain
    ? `receivedDateTime ge ${since.toISOString()}`
    : `from/emailAddress/address eq ${odataString(want)} and receivedDateTime ge ${since.toISOString()}`;
  let next: string | undefined =
    `/me/mailFolders/inbox/messages?$select=${MAIL_SELECT}&$top=${PAGE}&$filter=${encodeURIComponent(filter)}`;
  let scanned = 0;
  const pages = isDomain ? SCAN_PAGES * 3 : SCAN_PAGES;
  for (let i = 0; next && i < pages; i++) {
    const page: Page = await graphJson<Page>(token, next);
    const messages = (page.value ?? []).filter((m) => {
      const from = lower(m.from ?? m.sender);
      return isDomain ? from.endsWith(`@${want}`) : from === want;
    });
    scanned += await walkPage(token, messages, wantedOf, onMessage);
    next = page['@odata.nextLink'];
  }
  return { scanned };
}

export type OutlookSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: Date;
  subject?: string;
};

/** The inbox's recent senders (for discover), newest first. */
export async function recentOutlookSenders(
  state: State,
  account: MsAccount,
  since: Date,
): Promise<OutlookSender[]> {
  const token = await accessToken(state, account.id);
  const by = new Map<string, OutlookSender>();
  let next: string | undefined =
    `/me/mailFolders/inbox/messages?$select=from,sender,subject,receivedDateTime&$top=${PAGE}` +
    `&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since.toISOString()}`;
  for (let i = 0; next && i < SCAN_PAGES; i++) {
    const page: Page = await graphJson<Page>(token, next);
    for (const m of page.value ?? []) {
      const from = lower(m.from ?? m.sender);
      if (!from) continue;
      const at = new Date(m.receivedDateTime ?? 0);
      const prev = by.get(from);
      if (prev) prev.count += 1;
      else
        by.set(from, {
          fromAddr: from,
          fromName: (m.from ?? m.sender)?.emailAddress?.name,
          count: 1,
          lastDate: at,
          subject: m.subject,
        });
    }
    next = page['@odata.nextLink'];
  }
  return [...by.values()];
}

/** The most attachment bytes Graph takes in one sendMail (no upload
 *  session), as before M4. */
export const GRAPH_SEND_ATTACH_MAX = 2_500_000;

export type GraphSendInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename?: string; contentType?: string; cid?: string; contentB64: string }[];
};

/** Send from the account through Graph (/me/sendMail). Graph answers 202
 *  with no body: every recipient counts as accepted. */
export async function sendOutlook(
  state: State,
  account: MsAccount,
  input: GraphSendInput,
): Promise<void> {
  const recips = (l: string[] | undefined) =>
    (l ?? []).map((address) => ({ emailAddress: { address } }));
  const attachBytes = (input.attachments ?? []).reduce(
    (n, a) => n + Math.floor((a.contentB64.length * 3) / 4),
    0,
  );
  if (attachBytes > GRAPH_SEND_ATTACH_MAX) {
    throw new Error('Outlook sends at most 2.5 MB of attachments in one message.');
  }
  const token = await accessToken(state, account.id);
  await graph(token, '/me/sendMail', {
    method: 'POST',
    body: {
      saveToSentItems: true,
      message: {
        subject: input.subject,
        body: input.html
          ? { contentType: 'HTML', content: input.html }
          : { contentType: 'Text', content: input.text ?? '' },
        toRecipients: recips(input.to),
        ...(input.cc?.length ? { ccRecipients: recips(input.cc) } : {}),
        ...(input.bcc?.length ? { bccRecipients: recips(input.bcc) } : {}),
        ...(input.attachments?.length
          ? {
              attachments: input.attachments.map((a) => ({
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: a.filename ?? 'attachment',
                contentType: a.contentType ?? 'application/octet-stream',
                contentBytes: a.contentB64,
                ...(a.cid ? { isInline: true, contentId: a.cid } : {}),
              })),
            }
          : {}),
      },
    },
  });
}
