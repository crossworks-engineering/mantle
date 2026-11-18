/**
 * IMAP for the Sync sidecar (Sync service plan M2): the old adapter
 * (packages/email providers/imap.ts before M4), reading a mailbox's settings
 * from the sidecar's state instead of a database row.
 *
 * One connection per run of a mailbox. For each folder: list the new UIDs
 * (UID > the cursor's lastUid; on the first scan, or when uidvalidity rolls,
 * the messages of the last `firstScanDays`), fetch their envelopes in
 * batches, hand each batch's envelopes to `onBatch` (which asks the brain
 * which it wants), fetch those in full on the same connection, and move the
 * cursor after the batch. A message over MAIL_MESSAGE_MAX_BYTES is never
 * downloaded: it lands with its headers and a note.
 *
 * providerMsgId: `<folder>:<uidvalidity>:<uid>`, stable unless the server
 * rolls uidvalidity.
 */
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { classifyDelivery } from '@mantle/email/classify';
import { touchesClientCodeMail } from '@mantle/email/client-code-mail';
import { MAIL_MESSAGE_MAX_BYTES, type WireMessage } from '@mantle/email/wire';
import { errorMessage } from '@mantle/std';
import { checkedAddress } from './net';
import type { MailAccount, MailCursor } from './state';

/** Envelopes per batch: one gate call, then the full fetches. */
export const BATCH_SIZE = 50;
/** The most messages the discover scan reads across a mailbox. */
const RECENT_SCAN_CAP = 800;

/** One message's envelope as the adapter reads it (the old RawMessage). */
type RawMessage = {
  providerMsgId: string;
  rfcMessageId?: string;
  threadId?: string;
  fromAddr: string;
  fromName?: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string;
  internalDate: Date;
  labels?: string[];
  folder?: string;
  isRead?: boolean;
  isStarred?: boolean;
  sizeBytes?: number;
  hasAttachments: boolean;
  attachments: RawAttachmentRef[];
  deliveryKind?: ReturnType<typeof classifyDelivery>;
  inReplyTo?: string;
  references?: string;
  clientCodeHeader?: boolean;
};

type RawAttachmentRef = {
  providerAttachmentId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
};

/**
 * Headers fetched on the cheap listSince path so `classifyDelivery` can
 * decide direct/list/automated/marketing without ever pulling a body. These
 * ride along inside the same FETCH command as the envelope — ImapFlow
 * compiles them to `BODY.PEEK[HEADER.FIELDS (...)]`, one round trip — so the
 * extra cost is a few hundred bytes per message and nothing else.
 *
 * Adding a new ESP fingerprint? Append to this list AND
 * `ESP_FINGERPRINT_HEADERS` in packages/email classify.ts. Keep them in sync.
 */
const CLASSIFY_HEADERS = [
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
  'List-ID',
  'Precedence',
  'Auto-Submitted',
  'Feedback-ID',
  // ESP fingerprints — name-only (presence is the signal)
  'X-MC-User',
  'X-Mailchimp-Campaign-ID',
  'X-SG-EID',
  'X-SG-ID',
  'X-Mailgun-Sid',
  'X-Mailgun-Variables',
  'X-SES-Outgoing',
  'X-PM-Message-Id',
  'X-HS-Marketing-Email',
  'X-HubSpot-Campaign-Id',
  'X-CK-Domain',
  'X-Cmail-RecipientId',
  'X-ActiveCampaign-Id',
  'X-Klaviyo-Message-Id',
  'X-Mb-Mailer',
  'X-Iterable-Campaign-Id',
  'X-CIO-Delivery-ID',
] as const;

/** Headers fetched alongside CLASSIFY_HEADERS so the sync can skip a client
 *  sign-in code mail, and a reply or forward of one, before any body is
 *  fetched (client-code-mail.ts `touchesClientCodeMail`). */
const CODE_MAIL_HEADERS = ['X-Mantle-Client-Code', 'References'] as const;
const LIST_HEADERS = [...CLASSIFY_HEADERS, ...CODE_MAIL_HEADERS] as unknown as string[];

/**
 * Parse the raw header block ImapFlow returns from `headers: [...]` into a
 * lower-cased-key map. The block looks like:
 *
 *     List-Unsubscribe: <mailto:u@example.com>,\r\n
 *      <https://example.com/u>\r\n
 *     Precedence: bulk\r\n
 *     \r\n
 *
 * Folded continuations (lines starting with whitespace) are joined onto the
 * previous header. We keep only the first value when a name repeats — that
 * matches how `classifyDelivery` interprets its input. Empty values are
 * preserved as empty strings; the classifier requires non-empty to treat a
 * header as "present", which is what we want.
 */
