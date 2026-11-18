/**
 * The brain's half of mail sync (Sync service plan M2; docs/email-ingest.md).
 * The Sync sidecar reads the mailbox; this module decides and stores:
 *
 *   1. gateEnvelopes: which listed messages the brain wants. A message is
 *      wanted when its sender passes the contacts gate (the SOLE inbound
 *      allowlist, loadContactGate in @mantle/content), it is not a client
 *      sign-in code mail, and the account does not hold it yet (the same
 *      folder UID, or the same RFC Message-ID in any folder). Mail from
 *      anyone else is never fetched and leaves no trace.
 *   2. ingestWireMessage: one wanted message, fetched in full: ingest rules,
 *      the email node, the emails row, attachments as file nodes. Idempotent
 *      on both dedup keys (the unique indexes hold it under a race).
 *   3. recordMailRun: the run's numbers and error for the account's status.
 *
 * This is the old `syncAccount` / `ingestOne` (packages/email sync.ts before
 * M4), with the IMAP fetch moved out to the sidecar.
 */
import {
  EMAIL_ATTACHMENT_MARK,
  db,
  emailAccounts,
  emailAttachments,
  emails,
  ingestRules,
  nodes,
  onFullSystemRoute,
  syncRuns,
  withDeadlockRetry,
  withNodeInsertHeads,
  type Db,
  type EmailAccount,
  type NewEmail,
  type NewEmailAttachment,
  type NewNode,
} from '@mantle/db';
import { runRules } from '@mantle/rules';
import { hashBuffer } from '@mantle/storage';
import { stageFileObject } from '@mantle/files/broker';
import { loadContactGate } from '@mantle/content';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { ConflictError } from '@mantle/std';
import { accountBranchPath } from './accounts';
import { redactSigninCodes, touchesClientCodeMail } from './client-code-mail';
import { salienceForDeliveryKind } from './classify';
import type { WireEnvelope, WireMessage, WireRun } from './wire';

/** The longest error text an account's status keeps. */
const RUN_ERROR_MAX = 500;

class DuplicateRaceError extends Error {
  constructor(public providerMsgId: string) {
    super(`race: ${providerMsgId} was inserted by a concurrent sync`);
    this.name = 'DuplicateRaceError';
  }
}

/** The owner's mailbox row for a sidecar account, or null. */
export async function mailboxOf(ownerId: string, accountId: string): Promise<EmailAccount | null> {
  const [row] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, ownerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Make or update the mailbox row a sidecar account's mail lands under. The
 * row holds no credential (the sidecar keeps those, sealed, in
 * service_state): its address, name, branch path and switch. An address the
 * owner had before gets its old row back, so its stored mail stays linked.
 * The id the sidecar keys the account by.
 */
export async function saveMailbox(
  ownerId: string,
  input: {
    address: string;
    displayName?: string | null;
    enabled?: boolean;
    /** 'imap' (default) or 'microsoft' (an Outlook inbox, Sync plan M3). */
    provider?: 'imap' | 'microsoft';
    /** Where a new row's mail lands; default from the address. */
    branchPath?: string;
  },
): Promise<string> {
  const address = input.address.trim().toLowerCase();
  const provider = input.provider ?? 'imap';
  const [existing] = await db
    .select({ id: emailAccounts.id, provider: emailAccounts.provider })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.address, address)))
    .limit(1);
  // One address, one way in: an IMAP mailbox and an Outlook inbox never
  // share a row (switching one off would switch the other off). An old row
  // of the same kind comes back, so its stored mail stays linked.
  if (existing && existing.provider !== provider) {
    throw new ConflictError(
      `${address} is linked as ${existing.provider === 'microsoft' ? 'a Microsoft account' : 'a mailbox'} already. Remove that first.`,
    );
  }
  if (existing) {
    await db
      .update(emailAccounts)
      .set({
        displayName: input.displayName ?? null,
        enabled: input.enabled ?? true,
        updatedAt: new Date(),
      })
      .where(eq(emailAccounts.id, existing.id));
    return existing.id;
  }
  // A mailbox made (its branch path and provider): the full-route spot
  // mail-account (access-matrix.ts NARROW_NEVER_INSERT).
  const [row] = await onFullSystemRoute('mail-account', () =>
    db
      .insert(emailAccounts)
      .values({
        userId: ownerId,
        provider,
        address,
        displayName: input.displayName ?? null,
        ingestPolicy: 'approve_list',
        branchPath: input.branchPath ?? accountBranchPath(address),
        enabled: input.enabled ?? true,
      })
      .returning({ id: emailAccounts.id }),
  );
  if (!row) throw new Error('insert into email_accounts returned no row');
  return row.id;
}

/** Switch a mailbox off (the sidecar removed its account). Its stored mail
 *  stays, readable and searchable. */
export async function disableMailbox(ownerId: string, accountId: string): Promise<boolean> {
  const rows = await db
    .update(emailAccounts)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, ownerId)))
    .returning({ id: emailAccounts.id });
  return rows.length > 0;
}

