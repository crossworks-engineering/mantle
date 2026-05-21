import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { open } from '@mantle/crypto';
import type { EmailAccount } from '@mantle/db';
import { parseAddress, parseAddressList } from '../addresses';
import type {
  EmailProvider,
  FullMessage,
  RawAttachment,
  RawAttachmentRef,
  RawMessage,
  SyncCursor,
} from '../types';

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
  return JSON.parse(open(account.imapConfigEnc, `imap:${account.userId}:${account.address}`)) as ImapCredentials;
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
  await client.connect();
  return client;
}

function encodeMsgId(folder: string, uidvalidity: number, uid: number): string {
  // folders can contain `:` (e.g. nested IMAP folders). Encode that.
  const safeFolder = folder.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  return `${safeFolder}:${uidvalidity}:${uid}`;
}

function decodeMsgId(providerMsgId: string): { folder: string; uidvalidity: number; uid: number } {
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
          ((node as { subtype?: string }).subtype ? '/' + (node as { subtype?: string }).subtype : ''),
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

  return {
    providerMsgId,
    threadId: env.inReplyTo ?? undefined,
    fromAddr,
    fromName: fromRaw?.name || undefined,
    toAddrs: (env.to ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    ccAddrs: (env.cc ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    bccAddrs: (env.bcc ?? []).map((a) => a.address?.toLowerCase() ?? '').filter(Boolean),
    subject: env.subject ?? undefined,
    internalDate: date,
    labels: msg.flags ? Array.from(msg.flags) : [],
    folder,
    isRead: msg.flags?.has('\\Seen') ?? false,
    isStarred: msg.flags?.has('\\Flagged') ?? false,
    sizeBytes: msg.size,
    hasAttachments: attachments.length > 0,
    attachments,
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
            { envelope: true, internalDate: true, flags: true, bodyStructure: true, size: true },
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
            { envelope: true, internalDate: true, flags: true, bodyStructure: true, size: true },
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
  await client.connect();
  try {
    const mailboxes = await client.list();
    const folders = mailboxes
      .map((m) => m.path)
      .filter((p) => !!p)
      .sort();
    const caps = Array.from((client.capabilities as Map<string, unknown> | undefined)?.keys() ?? []);
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
