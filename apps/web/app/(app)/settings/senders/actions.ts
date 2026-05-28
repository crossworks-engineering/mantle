'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, ne, sql } from 'drizzle-orm';
import PgBoss from 'pg-boss';
import {
  db,
  emailAccounts,
  emailSenderDomains,
  emailSenders,
  type EmailSenderDomain,
} from '@mantle/db';
import { dominantKindWhere } from './dominant-kind';
import {
  domainOf,
  imap,
  peekLatestFromSender,
  sanitizeEmailHtml,
  type SenderPreview,
} from '@mantle/email';
import { requireOwner } from '@/lib/auth';

const BACKFILL_QUEUE = 'mantle.email.backfill';

/** Lazy pg-boss publisher — one instance per process. Workers run in their
 *  own process; this is just for "approve sender → enqueue backfill". */
let _boss: PgBoss | undefined;
async function boss(): Promise<PgBoss> {
  if (_boss) return _boss;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set');
  _boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
  await _boss.start();
  await _boss.createQueue(BACKFILL_QUEUE);
  return _boss;
}

async function enqueueBackfill(userId: string, senderAddress: string): Promise<void> {
  const accounts = await db
    .select({ id: emailAccounts.id })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.userId, userId), eq(emailAccounts.enabled, true)));
  if (accounts.length === 0) return;
  const b = await boss();
  for (const a of accounts) {
    await b.send(
      BACKFILL_QUEUE,
      { accountId: a.id, senderAddress },
      { singletonKey: `backfill:${a.id}:${senderAddress}` },
    );
  }
}

export async function setSenderStatus(formData: FormData) {
  const user = await requireOwner();
  const address = String(formData.get('address') ?? '').toLowerCase();
  const next = String(formData.get('status') ?? '');
  if (!address || !['approved', 'denied', 'pending'].includes(next)) return;

  await db
    .update(emailSenders)
    .set({
      status: next as 'approved' | 'denied' | 'pending',
      decidedAt: next === 'pending' ? null : new Date(),
    })
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.address, address)));

  if (next === 'approved') await enqueueBackfill(user.id, address);
  revalidatePath('/settings/senders');
  revalidatePath('/inbox');
}

