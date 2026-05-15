import { db, emailSenderDomains, emailSenders } from '@mantle/db';
import { and, eq, inArray } from 'drizzle-orm';
import { domainOf } from './addresses';

export type Decision = 'approved' | 'denied' | 'pending';

/**
 * In-memory resolver for sender decisions. Holds the user's address-level
 * and domain-level rules and answers `approved | denied | pending` per
 * incoming From address.
 *
 * Priority (matches what the UI shows and what the cascade in
 * `setDomainStatus` does):
 *   address row (approved/denied) > domain row > account policy default
 *
 * Constructor takes already-loaded indexes so the class is trivially
 * testable; use `SenderResolver.load(...)` when you want to hydrate from
 * the DB.
 */
export class SenderResolver {
  constructor(
    public readonly userId: string,
    public readonly accountPolicy: 'approve_list' | 'block_list',
    private readonly addrIndex: Map<string, Decision> = new Map(),
    private readonly domainIndex: Map<string, 'approved' | 'denied'> = new Map(),
  ) {}

  static async load(
    userId: string,
    accountPolicy: 'approve_list' | 'block_list',
  ): Promise<SenderResolver> {
    const [senders, domains] = await Promise.all([
      db
        .select({ address: emailSenders.address, status: emailSenders.status })
        .from(emailSenders)
        .where(eq(emailSenders.userId, userId)),
      db
        .select({ domain: emailSenderDomains.domain, status: emailSenderDomains.status })
        .from(emailSenderDomains)
        .where(eq(emailSenderDomains.userId, userId)),
    ]);
    const addrIndex = new Map<string, Decision>(senders.map((s) => [s.address, s.status]));
    const domainIndex = new Map<string, 'approved' | 'denied'>(
      domains.map((d) => [d.domain, d.status]),
    );
    return new SenderResolver(userId, accountPolicy, addrIndex, domainIndex);
  }

  decide(address: string): Decision {
    const addr = address.toLowerCase();
    const addrStatus = this.addrIndex.get(addr);
    if (addrStatus === 'approved' || addrStatus === 'denied') return addrStatus;
    const domStatus = this.domainIndex.get(domainOf(addr));
    if (domStatus) return domStatus;
    return this.accountPolicy === 'block_list' ? 'approved' : 'pending';
  }

  /** Used by the sync orchestrator to skip senders we've already counted. */
  has(address: string): boolean {
    return this.addrIndex.has(address.toLowerCase());
  }

  /** Record that a sender has been seen in this batch. The DB upsert
   *  writes the canonical row; this keeps the in-memory index in sync
   *  so `has()` and `decide()` give the same answer for subsequent calls
   *  in the same sync run. */
  noteSeen(address: string): void {
    const addr = address.toLowerCase();
    if (!this.addrIndex.has(addr)) this.addrIndex.set(addr, 'pending');
  }
}

/**
 * Bulk-upsert sender rows from a batch of (address, displayName) pairs.
 * Idempotent: increments message_count, refreshes last_seen_at, and inserts
 * new rows.
 *
 * Initial `status` for *new* senders is computed from the resolver — so a
 * brand-new sender from a domain you've already denied lands directly in
 * the Denied tab instead of cluttering Pending first. Existing rows are
 * never reclassified here; the conflict UPDATE clause only touches
 * count/last-seen/display name. Manual approves/denies remain sacred.
 */
export async function upsertSenders(
  userId: string,
  sourceAccountId: string,
  seen: Array<{ address: string; displayName?: string; internalDate: Date }>,
  resolver?: SenderResolver,
): Promise<void> {
  if (seen.length === 0) return;
  const byAddr = new Map<string, { displayName?: string; internalDate: Date; count: number }>();
  for (const s of seen) {
    const key = s.address.toLowerCase();
    const prev = byAddr.get(key);
    byAddr.set(key, {
      displayName: s.displayName ?? prev?.displayName,
      internalDate: prev && prev.internalDate > s.internalDate ? prev.internalDate : s.internalDate,
      count: (prev?.count ?? 0) + 1,
    });
  }
  const rows = [...byAddr.entries()].map(([address, v]) => ({
    userId,
    sourceAccountId,
    address,
    domain: domainOf(address),
    displayName: v.displayName,
    firstSeenAt: v.internalDate,
    lastSeenAt: v.internalDate,
    messageCount: v.count,
    // Resolver decision is the *insert-time* status. UPDATE path ignores it.
    status: resolver?.decide(address) ?? ('pending' as const),
  }));
  // Drizzle's onConflictDoUpdate keeps this to one round trip.
  await db
    .insert(emailSenders)
    .values(rows)
    .onConflictDoUpdate({
      target: [emailSenders.userId, emailSenders.address],
      set: {
        // bump count and refresh display name + last-seen using SQL fragments
        // so we don't need to read-then-write.
        messageCount: __sqlAddCount(),
        lastSeenAt: __sqlGreatestLastSeen(),
        displayName: __sqlCoalesceDisplay(),
      },
    });
}

// Tiny helpers extracted so the SQL above stays scannable.
import { sql } from 'drizzle-orm';
function __sqlAddCount() {
  return sql`${emailSenders.messageCount} + excluded.message_count`;
}
function __sqlGreatestLastSeen() {
  return sql`greatest(${emailSenders.lastSeenAt}, excluded.last_seen_at)`;
}
function __sqlCoalesceDisplay() {
  return sql`coalesce(excluded.display_name, ${emailSenders.displayName})`;
}

export { inArray }; // re-export for callers
