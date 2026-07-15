/**
 * Sender discovery — a live look at who recently emailed the owner but
 * isn't yet a contact (so their mail is NOT being ingested). Reads the
 * provider on demand across every enabled account; persists nothing. Lifted
 * from the `apps/web` settings/discover action so it's reachable over HTTP.
 */
import type { EmailAccount } from '@mantle/db';
import { createContact, loadContactGate } from '@mantle/content';
import { listAccounts } from './accounts';
import { enqueueBackfills } from './backfill-queue';
import { peekRecentSenders, type RecentSender } from './peek';
import { imap } from './providers/imap';
import type { EmailProvider } from './types';

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

/** Maps an account to the provider that can peek it, or null to skip it.
 *  Injectable so callers that know about non-IMAP providers (the web app,
 *  which has @mantle/microsoft) can widen the scan — this package only knows
 *  IMAP, and a package-level import the other way would be circular. */
export type PeekProviderResolver = (account: EmailAccount) => EmailProvider | null;

const imapOnly: PeekProviderResolver = (a) => (a.provider === 'imap' ? imap : null);

/**
 * Live-discover senders who recently emailed the owner but aren't yet in their
 * contacts. The result is the cheap header scan (`peekRecentSenders`) across
 * every enabled account `resolveProvider` covers, merged and minus anyone the
 * contact gate already allows.
 */
export async function recentUnknownSenders(
  userId: string,
  opts?: { sinceDays?: number; limit?: number },
  resolveProvider: PeekProviderResolver = imapOnly,
): Promise<RecentUnknownResult> {
  const all = await listAccounts(userId);
  const accounts = all
    .filter((a) => a.enabled)
    .map((a) => ({ account: a, provider: resolveProvider(a) }))
    .filter((x): x is { account: EmailAccount; provider: EmailProvider } => x.provider !== null);
  if (accounts.length === 0) return { ok: false, error: 'No email accounts connected.' };

  const gate = await loadContactGate(userId);
  const sinceDays = opts?.sinceDays ?? 30;
  const limit = opts?.limit ?? 50;

  // Merge distinct senders across accounts, keeping the highest count + latest.
  const merged = new Map<string, RecentSender>();
  let lastErr: string | undefined;
  for (const { account, provider } of accounts) {
    try {
      const senders = await peekRecentSenders(account, provider, { sinceDays, limit: 200 });
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
  userId: string,
  address: string,
  displayName?: string,
): Promise<AddSenderResult> {
  const addr = (address ?? '').trim().toLowerCase();
  if (!addr) return { ok: false, error: 'Empty address.' };

  // Split a "First Last" display name into first/last so the contact has an
  // identity (required on later edits). Falls back to the local part.
  const name = (displayName ?? '').trim();
  const [firstName, ...rest] = (name || addr.split('@')[0] || addr).split(/\s+/);

  try {
    const { contact, addedEmails } = await createContact(userId, {
      firstName: firstName || undefined,
      lastName: rest.join(' ') || undefined,
      emails: [addr],
      description: '',
    });
    await enqueueBackfills(userId, addedEmails);
    return { ok: true, id: contact.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not add contact' };
  }
}
