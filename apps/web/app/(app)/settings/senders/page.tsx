import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { X } from 'lucide-react';
import { db, emailAccounts, emailSenderDomains, emailSenders } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { formatDate } from '@/lib/format-datetime';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { setDomainStatus, setSenderStatus } from './actions';
import { ManualEntry } from './manual-entry';
import { PreviewButton } from './preview-button';
import { SearchBox } from './search-box';

type Tab = 'pending' | 'approved' | 'denied';

const TABS: Tab[] = ['pending', 'approved', 'denied'];

export default async function SendersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const tab: Tab = (TABS as string[]).includes(params.tab ?? '') ? (params.tab as Tab) : 'pending';
  const search = (params.q ?? '').trim().toLowerCase();

  // Top-line counts for the tab badges.
  const counts = await db
    .select({ status: emailSenders.status, count: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(eq(emailSenders.userId, user.id))
    .groupBy(emailSenders.status);
  const countByStatus: Record<Tab, number> = { pending: 0, approved: 0, denied: 0 };
  for (const c of counts) countByStatus[c.status as Tab] = c.count;

  const conds = [eq(emailSenders.userId, user.id), eq(emailSenders.status, tab)];
  if (search) conds.push(sql`${emailSenders.address} ilike ${'%' + search + '%'}`);
  const rows = await db
    .select({
      address: emailSenders.address,
      domain: emailSenders.domain,
      displayName: emailSenders.displayName,
      messageCount: emailSenders.messageCount,
      firstSeenAt: emailSenders.firstSeenAt,
      lastSeenAt: emailSenders.lastSeenAt,
      sourceAccountId: emailSenders.sourceAccountId,
    })
    .from(emailSenders)
    .where(and(...conds))
    .orderBy(desc(emailSenders.messageCount), desc(emailSenders.lastSeenAt))
    .limit(500);

  const accounts = await db
    .select({ id: emailAccounts.id, address: emailAccounts.address })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, user.id));
  const accountById = new Map(accounts.map((a) => [a.id, a.address]));

  const domainDecisions = await db
    .select({ domain: emailSenderDomains.domain, status: emailSenderDomains.status })
    .from(emailSenderDomains)
    .where(eq(emailSenderDomains.userId, user.id));
  const domainStatus = new Map(domainDecisions.map((d) => [d.domain, d.status]));

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Senders</h1>
        <p className="text-sm text-muted-foreground">
          Approve the senders worth keeping. Mantle only ingests bodies and attachments for{' '}
          <span className="font-medium">approved</span> senders; everything else is just metadata in this
          list.
        </p>
      </header>

      <ManualEntry />

      <nav className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t}
            href={{ pathname: '/settings/senders', query: { tab: t, ...(search ? { q: search } : {}) } }}
            className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${
              tab === t
                ? 'border-foreground font-medium'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t}{' '}
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs">{countByStatus[t]}</span>
          </Link>
        ))}
        <SearchBox initial={search} />
      </nav>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {tab === 'pending'
            ? 'No pending senders. Connect an IMAP account or wait for the next sync.'
            : `No ${tab} senders yet.`}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => {
            const accountAddr = r.sourceAccountId ? accountById.get(r.sourceAccountId) : undefined;
            const domainOverride = domainStatus.get(r.domain);
            return (
              <li
                key={r.address}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{r.displayName || r.address}</span>
                    {r.displayName && (
                      <span className="truncate text-xs text-muted-foreground">{r.address}</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      <span className="text-foreground/70">{r.messageCount}</span> messages
                    </span>
                    <span>last seen {formatDate(r.lastSeenAt)}</span>
                    {accountAddr && <span>via {accountAddr}</span>}
                    <span className="text-foreground/60">@{r.domain}</span>
                    {domainOverride && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-50 py-0.5 pl-1.5 pr-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                        domain rule: {domainOverride}
                        <form action={setDomainStatus} className="inline-flex">
                          <input type="hidden" name="domain" value={r.domain} />
                          <input type="hidden" name="status" value="reset" />
                          <button
                            type="submit"
                            title="Clear domain rule"
                            aria-label="Clear domain rule"
                            className="rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-900/40"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </form>
                      </span>
                    )}
                  </div>
                </div>

                {/*
                  Five buttons, fixed positions, flush to the row's right
                  padding edge. Ordering is paired: Approve sits next to
                  Approve all, Deny next to Deny all — so a "I want to keep
                  this one" or "I want to drop this whole domain" decision
                  is a left-vs-right tap with no scanning.
                */}
                <div className="flex items-center justify-end gap-1.5">
                  <PreviewButton address={r.address} />
                  {tab !== 'approved' && (
                    <form action={setSenderStatus}>
                      <input type="hidden" name="address" value={r.address} />
                      <input type="hidden" name="status" value="approved" />
                      <SubmitButton size="sm" variant="approve">
                        Approve
                      </SubmitButton>
                    </form>
                  )}
                  <form action={setDomainStatus}>
                    <input type="hidden" name="domain" value={r.domain} />
                    <input type="hidden" name="status" value="approved" />
                    <SubmitButton
                      size="sm"
                      variant="approve"
                      disabled={domainOverride === 'approved'}
                    >
                      Approve All
                    </SubmitButton>
                  </form>
                  {tab !== 'denied' && (
                    <form action={setSenderStatus}>
                      <input type="hidden" name="address" value={r.address} />
                      <input type="hidden" name="status" value="denied" />
                      <SubmitButton size="sm" variant="deny">
                        Deny
                      </SubmitButton>
                    </form>
                  )}
                  <form action={setDomainStatus}>
                    <input type="hidden" name="domain" value={r.domain} />
                    <input type="hidden" name="status" value="denied" />
                    <SubmitButton
                      size="sm"
                      variant="deny"
                      disabled={domainOverride === 'denied'}
                    >
                      Deny All
                    </SubmitButton>
                  </form>
                  {tab !== 'pending' && (
                    <form action={setSenderStatus}>
                      <input type="hidden" name="address" value={r.address} />
                      <input type="hidden" name="status" value="pending" />
                      <SubmitButton size="sm" variant="ghost">
                        Reset
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