export function parseHeaderBlock(buf: Buffer | string | undefined): Record<string, string> {
  if (!buf) return {};
  const text = typeof buf === 'string' ? buf : buf.toString('utf-8');
  // Normalise line endings; some servers use bare LF.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Record<string, string> = {};
  let currentName: string | undefined;
  let currentValue = '';
  const flush = () => {
    if (currentName === undefined) return;
    // Keep first occurrence on repeat — RFC 5322 forbids most duplicates,
    // but real-world mail has them and the classifier wants one answer.
    if (!(currentName in out)) out[currentName] = currentValue.trim();
    currentName = undefined;
    currentValue = '';
  };
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      // Folded continuation of the previous header.
      currentValue += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue; // malformed; skip
    flush();
    currentName = line.slice(0, colon).toLowerCase();
    currentValue = line.slice(colon + 1);
  }
  flush();
  return out;
}

/**
 * Generic IMAP adapter.

/** Connect to the mailbox's IMAP server (the checked address, the typed
 *  name for TLS). */
export async function connect(account: Pick<MailAccount, 'imap' | 'address' | 'password'>): Promise<ImapFlow> {
  const address = await checkedAddress(account.imap.host);
  const client = new ImapFlow({
    host: address,
    port: account.imap.port,
    secure: account.imap.secure,
    servername: account.imap.host,
    tls: { servername: account.imap.host },
    auth: { user: account.address, pass: account.password },
    logger: false,
  });
  // An error listener BEFORE connect(): without it imapflow's emitError() on a
  // socket timeout or a dropped connection throws and ends the process. The
  // awaited operation still rejects, so the run records the error.
  client.on('error', (err) => {
    console.warn('[sync] imap error on', mask(account.address), '-', errorMessage(err));
  });
  await client.connect();
  return client;
}

/** An address with its local part hidden, for a log line. */
export function mask(address: string): string {
  return address.replace(/^(.).+@(.+)$/, '$1***@$2');
}

/**
 * Canonicalise an RFC 5322 Message-ID header value for cross-folder dedup
 * (the `(account_id, rfc_message_id)` partial unique index, migration 0045).
 *
 * IMAP envelopes typically return the Message-ID wrapped in angle brackets —
 * `<abc123@gmail.com>` — but some servers strip them and others don't. We
 * strip both forms unconditionally so the stored value is consistent across
 * the long tail of IMAP server quirks. Returns `undefined` for empty / null
 * / brackets-only input (no Message-ID we can dedup on).
 */
