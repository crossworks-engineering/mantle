/**
 * One-shot backfill: populate `emails.rfc_message_id` on rows that were
 * ingested before migration 0045 (the cross-folder dedup column).
 *
 * The story: migration 0045 added `rfc_message_id` (the RFC 5322 Message-ID
 * header) + a partial unique index on (account_id, rfc_message_id) for
 * cross-folder dedup — the Gmail All Mail / INBOX↔Archive UID-churn case
 * (see docs/email-ingest.md §4–6). All ingests since 0045 populate the
 * column, but pre-0045 rows have NULL and miss out on the dedup. This
 * script closes that gap: header-only IMAP-fetches the legacy rows in
 * batched UID lists (one mailbox lock per folder, one connection per
 * account, one UID range fetch per folder), extracts envelope.messageId,
 * and UPDATEs. Idempotent — run repeatedly, it only touches rows still
 * NULL.
 *
 * Failure modes — all surfaced in the final report, none fatal:
 *   - **missing**:    message gone from server (deleted server-side after
 *                     ingest) OR no Message-ID header. Row stays NULL.
 *   - **uidv_drift**: the folder's uidvalidity rolled since ingest, so the
 *                     stored UID no longer points at the same message. Row
 *                     stays NULL.
 *   - **collision**:  Message-ID matches a row that already had the value
 *                     (a modern row inserted via the normal sync path).
 *                     Confirmed duplicate; legacy row stays NULL by design.
 *   - **bad_msg_id**: stored providerMsgId fails to decode. Row stays NULL.
 *
 * Run:  pnpm -C packages/email backfill:rfc-msg-id
 */

import { and, eq, isNull, sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ImapFlow } from 'imapflow';
import { emails, emailAccounts, type EmailAccount } from '@mantle/db';
import { decodeMsgId, normalizeRfcMessageId, unsealImapPassword } from './providers/imap';

interface BackfillRow {
  id: string;
  providerMsgId: string;
}

interface AccountResult {
  account: string;
  updated: number;
  collision: number;
  missing: number;
  uidvDrift: number;
  badMsgId: number;
}

function maskEmail(address: string): string {
  return address.replace(/^(.).+@(.+)$/, '$1***@$2');
}

