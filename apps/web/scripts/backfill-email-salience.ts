/**
 * Recover retrieval salience for emails the header classifier never reached.
 *
 * Context: detection lives in @mantle/email#classifyDelivery (header-based,
 * precise) and writes emails.delivery_kind at sync. But ~1,200 legacy emails
 * predate it and sit at delivery_kind='unknown' (raw headers aren't stored, so
 * they can't be re-classified offline). Those carry salience 1.0 and include the
 * newsletters the audit caught polluting retrieval.
 *
 * This is the pragmatic fallback: for `unknown` emails only, score the *stored
 * body* for unambiguous bulk tells (unsubscribe + tracking-link density) and
 * lower salience. Header-classified rows are never touched — they're the truth.
 * Conservative by design: it takes multiple strong cues to demote, so a personal
 * email with one "unsubscribe" in a quoted footer is left alone.
 *
 * Dry-run by default (prints what it would tag, with a sample to eyeball):
 *   ALLOWED_USER_ID=<uuid> pnpm -C apps/web tsx scripts/backfill-email-salience.ts
 *   ... --apply
 *   ... --salience=0.3   # value to assign (default 0.3, marketing-ish)
 *
 * Idempotent + reversible (only touches unknown-kind email nodes still at 1.0).
 * The going-forward path is the header classifier; this is a one-time recovery.
 */

import { db, nodes, emails } from '@mantle/db';
import { and, eq, sql } from 'drizzle-orm';

const OWNER_ID = process.env.ALLOWED_USER_ID;
if (!OWNER_ID) {
  console.error('backfill-email-salience: ALLOWED_USER_ID must be set');
  process.exit(1);
}
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const salArg = argv.find((a) => a.startsWith('--salience='));
const target = salArg ? Number(salArg.slice('--salience='.length)) : 0.3;
if (!(target >= 0 && target <= 1)) {
  console.error('backfill-email-salience: --salience must be 0..1');
  process.exit(1);
}

const UNSUB = /unsubscrib/i;
const VIEW_BROWSER = /view (this )?(email |message )?(in|on) (your |the )?browser|view (it )?online/i;
const RECEIVED = /you('?re| are)? receiving this|you received this (email|message)|manage (your )?(email )?(preferences|subscription)|update (your )?(email )?preferences|email preferences|opt[\s-]?out/i;
const LINK = /https?:\/\//gi;
const TRACKING = /(\/track\/|\/click\?|[?&]utm_|list-manage|mailchimp|sendgrid|hubspotlinks|sparkpostmail|\/ss\/c\/|\.list-manage\.com|sendibm|mandrillapp)/gi;

/** Transactional veto. The header classifier separates `automated` (receipts,
 *  OTPs, invoices) from `marketing`; this body fallback can't see headers, so a
 *  Tax Invoice with a "view in browser" link looks bulk. These tells mark mail
 *  you DO search — never demote it, even if bulk cues are present. Precision
 *  over recall: better to miss a newsletter than bury an invoice. */
const TRANSACTIONAL =
  /\b(invoice|receipt|order\s*(#|no\.?|number|confirmation|confirmed)|payment\s*(received|confirmation|due|failed)|recharged|statement|verif(y|ied|ication)|password|one[\s-]?time|\botp\b|security code|shipped|tracking\s*(#|number)|booking|reservation|itinerary|ticket\s*#|refund|delivery)\b/i;

/** Unambiguous-bulk score from a stored email body. Returns true only on strong,
 *  multi-signal evidence AND no transactional veto — newsletters trip it easily,
 *  1:1 mail and receipts don't. */
export function looksBulk(subject: string, body: string): boolean {
  const text = `${subject}\n${body}`;
  if (TRANSACTIONAL.test(`${subject}\n${body.slice(0, 4000)}`)) return false;
  const links = (body.match(LINK) ?? []).length;
  const tracking = (body.match(TRACKING) ?? []).length;
  const unsub = UNSUB.test(text);
  const viewBrowser = VIEW_BROWSER.test(text);
  const received = RECEIVED.test(text);
  return (
    tracking >= 5 ||
    links >= 30 ||
    (unsub && links >= 8) ||
    (unsub && (viewBrowser || received))
  );
}

async function main() {
  // Email nodes still at full salience whose message is unclassified. Header-
  // classified bulk (delivery_kind <> unknown) was already handled by 0073.
  const rows = await db
    .select({
      nodeId: nodes.id,
      title: nodes.title,
      subject: emails.subject,
      bodyText: emails.bodyText,
      bodyHtml: emails.bodyHtml,
    })
    .from(nodes)
    .innerJoin(emails, eq(emails.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.ownerId, OWNER_ID!),
        eq(nodes.type, 'email'),
        eq(emails.deliveryKind, 'unknown'),
        sql`${nodes.salience} >= 1.0`,
      ),
    );

  const hits = rows.filter((r) =>
    looksBulk(r.subject ?? '', r.bodyHtml || r.bodyText || ''),
  );

  console.log(
    `Scanned ${rows.length} unknown-kind email node(s); ${hits.length} look bulk by body signal.`,
  );
  console.log(`Sample (${apply ? 'tagging' : 'would tag'} salience=${target}):`);
  for (const h of hits.slice(0, 20)) console.log(`  - ${(h.title ?? '(no title)').slice(0, 70)}`);
  if (hits.length > 20) console.log(`  … and ${hits.length - 20} more`);

  if (apply && hits.length) {
    for (const h of hits) {
      await db
        .update(nodes)
        .set({
          salience: target,
          data: sql`${nodes.data} || ${JSON.stringify({ salience_reason: 'body_bulk_heuristic' })}::jsonb`,
        })
        .where(eq(nodes.id, h.nodeId));
    }
    console.log(`\nDone — ${hits.length} node(s) updated.`);
  } else {
    console.log(`\nDry run — re-run with --apply to commit.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
