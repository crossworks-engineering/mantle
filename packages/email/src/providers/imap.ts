import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { open } from '@mantle/crypto';
import type { EmailAccount } from '@mantle/db';
import { parseAddress, parseAddressList } from '../addresses';
import { classifyDelivery, type DeliveryKind } from '../classify';
import type {
  EmailProvider,
  FullMessage,
  RawAttachment,
  RawAttachmentRef,
  RawMessage,
  SyncCursor,
} from '../types';

/**
 * Headers fetched on the cheap listSince path so `classifyDelivery` can
 * decide direct/list/automated/marketing without ever pulling a body. These
 * ride along inside the same FETCH command as the envelope — ImapFlow
 * compiles them to `BODY.PEEK[HEADER.FIELDS (...)]`, one round trip — so the
 * extra cost is a few hundred bytes per message and nothing else.
 *
 * Adding a new ESP fingerprint? Append to this list AND
 * `ESP_FINGERPRINT_HEADERS` in `../classify.ts`. Keep them in sync.
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
 *
 * Cursor shape (stored on `email_accounts.sync_state.raw.imap`):
 *   { folders: { '<folder>': { uidvalidity: number, lastUid: number } } }
 *
 * On first sync (or when uidvalidity changes) we scan back
 * `account.firstScanDays` (default 365) via an INTERNALDATE SINCE search.
 * Subsequent runs use UID > lastUid.
 *
 * `listSince` yields headers + MIME structure only (cheap). The orchestrator
 * calls `fetchFull` separately for messages whose sender is approved.
 *
 * providerMsgId format: `<folder>:<uidvalidity>:<uid>` — stable across syncs
 * unless the server changes uidvalidity (which forces a full re-scan).
 */

/** Fallback first-scan window when an account predates the column / has null. */
const DEFAULT_FIRST_SCAN_DAYS = 365;

/** Hard cap on messages scanned by `listRecent` (the interactive
 *  discover-unknown-senders view) so a busy mailbox can't make it unbounded. */
const RECENT_SCAN_CAP = 800;

interface ImapCursor {
  folders: Record<string, { uidvalidity: number; lastUid: number }>;
}

interface ImapCredentials {
  password: string;
}

function getCursor(account: EmailAccount, cursor: SyncCursor | undefined): ImapCursor {
  const raw = (cursor?.raw?.['imap'] ?? account.syncState?.['imap']) as ImapCursor | undefined;
  return { folders: raw?.folders ?? {} };
}

function unsealCredentials(account: EmailAccount): ImapCredentials {
  if (!account.imapConfigEnc) {
    throw new Error(`account ${account.address} has no IMAP credentials`);
  }
  return JSON.parse(
    open(account.imapConfigEnc, `imap:${account.userId}:${account.address}`),
  ) as ImapCredentials;
}

/** Decrypt and return just the IMAP app password for a saved account. The
 *  web folder-config action needs this to re-probe the server's folder list
 *  (via `probeImapConnection`) without duplicating the AAD derivation. */
export function unsealImapPassword(account: EmailAccount): string {
  return unsealCredentials(account).password;
}

async function connect(account: EmailAccount): Promise<ImapFlow> {
  if (!account.imapHost || !account.imapPort) {
    throw new Error(`account ${account.address} has no imapHost/imapPort configured`);
  }
  const { password } = unsealCredentials(account);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.address, pass: password },
    logger: false,
  });
  // Attach an error listener BEFORE connect(). Without this, imapflow's
  // internal emitError() on a TLS socket timeout / connection drop emits an
  // 'error' event with no handler → Node's default behaviour is to throw
  // and **crash the worker process** (verified live: ETIMEOUT from a
  // long-lived sync connection took down the entire email-sync worker).
  // With the listener attached, the event is consumed; the in-flight
  // `await` on the operation still rejects normally, so pg-boss records
  // the job as failed and the next scheduler tick (2 min) retries cleanly.
  client.on('error', (err) => {
    console.warn(
      '[imap] socket/protocol error on',
      account.address.replace(/^(.).+@(.+)$/, '$1***@$2'),
      '-',
      err instanceof Error ? err.message : String(err),
    );
  });
  await client.connect();
  return client;
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

