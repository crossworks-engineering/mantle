import {
  db,
  emailAccounts,
  emailAttachments,
  emails,
  ingestRules,
  nodes,
  syncRuns,
  type EmailAccount,
  type NewEmail,
  type NewEmailAttachment,
  type NewNode,
} from '@mantle/db';
import { runRules } from '@mantle/rules';
import { hashBuffer, putContent } from '@mantle/storage';
import { and, eq, or, sql } from 'drizzle-orm';
import { SenderResolver, upsertSenders } from './decisions';
import type { EmailProvider, RawMessage } from './types';

const PAGE_SIZE = 50;

/**
 * Thrown from inside `ingestOne`'s transaction when the emails INSERT hits
 * the (account_id, provider_msg_id) unique index — i.e. another sync attempt
 * for the same message committed between our pre-check SELECT and this
 * transaction's commit. Caught at the boundary so the transaction rolls back
 * (no orphan node) AND the surrounding pg-boss job succeeds (same observable
 * outcome as the pre-check finding the row, just later in the pipeline).
 */
class DuplicateRaceError extends Error {
  constructor(public providerMsgId: string) {
    super(`race: ${providerMsgId} was inserted by a concurrent sync`);
    this.name = 'DuplicateRaceError';
  }
}

/**
 * The two-phase pipeline. For each batch from the provider:
 *
 *   1. Upsert every From address into `email_senders` so the UI knows
 *      who's writing — even denied/pending senders are visible.
 *   2. Resolve the effective decision (address > domain > policy default).
 *   3. For approved senders only: call provider.fetchFull, run ingest
 *      rules, persist `nodes` + `emails` + `email_attachments`, upload
 *      attachment bytes to object storage via @mantle/storage.
 *   4. Bump the account's sync cursor after the batch.
 *
 * Pending / denied messages contribute to `email_senders.message_count`
 * but never touch your inbox or your disk beyond that one row.
 */
export async function syncAccount(account: EmailAccount, provider: EmailProvider): Promise<{
  scanned: number;
  ingested: number;
  newSenders: number;
}> {
  // Open the run record up-front so "is sync alive right now?" is
  // answerable by `select * from sync_runs where status='running'`.
  const [run] = await db
    .insert(syncRuns)
    .values({ accountId: account.id })
    .returning({ id: syncRuns.id });
  if (!run) throw new Error('failed to open sync_runs row');

  const resolver = await SenderResolver.load(account.userId, account.ingestPolicy);
  const rules = await db
    .select()
    .from(ingestRules)
    .where(and(eq(ingestRules.userId, account.userId), eq(ingestRules.enabled, true)));

  let scanned = 0;
  let ingested = 0;
  let newSenders = 0;

  let buffer: RawMessage[] = [];
  let lastCursor: { raw: Record<string, unknown> } | undefined;

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    // 1. upsert senders for everyone we just saw. The resolver decides the
    //    initial status for first-time senders, so a domain you've already
    //    denied keeps new addresses out of Pending automatically.
    const seen = batch.map((m) => ({
      address: m.fromAddr,
      displayName: m.fromName,
      internalDate: m.internalDate,
    }));
    for (const m of batch) if (!resolver.has(m.fromAddr)) newSenders += 1;
    await upsertSenders(account.userId, account.id, seen, resolver);

    // After upsert the resolver's address index is stale for never-seen-
    // before senders. Mirror them so subsequent decide() calls within this
    // sync run see them as known (status defaults to 'pending').
    for (const m of batch) resolver.noteSeen(m.fromAddr);

    // 2-3. Ingest approved messages.
    for (const message of batch) {
      scanned += 1;
      if (resolver.decide(message.fromAddr) !== 'approved') continue;
      const ok = await ingestOne(account, provider, message, rules);
      if (ok) ingested += 1;
    }

    // 4. Persist cursor after each flush.
    if (lastCursor) {
      await db
        .update(emailAccounts)
        .set({
          syncState: lastCursor.raw as Record<string, unknown>,
          lastSyncAt: new Date(),
          lastSyncError: null,
        })
        .where(eq(emailAccounts.id, account.id));
    }
  };

  try {
    for await (const { message, nextCursor } of provider.listSince(
      account,
      account.syncState ? { raw: account.syncState } : undefined,
    )) {
      buffer.push(message);
      lastCursor = nextCursor;
      if (buffer.length >= PAGE_SIZE) await flush();
    }
    await flush();
  } catch (err) {
    const message = (err as Error).message;
    await Promise.all([
      db
        .update(emailAccounts)
        .set({ lastSyncError: message })
        .where(eq(emailAccounts.id, account.id)),
      db
        .update(syncRuns)
        .set({
          status: 'error',
          finishedAt: new Date(),
          scanned,
          ingested,
          newSenders,
          error: message,
        })
        .where(eq(syncRuns.id, run.id)),
    ]);
    throw err;
  }

  await db
    .update(syncRuns)
    .set({ status: 'ok', finishedAt: new Date(), scanned, ingested, newSenders })
    .where(eq(syncRuns.id, run.id));

  return { scanned, ingested, newSenders };
}