/**
 * The providerMsgIds of `envelopes` the brain wants fetched: the sender
 * passes the contacts gate, it is no client sign-in code mail, and the
 * account does not hold it yet.
 */
export async function gateEnvelopes(
  account: EmailAccount,
  envelopes: readonly WireEnvelope[],
): Promise<string[]> {
  if (envelopes.length === 0) return [];
  const gate = await loadContactGate(account.userId);
  const candidates = envelopes.filter((e) => gate.allows(e.fromAddr) && !touchesClientCodeMail(e));
  if (candidates.length === 0) return [];

  const providerIds = candidates.map((e) => e.providerMsgId);
  const rfcIds = candidates.map((e) => e.rfcMessageId).filter((v): v is string => !!v);
  const held = await db
    .select({ providerMsgId: emails.providerMsgId, rfcMessageId: emails.rfcMessageId })
    .from(emails)
    .where(
      and(
        eq(emails.accountId, account.id),
        rfcIds.length > 0
          ? or(inArray(emails.providerMsgId, providerIds), inArray(emails.rfcMessageId, rfcIds))
          : inArray(emails.providerMsgId, providerIds),
      ),
    );
  const heldProvider = new Set(held.map((h) => h.providerMsgId));
  const heldRfc = new Set(held.map((h) => h.rfcMessageId).filter((v): v is string => !!v));
  const wanted: string[] = [];
  const seenRfc = new Set<string>();
  for (const e of candidates) {
    if (heldProvider.has(e.providerMsgId)) continue;
    if (e.rfcMessageId && (heldRfc.has(e.rfcMessageId) || seenRfc.has(e.rfcMessageId))) continue;
    if (e.rfcMessageId) seenRfc.add(e.rfcMessageId);
    wanted.push(e.providerMsgId);
  }
  return wanted;
}

/** Store one fetched message. True when it was stored, false when the
 *  account already holds it, the gate refuses it, or it is a client
 *  sign-in code mail. */
export async function ingestWireMessage(
  account: EmailAccount,
  message: WireMessage,
): Promise<boolean> {
  if (message.clientCodeMail || touchesClientCodeMail(message)) return false;
  // The gate again: a message posted for ingest is judged by the same rule,
  // whatever the gate answered before.
  const gate = await loadContactGate(account.userId);
  if (!gate.allows(message.fromAddr)) return false;

  const providerCond = eq(emails.providerMsgId, message.providerMsgId);
  const rfcCond = message.rfcMessageId ? eq(emails.rfcMessageId, message.rfcMessageId) : undefined;
  const dupCond = rfcCond ? or(providerCond, rfcCond) : providerCond;
  const [existing] = await db
    .select({ id: emails.id })
    .from(emails)
    .where(and(eq(emails.accountId, account.id), dupCond))
    .limit(1);
  if (existing) return false;

  const internalDate = new Date(message.internalDate);
  if (Number.isNaN(internalDate.getTime())) throw new Error('invalid internalDate');

  const rules = await db
    .select()
    .from(ingestRules)
    .where(and(eq(ingestRules.userId, account.userId), eq(ingestRules.enabled, true)));
  const effects = runRules(rules, {
    fromAddr: message.fromAddr,
    toAddrs: message.toAddrs,
    subject: message.subject,
    labels: message.labels,
    hasAttachment: message.attachments.length > 0,
  });

  const path = effects.movePath ?? account.branchPath;
  await ensureBranchPath(account.userId, path);

  const attachments = message.attachments.map((a) => ({
    ...a,
    content: Buffer.from(a.contentB64, 'base64'),
  }));

  // The attachments' bytes first, under their content address (the files
  // store's broker), never inside the transaction (a network write).
  const stagedKeys: string[] = [];
  for (const att of attachments) {
    const { key } = await stageFileObject(att.content, att.mimeType ?? 'application/octet-stream');
    stagedKeys.push(key);
  }

  const headItems = [
    { type: 'email', path },
    ...(attachments.length > 0 ? [{ type: 'file', path: `${path}.attachments` }] : []),
  ];
  try {
    await withNodeInsertHeads(account.userId, headItems, async (tx) => {
      const nodeId = await insertEmailNode(tx, {
        ownerId: account.userId,
        path,
        title: redactSigninCodes(message.subject) ?? '(no subject)',
        tags: [...effects.addTags],
        message,
        internalDate,
      });

      const emailRow: NewEmail = {
        nodeId,
        accountId: account.id,
        providerMsgId: message.providerMsgId,
        rfcMessageId: message.rfcMessageId ?? null,
        threadId: message.threadId,
        fromAddr: message.fromAddr,
        fromName: message.fromName ?? null,
        toAddrs: message.toAddrs,
        ccAddrs: message.ccAddrs ?? [],
        bccAddrs: message.bccAddrs ?? [],
        // A sign-in link's code is blanked in everything stored.
        subject: redactSigninCodes(message.subject) ?? null,
        snippet: redactSigninCodes(message.snippet) ?? null,
        bodyText: redactSigninCodes(message.bodyText) ?? null,
        bodyHtml: redactSigninCodes(message.bodyHtml) ?? null,
        internalDate,
        labels: message.labels ?? [],
        folder: message.folder ?? null,
        isRead: effects.markRead ?? message.isRead ?? false,
        isStarred: message.isStarred ?? false,
        hasAttachments: attachments.length > 0,
        sizeBytes: message.sizeBytes ?? null,
        deliveryKind: message.deliveryKind ?? 'unknown',
      };
      const [insertedEmail] = await tx
        .insert(emails)
        .values(emailRow)
        // No target: DO NOTHING on either dedup key.
        .onConflictDoNothing()
        .returning({ id: emails.id });
      if (!insertedEmail) throw new DuplicateRaceError(message.providerMsgId);

      for (const [i, att] of attachments.entries()) {
        const sha256 = hashBuffer(att.content);
        const fileNodeId = await getOrCreateFileNode(tx, {
          ownerId: account.userId,
          path: `${path}.attachments`,
          sha256,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes ?? att.content.byteLength,
        });
        const row: NewEmailAttachment = {
          emailId: insertedEmail.id,
          fileNodeId,
          filename: att.filename,
          mimeType: att.mimeType ?? null,
          sizeBytes: att.sizeBytes ?? att.content.byteLength,
          sha256,
          storageKey: stagedKeys[i]!,
          extractedText: null,
        };
        await tx.insert(emailAttachments).values(row);
      }
    });
  } catch (err) {
    if (err instanceof DuplicateRaceError) return false;
    throw err;
  }
  return true;
}

