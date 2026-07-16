/**
 * Purge already-ingested email whose sender isn't in the contacts allowlist.
 *
 * Context: the inbound gate is now the contacts list (see @mantle/content
 * ContactGate / docs/email-ingest.md). New mail from non-contacts is rejected
 * at sync, but mail ingested under the OLD sender-curation gate is still in the
 * brain. This is the one-time cutover cleanup that aligns the historical corpus
 * to the new rule.
 *
 * SAFETY — mirrors scripts/backfill-email-salience.ts:
 *   - ALLOWED_USER_ID is required (scopes to one owner).
 *   - DRY-RUN by default: prints the count + a 20-row sample, deletes nothing.
 *   - --apply commits the deletes (email NODE rows; FK cascade removes the
 *     emails row + email_attachments rows).
 *   - --account=<uuid> limits to one mailbox; --limit=<n> caps the delete set.
 *   - Orphan file nodes (an attachment whose only email is now gone) are NOT
 *     deleted by default — they're REPORTED. Pass --purge-orphan-files to also
 *     delete those attachment file nodes (storage bytes are content-addressed
 *     and left to normal reconciliation).
 *
 * Always SAMPLE the output before re-running with --apply. Deletes are
 * irreversible.
 *
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web purge:noncontact
 *   ... --apply
 *   ... --account=<uuid> --limit=500
 *   ... --apply --purge-orphan-files
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, emailAttachments, emails, nodes } from '@mantle/db';
import { loadContactGate } from '@mantle/content';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('purge-noncontact-emails: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const purgeOrphanFiles = argv.includes('--purge-orphan-files');
const accountArg = argv.find((a) => a.startsWith('--account='));
const account = accountArg ? accountArg.slice('--account='.length) : undefined;
const limitArg = argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
  console.error('purge-noncontact-emails: --limit must be a positive integer');
  process.exit(1);
}

async function main() {
  const gate = await loadContactGate(OWNER_ID!);
  if (gate.isEmpty) {
    console.warn(
      '⚠ The contacts list is EMPTY — every ingested email would be flagged as non-contact.\n' +
        '  Add your contacts FIRST, then run this. Refusing to proceed.',
    );
    process.exit(1);
  }

  const conds = [eq(nodes.ownerId, OWNER_ID!), eq(nodes.type, 'email')];
  if (account) conds.push(eq(emails.accountId, account));

  const rows = await db
    .select({
      nodeId: nodes.id,
      title: nodes.title,
      fromAddr: emails.fromAddr,
      subject: emails.subject,
      internalDate: emails.internalDate,
    })
    .from(nodes)
    .innerJoin(emails, eq(emails.nodeId, nodes.id))
    .where(and(...conds));

  let flagged = rows.filter((r) => !gate.allows(r.fromAddr));
  flagged.sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime());
  const capped = limit !== undefined ? flagged.slice(0, limit) : flagged;

  console.log(
    `Scanned ${rows.length} email node(s) for owner; ${flagged.length} are from non-contact senders` +
      (limit !== undefined ? ` (capped to ${capped.length} this run)` : '') +
      '.',
  );
  console.log(`Sample (${apply ? 'deleting' : 'would delete'}):`);
  for (const h of capped.slice(0, 20)) {
    console.log(`  - ${h.fromAddr}  ·  ${(h.subject ?? h.title ?? '(no subject)').slice(0, 60)}`);
  }
  if (capped.length > 20) console.log(`  … and ${capped.length - 20} more`);

  if (apply && capped.length) {
    const ids = capped.map((r) => r.nodeId);
    // Batch the delete so a huge set doesn't build one giant IN list. FK
    // cascade removes the emails row + its email_attachments; the 0058 trigger
    // reaps mentioned_in edges.
    const BATCH = 500;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      await db.delete(nodes).where(inArray(nodes.id, chunk));
      deleted += chunk.length;
    }
    console.log(`\nDeleted ${deleted} email node(s).`);
  }

  // Orphan attachment file nodes: a `file` node under an `…attachments` path
  // that no email_attachments row references anymore. Report always; delete
  // only with --purge-orphan-files (and --apply).
  const orphans = await db
    .select({ id: nodes.id, title: nodes.title, path: sql<string>`${nodes.path}::text` })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, OWNER_ID!),
        eq(nodes.type, 'file'),
        sql`${nodes.path}::text like '%attachments'`,
        sql`not exists (select 1 from ${emailAttachments} ea where ea.file_node_id = ${nodes.id})`,
      ),
    );
  console.log(`\nOrphan attachment file node(s) (no email references them): ${orphans.length}.`);
  for (const o of orphans.slice(0, 20)) console.log(`  - ${(o.title ?? '(no name)').slice(0, 60)}`);
  if (orphans.length > 20) console.log(`  … and ${orphans.length - 20} more`);

  if (apply && purgeOrphanFiles && orphans.length) {
    const ids = orphans.map((o) => o.id);
    const BATCH = 500;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      await db.delete(nodes).where(inArray(nodes.id, chunk));
      deleted += chunk.length;
    }
    console.log(
      `Deleted ${deleted} orphan file node(s). (Storage bytes are content-addressed; ` +
        `left to normal reconciliation.)`,
    );
  } else if (orphans.length) {
    console.log('  (left in place — pass --apply --purge-orphan-files to delete these)');
  }

  if (!apply) console.log(`\nDry run — re-run with --apply to commit.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