export async function setDomainStatus(formData: FormData) {
  const user = await requireOwner();
  const domain = String(formData.get('domain') ?? '').toLowerCase();
  const next = String(formData.get('status') ?? '');
  if (!domain) return;

  if (next === 'reset') {
    await db
      .delete(emailSenderDomains)
      .where(and(eq(emailSenderDomains.userId, user.id), eq(emailSenderDomains.domain, domain)));
    revalidatePath('/settings/senders');
    revalidatePath('/inbox');
    return;
  }

  if (next !== 'approved' && next !== 'denied') return;

  // 1. Upsert the domain rule. This still applies prospectively to future
  //    senders we haven't seen yet (via the SenderResolver fallback).
  const row: Omit<EmailSenderDomain, 'id' | 'createdAt' | 'updatedAt' | 'decidedAt'> = {
    userId: user.id,
    domain,
    status: next,
  };
  await db
    .insert(emailSenderDomains)
    .values({ ...row, decidedAt: new Date() })
    .onConflictDoUpdate({
      target: [emailSenderDomains.userId, emailSenderDomains.domain],
      set: { status: next, decidedAt: new Date() },
    });

  // 2. Cascade: "Approve All" / "Deny All" is an authoritative domain decision,
  //    so every sender in the domain that isn't already at the target status is
  //    flipped — including ones previously approved/denied individually. The
  //    most recent explicit action wins; if the user wants to spare one sender
  //    in a denied domain they re-approve that one afterward. (Skipping rows
  //    already at the target keeps `decidedAt` and the backfill set honest.)
  const cascaded = await db
    .update(emailSenders)
    .set({ status: next, decidedAt: new Date() })
    .where(
      and(
        eq(emailSenders.userId, user.id),
        eq(emailSenders.domain, domain),
        ne(emailSenders.status, next),
      ),
    )
    .returning({ address: emailSenders.address });

  // 3. Backfill the senders that just transitioned to approved.
  if (next === 'approved') {
    for (const r of cascaded) await enqueueBackfill(user.id, r.address);
  }

  revalidatePath('/settings/senders');
  revalidatePath('/inbox');
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual entry: pre-approve / pre-deny by typing an address or domain that
// hasn't been seen yet. Reuses the same persistence + cascade + backfill paths.

export type ManualDecisionResult =
  | { ok: true; kind: 'address'; target: string; status: 'approved' | 'denied' }
  | {
      ok: true;
      kind: 'domain';
      target: string;
      status: 'approved' | 'denied';
      cascadedCount: number;
    }
  | { ok: false; error: string };

// Permissive validators — we lowercase, strip an optional leading "@", and
// then check shape. Address requires an `@` with non-empty parts on both
// sides; domain requires at least one `.` and a 2+ letter TLD.
const ADDR_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export async function addManualDecision(
  _prev: ManualDecisionResult | undefined,
  form: FormData,
): Promise<ManualDecisionResult> {
  const user = await requireOwner();
  const raw = String(form.get('input') ?? '').trim().toLowerCase();
  const status = String(form.get('status') ?? '') as 'approved' | 'denied';

  if (!raw) return { ok: false, error: 'Enter an email address or domain.' };
  if (status !== 'approved' && status !== 'denied') {
    return { ok: false, error: 'Pick Approve or Deny.' };
  }

  const cleaned = raw.startsWith('@') ? raw.slice(1) : raw;
  const isAddress = cleaned.includes('@');

  if (isAddress) {
    if (!ADDR_RE.test(cleaned)) {
      return { ok: false, error: `"${raw}" doesn't look like a valid email address.` };
    }
    const domain = domainOf(cleaned);
    const now = new Date();
    // Upsert. If we've never seen this sender, create the row with the
    // manual decision and zero messages. If we have, just flip its status.
    await db
      .insert(emailSenders)
      .values({
        userId: user.id,
        address: cleaned,
        domain,
        status,
        decidedAt: now,
        // first_seen_at / last_seen_at default to now() on the column; we
        // accept that "pre-approved before any mail arrived" rows will
        // show today's date until a real message comes in.
        messageCount: 0,
      })
      .onConflictDoUpdate({
        target: [emailSenders.userId, emailSenders.address],
        set: { status, decidedAt: now },
      });

    if (status === 'approved') await enqueueBackfill(user.id, cleaned);

    revalidatePath('/settings/senders');
    revalidatePath('/inbox');
    return { ok: true, kind: 'address', target: cleaned, status };
  }

  // Domain branch — same shape as setDomainStatus.
  if (!DOMAIN_RE.test(cleaned)) {
    return { ok: false, error: `"${raw}" doesn't look like a valid domain.` };
  }
  const now = new Date();
  await db
    .insert(emailSenderDomains)
    .values({ userId: user.id, domain: cleaned, status, decidedAt: now })
    .onConflictDoUpdate({
      target: [emailSenderDomains.userId, emailSenderDomains.domain],
      set: { status, decidedAt: now },
    });

  // Authoritative domain decision — flip every sender in the domain not
  // already at the target (mirrors setDomainStatus §2).
  const cascaded = await db
    .update(emailSenders)
    .set({ status, decidedAt: now })
    .where(
      and(
        eq(emailSenders.userId, user.id),
        eq(emailSenders.domain, cleaned),
        ne(emailSenders.status, status),
      ),
    )
    .returning({ address: emailSenders.address });

  if (status === 'approved') {
    for (const r of cascaded) await enqueueBackfill(user.id, r.address);
  }

  revalidatePath('/settings/senders');
  revalidatePath('/inbox');
  return { ok: true, kind: 'domain', target: cleaned, status, cascadedCount: cascaded.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live preview — fetch the latest message from a sender on demand. Reads
// IMAP directly; nothing is persisted. Used to inform approve/deny decisions
// on senders whose bodies Mantle hasn't stored.

export type SenderPreviewResult =
  | {
      ok: true;
      preview: Omit<SenderPreview, 'internalDate' | 'bodyHtml'> & {
        internalDate: string;
        /** Server-sanitised HTML, safe to load into a sandboxed iframe. */
        bodyHtmlSafe?: string;
      };
    }
  | { ok: false; error: string };

export async function previewSender(address: string): Promise<SenderPreviewResult> {
  const user = await requireOwner();
  const lookup = address.trim().toLowerCase();
  if (!lookup) return { ok: false, error: 'Empty address.' };

  // Prefer the account that first saw this sender; fall back to any of the
  // user's enabled IMAP accounts.
  const [senderRow] = await db
    .select({ sourceAccountId: emailSenders.sourceAccountId })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.address, lookup)))
    .limit(1);

  let accountRows = await db
    .select()
    .from(emailAccounts)
    .where(
      and(
        eq(emailAccounts.userId, user.id),
        eq(emailAccounts.provider, 'imap'),
        eq(emailAccounts.enabled, true),
      ),
    );
  if (senderRow?.sourceAccountId) {
    accountRows = [
      ...accountRows.filter((a) => a.id === senderRow.sourceAccountId),
      ...accountRows.filter((a) => a.id !== senderRow.sourceAccountId),
    ];
  }
  if (accountRows.length === 0) {
    return { ok: false, error: 'No IMAP accounts connected.' };
  }

  // Try accounts in priority order; first match wins. We don't accumulate
  // across accounts — the latest message from this sender on the most-
  // likely account is what we want to show.
  let lastErr: string | undefined;
  for (const account of accountRows) {
    try {
      const preview = await peekLatestFromSender(account, imap, lookup);
      if (preview) {
        const { bodyHtml, internalDate, ...rest } = preview;
        return {
          ok: true,
          preview: {
            ...rest,
            internalDate: internalDate.toISOString(),
            bodyHtmlSafe: bodyHtml ? sanitizeEmailHtml(bodyHtml) : undefined,
          },
        };
      }
    } catch (err) {
      lastErr = (err as Error).message;
    }
  }
  return {
    ok: false,
    error: lastErr ?? `No messages found from ${lookup} in the last 12 months.`,
  };
}

