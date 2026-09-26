/**
 * Inbound email allowlist, derived from the contacts list. This is the SOLE
 * gate for what mail reaches the brain: a message is ingested iff its From
 * address matches a contact (an exact address OR a `@domain` wildcard), an
 * active login (users are contacts in user form, 2026-09-26), or one of the
 * owner's own account addresses. Everything else is silently rejected —
 * never fetched, never stored.
 *
 * Mirrors the outbound send gate (`contactEmails`) but — unlike it — honours
 * `@domain` wildcards: a domain entry means "trust mail FROM this domain",
 * which is an inbound-only notion (you can't *send* to a whole domain). See
 * `partitionEmailEntries` in contacts-format.ts for the address/domain split.
 *
 * Empty contacts ⇒ nothing inbound is allowed (own-account mail aside). That is
 * intentional: an empty allowlist is an empty inbox, not a firehose. The inbox
 * UI nudges the user to add a contact; `isEmpty` surfaces that state.
 */
import { and, eq } from 'drizzle-orm';
import { db, emailAccounts, nodes } from '@mantle/db';
import { partitionEmailEntries } from '@mantle/content-core/contacts-format';
import { loginEmails } from './contacts';

function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : '';
}

export interface ContactGate {
  /** True when `fromAddr` is permitted to be ingested. */
  allows(fromAddr: string): boolean;
  /** True when the owner has zero contact email/domain entries. (Own-account
   *  addresses are NOT counted — an account with no contacts still ingests its
   *  own sent mail, but the inbox should still nudge "add a contact".) */
  readonly isEmpty: boolean;
}

export async function loadContactGate(ownerId: string): Promise<ContactGate> {
  const [contactRows, accountRows, logins] = await Promise.all([
    db
      .select({ data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'contact'))),
    db
      .select({ address: emailAccounts.address })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, ownerId)),
    loginEmails(),
  ]);

  const exact = new Set<string>();
  const domains = new Set<string>();
  for (const r of contactRows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const entries = Array.isArray(d.emails)
      ? (d.emails as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
      : typeof d.email === 'string' && d.email
        ? [d.email]
        : [];
    const { addresses, domains: doms } = partitionEmailEntries(entries);
    for (const a of addresses) exact.add(a);
    for (const dm of doms) domains.add(dm);
  }

  const ownAccounts = new Set<string>();
  for (const a of accountRows) ownAccounts.add(a.address.toLowerCase());
  // The brain's users, admins and members: allowed like own accounts (they
  // do not make the contact list "non-empty" either).
  for (const e of logins) ownAccounts.add(e);

  const isEmpty = exact.size === 0 && domains.size === 0;

  return {
    isEmpty,
    allows(fromAddr: string): boolean {
      const addr = (fromAddr ?? '').trim().toLowerCase();
      if (!addr) return false;
      if (exact.has(addr)) return true;
      if (ownAccounts.has(addr)) return true;
      const dom = domainOf(addr);
      return dom.length > 0 && domains.has(dom);
    },
  };
}
