/**
 * Re-classify legacy `unknown` emails from their real headers, then re-derive
 * node salience — the precise fix the body-heuristic fallback only approximated.
 *
 * Why this exists: `emails.delivery_kind` is set at sync by the header classifier
 * (@mantle/email#classifyDelivery), but ~1,200 emails were synced before it and
 * sit at `unknown`. We never stored raw headers, so they can't be reclassified
 * offline — this re-fetches the classification headers over IMAP (BODY.PEEK, one
 * round trip per folder, never marks read), runs the SAME classifier, writes the
 * true delivery_kind, and sets nodes.salience from it (clearing the fuzzy
 * `body_bulk_heuristic` marker). Marketing newsletters get correctly demoted;
 * misjudged transactional mail (an invoice the body heuristic demoted) is
 * correctly restored.
 *
 * Read-only against the mailbox (FETCH only). Dry-run by default:
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web classify:backfill
 *   ... --apply
 *   ... --limit=200            # cap emails per account (test on a small batch first)
 *   ... --account=<uuid>       # one account only
 *
 * Idempotent: only touches rows still at delivery_kind='unknown'. Re-running is
 * safe (already-classified rows are skipped). Needs the IMAP creds to be valid
 * and MANTLE_MASTER_KEY in env (the script's --env-file loads .env.local).
 */

import { db, emailAccounts, emails, nodes, type EmailAccount } from '@mantle/db';
import {
  decodeMsgId,
  reclassifyByRefs,
  salienceForDeliveryKind,
  type DeliveryKind,
} from '@mantle/email';
import { and, eq, sql } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('classify-backfill: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const limitArg = argv.find((a) => a.startsWith('--limit='));
const perAccountLimit = limitArg ? parseInt(limitArg.slice('--limit='.length), 10) : null;
const accountArg = argv.find((a) => a.startsWith('--account='));
const onlyAccount = accountArg ? accountArg.slice('--account='.length) : null;

async function main() {
  const accounts = (
    await db
      .select()
      .from(emailAccounts)
      .where(and(eq(emailAccounts.userId, OWNER_ID!), eq(emailAccounts.provider, 'imap')))
  ).filter((a) => !onlyAccount || a.id === onlyAccount);

  if (accounts.length === 0) {
    console.log('No IMAP accounts to process.');
    process.exit(0);
  }

  const tally: Record<string, number> = {};
  let totalSeen = 0;
  let totalResolved = 0;
  let totalChanged = 0;

  for (const account of accounts as EmailAccount[]) {
    let rows = await db
      .select({ id: emails.id, nodeId: emails.nodeId, providerMsgId: emails.providerMsgId })
      .from(emails)
      .where(and(eq(emails.accountId, account.id), eq(emails.deliveryKind, 'unknown')));
    if (perAccountLimit != null) rows = rows.slice(0, perAccountLimit);
    if (rows.length === 0) continue;
    totalSeen += rows.length;

    // Decode each provider id to (folder, uidvalidity, uid); index back to the
    // email + node rows by the `folder:uid` key reclassifyByRefs returns.
    const refs: Array<{ folder: string; uidvalidity: number; uid: number }> = [];
    const byKey = new Map<string, { emailId: string; nodeId: string }>();
    for (const r of rows) {
      try {
        const { folder, uidvalidity, uid } = decodeMsgId(r.providerMsgId);
        refs.push({ folder, uidvalidity, uid });
        byKey.set(`${folder}:${uid}`, { emailId: r.id, nodeId: r.nodeId });
      } catch {
        /* malformed provider id — skip */
      }
    }

    let resultByKey: Map<string, DeliveryKind>;
    try {
      resultByKey = await reclassifyByRefs(account, refs);
    } catch (err) {
      console.error(
        `[${account.address}] IMAP reclassify failed:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }

    let changed = 0;
    for (const [key, kind] of resultByKey) {
      const target = byKey.get(key);
      if (!target) continue;
      totalResolved++;
      tally[kind] = (tally[kind] ?? 0) + 1;
      // classifyDelivery only emits direct|list|automated|marketing — every
      // resolved row is a real reclassification (incl. 'direct', which clears a
      // mistaken body-heuristic demotion and restores salience 1.0).
      changed++;
      if (apply) {
        await db.update(emails).set({ deliveryKind: kind }).where(eq(emails.id, target.emailId));
        await db
          .update(nodes)
          .set({
            salience: salienceForDeliveryKind(kind),
            data: sql`${nodes.data} - 'salience_reason'`,
          })
          .where(eq(nodes.id, target.nodeId));
      }
    }
    totalChanged += changed;
    console.log(
      `[${account.address}] ${rows.length} unknown · ${resultByKey.size} re-fetched · ${changed} ${apply ? 'updated' : 'would update'}`,
    );
  }

  console.log(`\nResolved ${totalResolved}/${totalSeen} (rest: moved/deleted/stale-uidvalidity).`);
  console.log('New delivery_kind distribution:', tally);
  console.log(
    apply ? `Applied — ${totalChanged} email(s) reclassified.` : `\nDry run — re-run with --apply.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