export async function bulkSetSenderStatus(formData: FormData) {
  const user = await requireOwner();
  const next = String(formData.get('status') ?? '');
  if (!['approved', 'denied', 'pending'].includes(next)) return;
  const addresses = formData
    .getAll('addresses')
    .map((s) => String(s).toLowerCase())
    .filter(Boolean);
  if (addresses.length === 0) return;

  for (const address of addresses) {
    await db
      .update(emailSenders)
      .set({
        status: next as 'approved' | 'denied' | 'pending',
        decidedAt: next === 'pending' ? null : new Date(),
      })
      .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.address, address)));
    if (next === 'approved') await enqueueBackfill(user.id, address);
  }
  revalidatePath('/settings/senders');
  revalidatePath('/inbox');
}

/**
 * Bulk-deny every pending sender currently classified as marketing-dominant
 * (per the same threshold used by the pill — see `dominant-kind.ts`),
 * optionally scoped to a search term so "deny everything matching 'mailchimp'"
 * is one click. Used by the conditional button on the pending tab.
 *
 * Single UPDATE — no backfill side-effects (deny doesn't trigger one) and no
 * per-row loop, since denied is the terminal state we want them all in.
 */
export async function denyAllMarketing(formData: FormData) {
  const user = await requireOwner();
  const search = String(formData.get('q') ?? '').trim().toLowerCase();
  const like = '%' + search + '%';

  const conds = [
    eq(emailSenders.userId, user.id),
    eq(emailSenders.status, 'pending'),
    dominantKindWhere('marketing'),
  ];
  if (search) {
    conds.push(
      sql`(${emailSenders.address} ilike ${like} OR ${emailSenders.domain} ilike ${like} OR coalesce(${emailSenders.displayName}, '') ilike ${like})`,
    );
  }

  await db
    .update(emailSenders)
    .set({ status: 'denied', decidedAt: new Date() })
    .where(and(...conds));
  revalidatePath('/settings/senders');
}