export function normalizeRfcMessageId(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const stripped = raw.replace(/^\s*<|>\s*$/g, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

function encodeMsgId(folder: string, uidvalidity: number, uid: number): string {
  // folders can contain `:` (e.g. nested IMAP folders). Encode that.
  const safeFolder = folder.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  return `${safeFolder}:${uidvalidity}:${uid}`;
}

export function decodeMsgId(providerMsgId: string): {
  folder: string;
  uidvalidity: number;
  uid: number;
} {
  // Split from the right so escaped colons in the folder are preserved.
  const m = providerMsgId.match(/^(.+):(\d+):(\d+)$/);
  if (!m) throw new Error(`bad IMAP providerMsgId: ${providerMsgId}`);
  return {
    folder: m[1]!.replace(/\\:/g, ':').replace(/\\\\/g, '\\'),
    uidvalidity: Number(m[2]),
    uid: Number(m[3]),
  };
}

/** Walk imapflow's bodyStructure tree and collect attachment leaves. */
function extractAttachmentRefs(
  bodyStructure: FetchMessageObject['bodyStructure'] | undefined,
  providerMsgId: string,
): RawAttachmentRef[] {
  const out: RawAttachmentRef[] = [];
  function visit(node: NonNullable<FetchMessageObject['bodyStructure']> | undefined) {
    if (!node) return;
    if ('childNodes' in node && Array.isArray(node.childNodes)) {
      for (const child of node.childNodes) visit(child as typeof node);
      return;
    }
    const disposition = (node as { disposition?: string }).disposition?.toLowerCase();
    const filename =
      (node as { dispositionParameters?: { filename?: string } }).dispositionParameters?.filename ??
      (node as { parameters?: { name?: string } }).parameters?.name;
    const partId = (node as { part?: string }).part;
    if (disposition === 'attachment' || (filename && partId)) {
      out.push({
        providerAttachmentId: `${providerMsgId}#${partId ?? ''}`,
        filename: filename ?? 'unnamed',
        mimeType:
          ((node as { type?: string }).type ?? '') +
          ((node as { subtype?: string }).subtype
            ? '/' + (node as { subtype?: string }).subtype
            : ''),
        sizeBytes: (node as { size?: number }).size,
      });
    }
  }
  visit(bodyStructure as Parameters<typeof visit>[0]);
  return out;
}

function normalizeHeader(
  msg: FetchMessageObject,
  folder: string,
  uidvalidity: number,
): RawMessage | undefined {
  const env = msg.envelope;
  if (!env) return undefined;
  const fromRaw = env.from?.[0];
  const fromAddr = fromRaw?.address?.toLowerCase();
  if (!fromAddr) return undefined;

  const providerMsgId = encodeMsgId(folder, uidvalidity, msg.uid);
  const attachments = extractAttachmentRefs(msg.bodyStructure, providerMsgId);

  // Cross-folder dedup key. Envelope.messageId is the RFC 5322 Message-ID
  // header (per RFC 3501 envelope); see normalizeRfcMessageId for the
  // canonicalisation rules.
  const rfcMessageId = normalizeRfcMessageId(env.messageId);

  // Merge IMAP system flags (\Seen, \Answered, \Flagged) AND Gmail labels
  // (\Inbox, \Sent, \Important, custom labels like "Family") when the server
  // supports X-GM-EXT-1. `msg.labels` is populated only when we asked for
  // `labels: true` in fetch AND the server supports the extension; on plain
  // IMAP it's always undefined. Both are sets of strings; union them.
  const flagLabels = msg.flags ? Array.from(msg.flags) : [];
  const gmailLabels = msg.labels ? Array.from(msg.labels) : [];
  const labels =
    gmailLabels.length > 0 ? Array.from(new Set([...flagLabels, ...gmailLabels])) : flagLabels;

  const date =
    msg.internalDate instanceof Date
      ? msg.internalDate
      : msg.internalDate
        ? new Date(msg.internalDate)
        : env.date instanceof Date
          ? env.date
          : env.date
            ? new Date(env.date)
            : new Date(0);

  // Classify direct/list/automated/marketing from the marketing-tell
  // headers we asked for. `msg.headers` is the raw block ImapFlow returns
  // for `headers: [...]` (a Buffer of the requested HEADER.FIELDS); empty
  // when the server returned nothing matching. The classifier handles an
  // empty header map fine — it just falls through to `direct`.
  const headerMap = parseHeaderBlock(
    (msg as FetchMessageObject & { headers?: Buffer | string }).headers,
  );
  const deliveryKind = classifyDelivery({
    headers: headerMap,
    fromAddr,
    labels,
  });

  return {
    providerMsgId,
    rfcMessageId,
    inReplyTo: env.inReplyTo ?? undefined,
    references: headerMap['references'] || undefined,
    clientCodeHeader: headerMap['x-mantle-client-code'] !== undefined,
    threadId: env.inReplyTo ?? undefined,
    fromAddr,
    fromName: fromRaw?.name || undefined,
    toAddrs: (env.to ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    ccAddrs: (env.cc ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    bccAddrs: (env.bcc ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    subject: env.subject ?? undefined,
    internalDate: date,
    labels,
    folder,
    isRead: msg.flags?.has('\\Seen') ?? false,
    isStarred: msg.flags?.has('\\Flagged') ?? false,
    sizeBytes: msg.size,
    hasAttachments: attachments.length > 0,
    attachments,
    deliveryKind,
  };
}

/** The folders to scan: the server's list, minus the excluded and the
 *  \Noselect ones; only the included ones when that list is set. */
export async function scanFolders(
  client: ImapFlow,
  account: Pick<MailAccount, 'excludedFolders' | 'includedFolders'>,
): Promise<string[]> {
  const list = await client.list();
  const excludeSet = new Set(account.excludedFolders);
  const included = account.includedFolders;
  const includeSet = included && included.length > 0 ? new Set(included) : null;
  return list
    .filter((m) => !!m.path && !excludeSet.has(m.path))
    .filter((m) => !includeSet || includeSet.has(m.path))
    .filter((m) => !(m as { flags?: Set<string> }).flags?.has('\\Noselect'))
    .map((m) => m.path);
}

/** Every folder of the server (the folders screen). */
export async function allFolders(client: ImapFlow): Promise<string[]> {
  const list = await client.list();
  return list
    .filter((m) => !!m.path && !(m as { flags?: Set<string> }).flags?.has('\\Noselect'))
    .map((m) => m.path);
}

const ENVELOPE_QUERY = {
  envelope: true,
  internalDate: true,
  flags: true,
  labels: true,
  bodyStructure: true,
  size: true,
  headers: LIST_HEADERS,
} as const;

/** The envelopes of `uids` in the open folder. */
async function envelopes(
  client: ImapFlow,
  uids: number[],
  folder: string,
  uidvalidity: number,
): Promise<{ uid: number; message: RawMessage }[]> {
  const out: { uid: number; message: RawMessage }[] = [];
  if (uids.length === 0) return out;
  for await (const msg of client.fetch(uids, ENVELOPE_QUERY, { uid: true })) {
    const normalized = normalizeHeader(msg, folder, uidvalidity);
    if (normalized) out.push({ uid: msg.uid, message: normalized });
  }
  return out;
}

/** One message of the open folder, in full, as it crosses to the brain. */
async function fullMessage(
  client: ImapFlow,
  uid: number,
  message: RawMessage,
): Promise<WireMessage> {
  const base: WireMessage = {
    ...message,
    internalDate: message.internalDate.toISOString(),
    attachments: [],
  };
  delete (base as { hasAttachments?: unknown }).hasAttachments;
  if (typeof message.sizeBytes === 'number' && message.sizeBytes > MAIL_MESSAGE_MAX_BYTES) {
    return {
      ...base,
      bodyText: `(This message is ${Math.round(message.sizeBytes / 1024 / 1024)} MB, past the ${MAIL_MESSAGE_MAX_BYTES / 1024 / 1024} MB the brain fetches in full. Read it in your mail client.)`,
    };
  }
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) throw new Error('a listed message could not be fetched');
  // No HTML-to-text here: an HTML-only mail keeps its HTML, and the brain's
  // parser reads it.
  const parsed = await simpleParser(msg.source, { skipHtmlToText: true });
  return {
    ...base,
    bodyText: parsed.text || undefined,
    bodyHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
    attachments: parsed.attachments.map((a, i) => ({
      filename: a.filename ?? `unnamed-${i}`,
      mimeType: a.contentType,
      sizeBytes: a.size,
      contentB64: a.content.toString('base64'),
    })),
    clientCodeMail: touchesClientCodeMail({
      rfcMessageId: parsed.messageId ?? null,
      clientCodeHeader: parsed.headers.has('x-mantle-client-code'),
      inReplyTo: parsed.inReplyTo ?? null,
      references: Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : (parsed.references ?? null),
    }),
  };
}

/** What a batch handler answers: the providerMsgIds it wants in full. */
export type WantedOf = (envelopes: RawMessage[]) => Promise<string[]>;
/** Called with each wanted message, fetched in full. */
export type OnMessage = (message: WireMessage) => Promise<void>;

/** Walk `uids` of the open folder in batches: envelopes, the wanted ones,
 *  each in full. Answers how many envelopes it read. */
async function walk(
  client: ImapFlow,
  uids: number[],
  folder: string,
  uidvalidity: number,
  wantedOf: WantedOf,
  onMessage: OnMessage,
  afterBatch?: (maxUid: number) => Promise<void>,
): Promise<number> {
  let scanned = 0;
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const listed = await envelopes(client, batch, folder, uidvalidity);
    scanned += listed.length;
    const wanted = new Set(await wantedOf(listed.map((l) => l.message)));
    for (const l of listed) {
      if (!wanted.has(l.message.providerMsgId)) continue;
      await onMessage(await fullMessage(client, l.uid, l.message));
    }
    if (afterBatch) await afterBatch(Math.max(...batch));
  }
  return scanned;
}

/**
 * One run of a mailbox: every scanned folder since the cursor. The cursor is
 * moved (and `saveCursor` called) after each batch, so a run that stops
 * half way goes on from there.
 */
export async function syncMailbox(
  account: MailAccount,
  cursor: MailCursor,
  wantedOf: WantedOf,
  onMessage: OnMessage,
  saveCursor: (c: MailCursor) => Promise<void>,
): Promise<{ scanned: number }> {
  const client = await connect(account);
  let scanned = 0;
  try {
    for (const folder of await scanFolders(client, account)) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        console.warn('[sync] skipping folder', folder, errorMessage(err));
        continue;
      }
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') continue;
        const uidvalidity = Number(mbox.uidValidity);
        const prev = cursor.folders[folder];
        const sameVal = prev?.uidvalidity === uidvalidity;
        let uids: number[];
        if (sameVal && prev) {
          const found = await client.search({ uid: `${prev.lastUid + 1}:*` }, { uid: true });
          // `n:*` always answers the last message, even below n.
          uids = (Array.isArray(found) ? found : []).filter((u) => u > prev.lastUid);
        } else {
          const since = new Date(Date.now() - account.firstScanDays * 86_400_000);
          const found = await client.search({ since }, { uid: true });
          uids = Array.isArray(found) ? found : [];
          cursor.folders[folder] = { uidvalidity, lastUid: 0 };
        }
        uids.sort((a, b) => a - b);
        if (uids.length === 0) {
          if (!sameVal) await saveCursor(cursor);
          continue;
        }
        scanned += await walk(client, uids, folder, uidvalidity, wantedOf, onMessage, async (maxUid) => {
          cursor.folders[folder] = { uidvalidity, lastUid: maxUid };
          await saveCursor(cursor);
        });
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { scanned };
}

/**
 * A new contact's backfill: every scanned folder's messages from `sender`
 * (an address, or a bare domain) since `since`, through the same gate and
 * ingest. IMAP's FROM search is a substring match, so each hit is checked:
 * the exact address, or the exact domain. The cursor is not touched.
 */
export async function backfillSender(
  account: MailAccount,
  sender: string,
  since: Date,
  wantedOf: WantedOf,
  onMessage: OnMessage,
): Promise<{ scanned: number }> {
  const wantedSender = sender.trim().toLowerCase().replace(/^@/, '');
  if (!wantedSender) return { scanned: 0 };
  const isDomain = !wantedSender.includes('@');
  const matches = (from: string) =>
    isDomain ? from.split('@')[1] === wantedSender : from === wantedSender;
  const client = await connect(account);
  let scanned = 0;
  try {
    for (const folder of await scanFolders(client, account)) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        continue;
      }
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') continue;
        const uidvalidity = Number(mbox.uidValidity);
        const found = await client.search({ from: wantedSender, since }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        scanned += await walk(
          client,
          uids,
          folder,
          uidvalidity,
          (envs) => wantedOf(envs.filter((e) => matches(e.fromAddr))),
          onMessage,
        );
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { scanned };
}

/** A sender seen in recent mail (the discover screen). */
export type RecentSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: Date;
  subject?: string;
};

/** The senders of the mailbox's recent mail (headers only, at most
 *  RECENT_SCAN_CAP messages, newest first). */
export async function recentSenders(account: MailAccount, since: Date): Promise<RecentSender[]> {
  const client = await connect(account);
  const bySender = new Map<string, RecentSender>();
  let remaining = RECENT_SCAN_CAP;
  try {
    for (const folder of await scanFolders(client, account)) {
      if (remaining <= 0) break;
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        continue;
      }
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') continue;
        const uidvalidity = Number(mbox.uidValidity);
        const found = await client.search({ since }, { uid: true });
        const uids = (Array.isArray(found) ? found : []).sort((a, b) => a - b).slice(-remaining);
        for (const { message } of await envelopes(client, uids, folder, uidvalidity)) {
          remaining -= 1;
          const prev = bySender.get(message.fromAddr);
          if (prev) {
            prev.count += 1;
            if (message.internalDate > prev.lastDate) {
              prev.lastDate = message.internalDate;
              prev.subject = message.subject;
              prev.fromName = message.fromName ?? prev.fromName;
            }
          } else {
            bySender.set(message.fromAddr, {
              fromAddr: message.fromAddr,
              fromName: message.fromName,
              count: 1,
              lastDate: message.internalDate,
              subject: message.subject,
            });
          }
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return [...bySender.values()];
}

/** Log in once and list the server's folders: the check on save. */
export async function probe(
  account: Pick<MailAccount, 'imap' | 'address' | 'password'>,
): Promise<string[]> {
  const client = await connect(account);
  try {
    return await allFolders(client);
  } finally {
    await client.logout().catch(() => {});
  }
}