/** Auto-discover scannable folders for this account. Lists the server's
 *  current folder tree, drops anything in `imap_excluded_folders`, and
 *  also drops common system folders the server marks `\Noselect` (the
 *  IMAP convention for namespace separators that can't actually hold
 *  messages, like a top-level Gmail `[Gmail]`).
 *
 *  When `included` is non-empty (migration 0033 — explicit per-account
 *  allow-list), scan ONLY those folders. It's still intersected with the
 *  live server list and minus `excluded`, so a renamed/stale entry simply
 *  drops out rather than erroring. NULL/empty `included` = legacy
 *  "everything that isn't excluded". */
async function discoverFolders(
  client: ImapFlow,
  excluded: string[],
  included?: string[] | null,
): Promise<string[]> {
  const list = await client.list();
  const excludeSet = new Set(excluded);
  const includeSet = included && included.length > 0 ? new Set(included) : null;
  return list
    .filter((m) => !!m.path && !excludeSet.has(m.path))
    .filter((m) => !includeSet || includeSet.has(m.path))
    .filter((m) => {
      const flags = (m as { flags?: Set<string> }).flags;
      return !flags?.has('\\Noselect');
    })
    .map((m) => m.path);
}

export const imap: EmailProvider = {
  async *listSince(account, cursor) {
    const client = await connect(account);
    const state = getCursor(account, cursor);
    try {
      const folders = await discoverFolders(
        client,
        account.imapExcludedFolders,
        account.imapIncludedFolders,
      );
      for (const folder of folders) {
        let lock;
        try {
          lock = await client.getMailboxLock(folder);
        } catch (err) {
          // Folder doesn't exist, or we lack permission. Skip but keep going.
          console.warn('[imap] skipping folder', folder, (err as Error).message);
          continue;
        }
        try {
          const mbox = client.mailbox;
          if (!mbox || typeof mbox === 'boolean') continue;
          const uidvalidity = Number(mbox.uidValidity);
          const prev = state.folders[folder];
          const sameVal = prev?.uidvalidity === uidvalidity;

          // Build the fetch query.
          let range: string | number[];
          if (sameVal && prev) {
            range = `${prev.lastUid + 1}:*`;
          } else {
            // First sync (or uidvalidity rolled): get UIDs from messages
            // delivered within the account's configured history window.
            const days = account.firstScanDays ?? DEFAULT_FIRST_SCAN_DAYS;
            const since = new Date();
            since.setDate(since.getDate() - days);
            const searchRes = await client.search({ since }, { uid: true });
            const uids: number[] = Array.isArray(searchRes) ? searchRes : [];
            if (uids.length === 0) {
              state.folders[folder] = { uidvalidity, lastUid: 0 };
              continue;
            }
            range = uids;
          }

          let maxUid = prev && sameVal ? prev.lastUid : 0;
          for await (const msg of client.fetch(
            range,
            // labels: true asks for X-GM-LABELS; ignored on servers without
            // X-GM-EXT-1, so it's safe to request unconditionally.
            // headers: [...] rides inside the same FETCH command as the
            // envelope — one round trip — and powers classifyDelivery
            // without ever needing the body. See CLASSIFY_HEADERS above.
            {
              envelope: true,
              internalDate: true,
              flags: true,
              labels: true,
              bodyStructure: true,
              size: true,
              headers: CLASSIFY_HEADERS as unknown as string[],
            },
            { uid: true },
          )) {
            const normalized = normalizeHeader(msg, folder, uidvalidity);
            if (!normalized) continue;
            if (msg.uid > maxUid) maxUid = msg.uid;
            state.folders[folder] = { uidvalidity, lastUid: maxUid };
            yield {
              message: normalized,
              nextCursor: { raw: { imap: state } },
            };
          }
          state.folders[folder] = { uidvalidity, lastUid: maxUid };
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  },

  async *listFromSender(account, senderAddress, since): AsyncIterable<RawMessage> {
    const client = await connect(account);
    try {
      const folders = await discoverFolders(
        client,
        account.imapExcludedFolders,
        account.imapIncludedFolders,
      );
      for (const folder of folders) {
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
          const searchRes = await client.search({ from: senderAddress, since }, { uid: true });
          const uids: number[] = Array.isArray(searchRes) ? searchRes : [];
          if (uids.length === 0) continue;
          for await (const msg of client.fetch(
            uids,
            // labels: true asks for X-GM-LABELS; ignored on servers without
            // X-GM-EXT-1, so it's safe to request unconditionally.
            // headers: [...] rides inside the same FETCH command as the
            // envelope — one round trip — and powers classifyDelivery
            // without ever needing the body. See CLASSIFY_HEADERS above.
            {
              envelope: true,
              internalDate: true,
              flags: true,
              labels: true,
              bodyStructure: true,
              size: true,
              headers: CLASSIFY_HEADERS as unknown as string[],
            },
            { uid: true },
          )) {
            const normalized = normalizeHeader(msg, folder, uidvalidity);
            if (normalized) yield normalized;
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  },

  async *listRecent(account, since): AsyncIterable<RawMessage> {
    const client = await connect(account);
    let remaining = RECENT_SCAN_CAP;
    try {
      const folders = await discoverFolders(
        client,
        account.imapExcludedFolders,
        account.imapIncludedFolders,
      );
      for (const folder of folders) {
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
          const searchRes = await client.search({ since }, { uid: true });
          let uids: number[] = Array.isArray(searchRes) ? searchRes : [];
          if (uids.length === 0) continue;
          // Highest UIDs are the most recent; cap per the remaining budget so a
          // busy mailbox can't make this interactive scan unbounded.
          uids = uids.slice(-remaining);
          for await (const msg of client.fetch(
            uids,
            {
              envelope: true,
              internalDate: true,
              flags: true,
              labels: true,
              bodyStructure: true,
              size: true,
              headers: CLASSIFY_HEADERS as unknown as string[],
            },
            { uid: true },
          )) {
            const normalized = normalizeHeader(msg, folder, uidvalidity);
            if (normalized) {
              remaining -= 1;
              yield normalized;
            }
            if (remaining <= 0) break;
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  },

  async fetchFull(account, providerMsgId): Promise<FullMessage> {
    const { folder, uidvalidity, uid } = decodeMsgId(providerMsgId);
    const client = await connect(account);
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') {
          throw new Error(`could not open folder ${folder}`);
        }
        if (Number(mbox.uidValidity) !== uidvalidity) {
          // uidvalidity rolled. The caller will surface this and let the
          // sync engine treat the providerMsgId as stale.
          throw new Error(
            `uidvalidity changed for ${folder}: expected ${uidvalidity}, got ${mbox.uidValidity}`,
          );
        }
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error(`message ${providerMsgId} not found`);
        const parsed = await simpleParser(msg.source);
        const attachments: RawAttachment[] = parsed.attachments.map((a, i) => ({
          // mailparser exposes `cid` but not a stable part id; index is fine
          // since we re-fetchFull only on demand and never reference the
          // attachment id externally.
          providerAttachmentId: `${providerMsgId}#${i}`,
          filename: a.filename ?? `unnamed-${i}`,
          mimeType: a.contentType,
          sizeBytes: a.size,
          content: a.content,
        }));
        return {
          bodyText: parsed.text || undefined,
          bodyHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
          attachments,
        };
      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  },
};

export interface ImapProbeResult {
  /** Server greeting (e.g. `* OK Dovecot ready.`). Surfaces the actual server in case of misconfig. */
  serverGreeting?: string;
  /** Top-level mailbox names — proof we're actually authenticated, not just connected. */
  folders: string[];
  /** Capability flags the server advertised. Useful debugging context. */
  capabilities: string[];
}

/** Verifies host/port/credentials by connecting, listing folders, then logging out.
 *  Used by the add-IMAP-account form for both the explicit "Test connection"
 *  button and the implicit pre-save check. */
export async function probeImapConnection(opts: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}): Promise<ImapProbeResult> {
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.pass },
    logger: false,
  });
  // Same reason as in `connect()` above — without an error listener, a
  // socket-level error during probe would crash the calling process
  // (Next.js worker thread or the test-connection request handler).
  client.on('error', (err) => {
    console.warn(
      '[imap] probe socket/protocol error -',
      err instanceof Error ? err.message : String(err),
    );
  });
  await client.connect();
  try {
    const mailboxes = await client.list();
    const folders = mailboxes
      .map((m) => m.path)
      .filter((p) => !!p)
      .sort();
    const caps = Array.from(
      (client.capabilities as Map<string, unknown> | undefined)?.keys() ?? [],
    );
    return {
      serverGreeting: client.serverInfo?.name ?? undefined,
      folders,
      capabilities: caps,
    };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Re-fetch the classification headers for a set of already-synced messages and
 * re-run `classifyDelivery` on them. This is the precise fix for legacy emails
 * stuck at `delivery_kind='unknown'` (synced before the classifier, and we never
 * stored raw headers, so they can't be reclassified offline). One IMAP round
 * trip per folder, BODY.PEEK only — never marks anything read, never touches
 * bodies.
 *
 * `refs` come from `decodeMsgId(providerMsgId)`. A folder whose live
 * `uidValidity` no longer matches the stored one is skipped (the UIDs are stale
 * — the message moved or the mailbox was recreated). Messages that no longer
 * exist simply don't come back. Returns a map keyed `folder:uid` → DeliveryKind;
 * absent keys mean "couldn't fetch" (caller leaves them as-is).
 */
export async function reclassifyByRefs(
  account: EmailAccount,
  refs: Array<{ folder: string; uidvalidity: number; uid: number }>,
): Promise<Map<string, DeliveryKind>> {
  const out = new Map<string, DeliveryKind>();
  if (refs.length === 0) return out;

  const byFolder = new Map<string, Array<{ uidvalidity: number; uid: number }>>();
  for (const r of refs) {
    const arr = byFolder.get(r.folder) ?? [];
    arr.push({ uidvalidity: r.uidvalidity, uid: r.uid });
    byFolder.set(r.folder, arr);
  }

  const client = await connect(account);
  try {
    for (const [folder, items] of byFolder) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        console.warn('[imap] reclassify: skip folder', folder, (err as Error).message);
        continue;
      }
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') continue;
        const liveValidity = Number(mbox.uidValidity);
        const uids = items.filter((i) => i.uidvalidity === liveValidity).map((i) => i.uid);
        if (uids.length === 0) continue; // all stale for this folder
        for await (const msg of client.fetch(
          uids,
          {
            envelope: true,
            flags: true,
            labels: true,
            headers: CLASSIFY_HEADERS as unknown as string[],
          },
          { uid: true },
        )) {
          const env = msg.envelope;
          const fromAddr = env?.from?.[0]?.address?.toLowerCase();
          if (!fromAddr) continue;
          const flagLabels = msg.flags ? Array.from(msg.flags) : [];
          const gmailLabels = msg.labels ? Array.from(msg.labels) : [];
          const labels =
            gmailLabels.length > 0
              ? Array.from(new Set([...flagLabels, ...gmailLabels]))
              : flagLabels;
          const headerMap = parseHeaderBlock(
            (msg as FetchMessageObject & { headers?: Buffer | string }).headers,
          );
          out.set(
            `${folder}:${msg.uid}`,
            classifyDelivery({ headers: headerMap, fromAddr, labels }),
          );
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
  return out;
}