/** One finished run of an account: a sync_runs row and the account's last
 *  sync stamp or error. */
export async function recordMailRun(account: EmailAccount, run: WireRun): Promise<void> {
  const error = run.error ? run.error.slice(0, RUN_ERROR_MAX) : null;
  const now = new Date();
  const started = run.startedAt ? new Date(run.startedAt) : now;
  await db.insert(syncRuns).values({
    accountId: account.id,
    startedAt: Number.isNaN(started.getTime()) || started > now ? now : started,
    finishedAt: now,
    status: error ? 'error' : 'ok',
    scanned: Math.max(0, Math.floor(run.scanned)),
    ingested: Math.max(0, Math.floor(run.ingested)),
    error,
  });
  await db
    .update(emailAccounts)
    .set(error ? { lastSyncError: error } : { lastSyncAt: now, lastSyncError: null })
    .where(eq(emailAccounts.id, account.id));
}

/** Make sure every ltree label on `path` has a branch node. Idempotent.
 *  The Sync service's file route places a drive's files with it too. */
export async function ensureBranchPath(ownerId: string, path: string): Promise<void> {
  const segments = path.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    await withDeadlockRetry(() =>
      withNodeInsertHeads(ownerId, [{ type: 'branch', path: prefix }], async (tx) => {
        await tx
          .insert(nodes)
          .values({
            ownerId,
            type: 'branch',
            title: prettyTitle(segments[i - 1]!),
            path: prefix,
            data: {},
          } as NewNode)
          .onConflictDoNothing({
            target: [nodes.ownerId, nodes.path],
            where: sql`${nodes.type} = 'branch'`,
          });
      }),
    );
  }
}

function prettyTitle(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** @heads-held by ingestWireMessage (withNodeInsertHeads on the email's folder). */
async function insertEmailNode(
  tx: Db,
  args: {
    ownerId: string;
    path: string;
    title: string;
    tags: string[];
    message: WireMessage;
    internalDate: Date;
  },
): Promise<string> {
  const [row] = await tx
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'email',
      title: args.title,
      path: args.path,
      tags: args.tags,
      // Down-weight bulk mail at retrieval.
      salience: salienceForDeliveryKind(args.message.deliveryKind ?? 'unknown'),
      data: {
        fromAddr: args.message.fromAddr,
        fromName: args.message.fromName,
        internalDate: args.internalDate.toISOString(),
      },
    } as NewNode)
    .returning({ id: nodes.id });
  if (!row) throw new Error('insert into nodes returned no row');
  return row.id;
}

/** @heads-held by ingestWireMessage (withNodeInsertHeads on the attachments folder). */
async function getOrCreateFileNode(
  tx: Db,
  args: {
    ownerId: string;
    path: string;
    sha256: string;
    filename: string;
    mimeType?: string;
    sizeBytes: number;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        eq(nodes.type, 'file'),
        sql`${nodes.data}->>'sha256' = ${args.sha256}`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [row] = await tx
    .insert(nodes)
    .values({
      ownerId: args.ownerId,
      type: 'file',
      title: args.filename,
      path: args.path,
      tags: [],
      // Deliberately NO `data.filename`: attachment nodes are
      // content-addressed, so two files may share one name in the same
      // attachments folder, and `file_filename_in_parent_uq` covers only
      // nodes that carry the key (see the note in the old sync.ts).
      data: {
        sha256: args.sha256,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
        [EMAIL_ATTACHMENT_MARK]: true,
      },
    } as NewNode)
    .returning({ id: nodes.id });
  if (!row) throw new Error('insert into nodes (file) returned no row');
  return row.id;
}