/** Insert one approved message. Idempotent on (account_id, provider_msg_id). */
async function ingestOne(
  account: EmailAccount,
  provider: EmailProvider,
  message: RawMessage,
  rules: Awaited<ReturnType<typeof db.select> extends never ? never : Awaited<ReturnType<typeof loadRules>>>,
): Promise<boolean> {
  // Dedup pre-check. Two unique constraints, two checks (OR'd in one query):
  //   1. (account_id, provider_msg_id) — same UID in same folder. Catches
  //      crash-retry / restart-replay races.
  //   2. (account_id, rfc_message_id)  — same RFC 5322 Message-ID across any
  //      folder. Catches the cross-folder duplication case (INBOX ↔ Archive,
  //      any-folder ↔ [Gmail]/All Mail). rfcMessageId may be undefined on
  //      older mail / weird automated mail; check only when populated.
  // The HARD guarantees are the unique indexes + onConflictDoNothing +
  // DuplicateRaceError sentinel on the INSERT below — the SELECT here is a
  // fast path that avoids spending OpenRouter on rule evaluation + an
  // attachment fetch we'd just throw away.
  const providerCond = eq(emails.providerMsgId, message.providerMsgId);
  const rfcCond = message.rfcMessageId
    ? eq(emails.rfcMessageId, message.rfcMessageId)
    : undefined;
  const dupCond = rfcCond ? or(providerCond, rfcCond) : providerCond;
  const [existing] = await db
    .select({ id: emails.id })
    .from(emails)
    .where(and(eq(emails.accountId, account.id), dupCond))
    .limit(1);
  if (existing) return false;

  // Run rules to compute effects (tags, branch path).
  const effects = runRules(rules, {
    fromAddr: message.fromAddr,
    toAddrs: message.toAddrs,
    subject: message.subject,
    labels: message.labels,
    hasAttachment: message.hasAttachments,
  });

  // Branch path is stored per-account so different `jason@…` accounts can
  // coexist without colliding under `inbox.jason`. Rules may still override
  // for routing into a project sub-branch.
  const path = effects.movePath ?? account.branchPath;
  await ensureBranchPath(account.userId, path);

  // Phase 2: deep fetch.
  const full = await provider.fetchFull(account, message.providerMsgId);

  // Insert node + email + attachments inside a transaction. Race handling:
  // the emails INSERT uses `onConflictDoNothing` on (account_id,
  // provider_msg_id); if another sync attempt committed the same message
  // between our pre-check SELECT and now, the INSERT returns 0 rows and we
  // throw DuplicateRaceError. The catch around the transaction below treats
  // it as "already exists" — same outcome as the SELECT fast-path.
  try {
    await db.transaction(async (tx) => {
      const nodeId = await insertEmailNode(tx, {
        ownerId: account.userId,
        path,
        title: message.subject ?? '(no subject)',
        tags: [...effects.addTags],
        message,
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
        subject: message.subject ?? null,
        snippet: message.snippet ?? null,
        bodyText: full.bodyText ?? null,
        bodyHtml: full.bodyHtml ?? null,
        internalDate: message.internalDate,
        labels: message.labels ?? [],
        folder: message.folder ?? null,
        isRead: effects.markRead ?? message.isRead ?? false,
        isStarred: message.isStarred ?? false,
        hasAttachments: full.attachments.length > 0,
        sizeBytes: message.sizeBytes ?? null,
      };
      const [insertedEmail] = await tx
        .insert(emails)
        .values(emailRow)
        // No target → Postgres DO NOTHING on ANY unique constraint violation,
        // covering BOTH dedup keys (folder-scoped provider_msg_id AND
        // cross-folder rfc_message_id) in one go. A targeted variant would
        // need separate handling per key.
        .onConflictDoNothing()
        .returning({ id: emails.id });
      if (!insertedEmail) {
        // Race: another sync attempt committed this message between our
        // pre-check SELECT and this INSERT (either same providerMsgId, or
        // same rfcMessageId on a different folder). Throw so the transaction
        // rolls back the node + any attachments cleanly; caught below.
        throw new DuplicateRaceError(message.providerMsgId);
      }

      // Attachments: upload bytes (content-addressed dedupe in storage),
      // create one file node per unique sha256, link via email_attachments.
      for (const att of full.attachments) {
        const sha256 = hashBuffer(att.content);
        const fileNodeId = await getOrCreateFileNode(tx, {
          ownerId: account.userId,
          path: `${path}.attachments`,
          sha256,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes ?? att.content.byteLength,
        });
        const { key } = await putContent(att.content, att.mimeType ?? 'application/octet-stream');
        const row: NewEmailAttachment = {
          emailId: insertedEmail.id,
          fileNodeId,
          filename: att.filename,
          mimeType: att.mimeType ?? null,
          sizeBytes: att.sizeBytes ?? att.content.byteLength,
          sha256,
          storageKey: key,
          extractedText: null, // populated by the text-extraction worker later.
        };
        await tx.insert(emailAttachments).values(row);
      }
    });
  } catch (err) {
    if (err instanceof DuplicateRaceError) {
      // Race condition: another sync attempt committed the same message
      // first. The transaction has rolled back (no orphan node /
      // attachments); treat as "already exists" — same outcome as the
      // pre-check SELECT, so the pg-boss job succeeds.
      return false;
    }
    throw err;
  }

  return true;
}

async function loadRules(userId: string) {
  return db.select().from(ingestRules).where(eq(ingestRules.userId, userId));
}


/** Make sure every ltree label on `path` has a branch node so the tree
 *  navigator can render it. Idempotent — relies on the partial unique
 *  index `nodes_branch_owner_path_uq` introduced in migration 0003. */
async function ensureBranchPath(ownerId: string, path: string): Promise<void> {
  const segments = path.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    await db
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
  }
}