async function backfillAccount(
  account: EmailAccount,
  rows: BackfillRow[],
  db: ReturnType<typeof drizzle>,
): Promise<AccountResult> {
  const masked = maskEmail(account.address);
  console.log(`[backfill] ${masked}: ${rows.length} legacy rows`);

  if (!account.imapHost || !account.imapPort) {
    console.warn(`[backfill] ${masked}: no IMAP config; skipping`);
    return {
      account: account.address,
      updated: 0,
      collision: 0,
      missing: 0,
      uidvDrift: 0,
      badMsgId: rows.length,
    };
  }

  // Group legacy rows by IMAP folder so we can lock + range-fetch per folder
  // instead of one round-trip per row.
  type FolderBatch = { uidvalidity: number; uidToRowId: Map<number, string> };
  const byFolder = new Map<string, FolderBatch>();
  let badMsgId = 0;
  for (const row of rows) {
    try {
      const { folder, uidvalidity, uid } = decodeMsgId(row.providerMsgId);
      let batch = byFolder.get(folder);
      if (!batch) {
        batch = { uidvalidity, uidToRowId: new Map() };
        byFolder.set(folder, batch);
      } else if (batch.uidvalidity !== uidvalidity) {
        // Two rows for the same folder with different uidvalidities — the
        // older one is from before a server rollover. Skip it; the newer
        // batch will fetch normally.
        badMsgId++;
        continue;
      }
      batch.uidToRowId.set(uid, row.id);
    } catch {
      badMsgId++;
    }
  }

  const password = unsealImapPassword(account);
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.address, pass: password },
    logger: false,
  });
  client.on('error', (err) => {
    console.warn(
      `[backfill] ${masked} imap error:`,
      err instanceof Error ? err.message : String(err),
    );
  });
  await client.connect();

  let updated = 0;
  let collision = 0;
  let missing = 0;
  let uidvDrift = 0;

  try {
    for (const [folder, batch] of byFolder) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        console.warn(
          `[backfill] ${masked}: folder ${folder} unreachable —`,
          err instanceof Error ? err.message : err,
        );
        missing += batch.uidToRowId.size;
        continue;
      }
      try {
        const mbox = client.mailbox;
        if (!mbox || typeof mbox === 'boolean') continue;
        const serverUidv = Number(mbox.uidValidity);
        if (serverUidv !== batch.uidvalidity) {
          console.warn(
            `[backfill] ${masked}: ${folder} uidvalidity drift (${batch.uidvalidity} → ${serverUidv}); skipping ${batch.uidToRowId.size} rows`,
          );
          uidvDrift += batch.uidToRowId.size;
          continue;
        }

        const uids = [...batch.uidToRowId.keys()];
        const seen = new Set<number>();
        // Envelope-only fetch — cheap; this is exactly what listSince uses
        // for the lightweight header pass.
        for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
          seen.add(msg.uid);
          const rowId = batch.uidToRowId.get(msg.uid);
          if (!rowId) continue;
          const rfcId = normalizeRfcMessageId(msg.envelope?.messageId);
          if (!rfcId) {
            missing++;
            continue;
          }
          try {
            await db
              .update(emails)
              .set({ rfcMessageId: rfcId, updatedAt: new Date() })
              .where(and(eq(emails.id, rowId), isNull(emails.rfcMessageId)));
            // The WHERE-IS-NULL clause is the idempotency guard: a re-run on
            // an already-populated row no-ops instead of churning updated_at.
            updated++;
          } catch (err) {
            // 23505 = unique constraint violation = another row in this
            // account already has this rfc_message_id. Known cross-folder
            // duplicate; legacy row stays NULL by design.
            const code = (err as { code?: string })?.code;
            if (code === '23505') {
              collision++;
            } else {
              console.error('[backfill] update failed for', rowId, err);
            }
          }
        }
        // UIDs we asked for but didn't get back = message gone server-side.
        for (const uid of uids) {
          if (!seen.has(uid)) missing++;
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

  return { account: account.address, updated, collision, missing, uidvDrift, badMsgId };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  const conn = postgres(url, { max: 4, prepare: false });
  const db = drizzle(conn);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' rfc_message_id backfill — populating legacy rows');
  console.log('═══════════════════════════════════════════════════════════');

  // Per-account legacy count up-front, so the operator knows the scope
  // before any IMAP work starts.
  const accountsToProcess = await db
    .select({
      id: emailAccounts.id,
      address: emailAccounts.address,
    })
    .from(emailAccounts)
    .where(eq(emailAccounts.enabled, true));

  const results: AccountResult[] = [];
  for (const accountRef of accountsToProcess) {
    const [account] = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, accountRef.id))
      .limit(1);
    if (!account) continue;

    const rows = await db
      .select({ id: emails.id, providerMsgId: emails.providerMsgId })
      .from(emails)
      .where(and(eq(emails.accountId, account.id), isNull(emails.rfcMessageId)));
    if (rows.length === 0) {
      console.log(`[backfill] ${maskEmail(account.address)}: 0 legacy rows — nothing to do`);
      continue;
    }
    const r = await backfillAccount(account, rows, db);
    results.push(r);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' summary');
  console.log('═══════════════════════════════════════════════════════════');
  let tu = 0,
    tc = 0,
    tm = 0,
    tdu = 0,
    tb = 0;
  for (const r of results) {
    console.log(
      `  ${maskEmail(r.account).padEnd(28)} updated=${r.updated.toString().padStart(4)} ` +
        `collision=${r.collision.toString().padStart(4)} missing=${r.missing.toString().padStart(4)} ` +
        `uidvDrift=${r.uidvDrift.toString().padStart(4)} badMsgId=${r.badMsgId.toString().padStart(4)}`,
    );
    tu += r.updated;
    tc += r.collision;
    tm += r.missing;
    tdu += r.uidvDrift;
    tb += r.badMsgId;
  }
  console.log('  ' + '─'.repeat(82));
  console.log(
    `  ${'TOTAL'.padEnd(28)} updated=${tu.toString().padStart(4)} ` +
      `collision=${tc.toString().padStart(4)} missing=${tm.toString().padStart(4)} ` +
      `uidvDrift=${tdu.toString().padStart(4)} badMsgId=${tb.toString().padStart(4)}`,
  );
  console.log('');

  // Final coverage check, straight from the DB.
  const [coverage] = await db
    .select({
      total: drizzleSql<number>`count(*)::int`,
      with_rfc: drizzleSql<number>`count(*) filter (where ${emails.rfcMessageId} is not null)::int`,
    })
    .from(emails);
  if (coverage) {
    const pct =
      coverage.total > 0 ? Math.round((coverage.with_rfc * 1000) / coverage.total) / 10 : 0;
    console.log(
      `  coverage: ${coverage.with_rfc}/${coverage.total} rows have rfc_message_id (${pct}%)`,
    );
  }

  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
