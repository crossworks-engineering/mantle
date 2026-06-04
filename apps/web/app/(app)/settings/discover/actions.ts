'use server';

import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts } from '@mantle/db';
import {
  enqueueBackfills,
  imap,
  peekRecentSenders,
  type RecentSender,
} from '@mantle/email';
import { createContact, loadContactGate } from '@mantle/content';
import { requireOwner } from '@/lib/auth';

/**
 * Live-discover senders who recently emailed the user but aren't yet in their
 * contacts (so their mail is NOT being ingested). Reads IMAP on demand across
 * every enabled account — nothing is persisted. The result is the cheap header
 * scan (`peekRecentSenders`) minus anyone the contact gate already allows.
 */
export type UnknownSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: string; // ISO
  subject?: string;
};

export type RecentUnknownResult =
  | { ok: true; senders: UnknownSender[] }
  | { ok: false; error: string };

export async function recentUnknownSenders(opts?: {
  sinceDays?: number;
  limit?: number;
}): Promise<RecentUnknownResult> {
  const user = await requireOwner();
  const accounts = await db
    .select()
    .from(emailAccounts)
    .where(
      and(
        eq(emailAccounts.userId, user.id),
        eq(emailAccounts.provider, 'imap'),
        eq(emailAccounts.enabled, true),
      ),
    );
  if (accounts.length === 0) return { ok: false, error: 'No IMAP accounts connected.' };

  const gate = await loadContactGate(user.id);
  const sinceDays = opts?.sinceDays ?? 30;
  const limit = opts?.limit ?? 50;

  // Merge distinct senders across accounts, keeping the highest count + latest.
  const merged = new Map<string, RecentSender>();
  let lastErr: string | undefined;
  for (const account of accounts) {
    try {
      const senders = await peekRecentSenders(account, imap, { sinceDays, limit: 200 });
      for (const s of senders) {
        const prev = merged.get(s.fromAddr);
        if (prev) {
          prev.count += s.count;
          if (s.lastDate > prev.lastDate) {
            prev.lastDate = s.lastDate;
            prev.subject = s.subject;
            prev.fromName = s.fromName ?? prev.fromName;
          }
        } else {
          merged.set(s.fromAddr, { ...s });
        }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }

  if (merged.size === 0 && lastErr) return { ok: false, error: lastErr };

  const unknown = [...merged.values()]
    .filter((s) => !gate.allows(s.fromAddr))
    .sort((a, b) => b.lastDate.getTime() - a.lastDate.getTime())
    .slice(0, limit)
    .map((s) => ({
      fromAddr: s.fromAddr,
      fromName: s.fromName,
      count: s.count,
      lastDate: s.lastDate.toISOString(),
      subject: s.subject,
    }));

  return { ok: true, senders: unknown };
}

export type AddSenderResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Promote a discovered sender to a contact (its address becomes the one email
 * entry). Triggers the standard 90-day backfill so their existing mail flows
 * into the brain. `displayName` is best-effort — the operator can rename later.
 */
export async function addContactFromSender(
  address: string,
  displayName?: string,
): Promise<AddSenderResult> {
  const user = await requireOwner();
  const addr = (address ?? '').trim().toLowerCase();
  if (!addr) return { ok: false, error: 'Empty address.' };

  // Split a "First Last" display name into first/last so the contact has an
  // identity (required on later edits). Falls back to the local part.
  const name = (displayName ?? '').trim();
  const [firstName, ...rest] = (name || addr.split('@')[0] || addr).split(/\s+/);

  try {
    const { contact, addedEmails } = await createContact(user.id, {
      firstName: firstName || undefined,
      lastName: rest.join(' ') || undefined,
      emails: [addr],
      description: '',
    });
    await enqueueBackfills(user.id, addedEmails);
    revalidatePath('/settings/discover');
    revalidatePath('/inbox');
    return { ok: true, id: contact.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add contact' };
  }
}