function prettyTitle(slug: string): string {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function insertEmailNode(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    ownerId: string;
    path: string;
    title: string;
    tags: string[];
    message: RawMessage;
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
      data: {
        fromAddr: args.message.fromAddr,
        fromName: args.message.fromName,
        internalDate: args.message.internalDate.toISOString(),
      },
    } as NewNode)
    .returning({ id: nodes.id });
  if (!row) throw new Error('insert into nodes returned no row');
  return row.id;
}

async function getOrCreateFileNode(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    ownerId: string;
    path: string;
    sha256: string;
    filename: string;
    mimeType?: string;
    sizeBytes: number;
  },
): Promise<string> {
  // Look up an existing file node for this sha256 (owner-scoped dedupe).
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
      data: {
        sha256: args.sha256,
        mimeType: args.mimeType,
        sizeBytes: args.sizeBytes,
      },
    } as NewNode)
    .returning({ id: nodes.id });
  if (!row) throw new Error('insert into nodes (file) returned no row');
  return row.id;
}

/**
 * Backfill the last 90 days from a just-approved sender. Runs the same
 * ingest path as `syncAccount` but uses the provider's per-sender search
 * so we don't re-scan the whole mailbox.
 */
const BACKFILL_DAYS = 90;

export async function backfillSender(
  account: EmailAccount,
  provider: EmailProvider,
  senderAddress: string,
): Promise<{ ingested: number }> {
  const rules = await loadRules(account.userId);
  const since = new Date();
  since.setDate(since.getDate() - BACKFILL_DAYS);

  let ingested = 0;
  for await (const message of provider.listFromSender(account, senderAddress, since)) {
    // Skip anything where the From doesn't actually match (some IMAP
    // servers loosely match `from:` against the whole envelope).
    if (message.fromAddr.toLowerCase() !== senderAddress.toLowerCase()) continue;
    const ok = await ingestOne(account, provider, message, rules);
    if (ok) ingested += 1;
  }
  return { ingested };
}
