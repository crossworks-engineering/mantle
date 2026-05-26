import Link from 'next/link';
import { and, desc, eq, sql } from 'drizzle-orm';
import { X } from 'lucide-react';
import { db, emailAccounts, emailSenderDomains, emailSenders } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { formatDate } from '@/lib/format-datetime';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { setDomainStatus, setSenderStatus } from './actions';
import { DenyMarketingButton } from './deny-marketing';
import { dominantKind, dominantKindWhere, parseKindParam } from './dominant-kind';
import { KindFilter } from './kind-filter';
import { KindPill } from './kind-pill';
import { ManualEntry } from './manual-entry';
import { PreviewButton } from './preview-button';
import { SearchBox } from './search-box';
import { SendersPager } from './senders-pager';

type Tab = 'pending' | 'approved' | 'denied';

const TABS: Tab[] = ['pending', 'approved', 'denied'];
const PAGE_SIZE = 50;

export default async function SendersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; page?: string; kind?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const tab: Tab = (TABS as string[]).includes(params.tab ?? '') ? (params.tab as Tab) : 'pending';
  const search = (params.q ?? '').trim().toLowerCase();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const kind = parseKindParam(params.kind);

  // Top-line counts for the tab badges — always the per-status totals
  // (not the search-filtered totals), so flipping tabs always shows the
  // full per-tab volume even with a search active.
  const counts = await db
    .select({ status: emailSenders.status, count: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(eq(emailSenders.userId, user.id))
    .groupBy(emailSenders.status);
  const countByStatus: Record<Tab, number> = { pending: 0, approved: 0, denied: 0 };
  for (const c of counts) countByStatus[c.status as Tab] = c.count;

  const conds = [eq(emailSenders.userId, user.id), eq(emailSenders.status, tab)];
  if (search) {
    // Search address, domain, and display name — typing a person's name or
    // a partial domain should all find the row, not just full addresses.
    const like = '%' + search + '%';
    conds.push(
      sql`(${emailSenders.address} ilike ${like} OR ${emailSenders.domain} ilike ${like} OR coalesce(${emailSenders.displayName}, '') ilike ${like})`,
    );
  }
  if (kind) conds.push(dominantKindWhere(kind));

  // Bulk-deny-marketing affordance lives on the pending tab and shows a
  // live count — same WHERE as the main list, but ignores any active `kind`
  // filter (we *always* want to know "of the pending senders matching my
  // search, how many are marketing?", regardless of which sub-tab is on).
  const bulkConds = [eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')];
  if (search) {
    const like = '%' + search + '%';
    bulkConds.push(
      sql`(${emailSenders.address} ilike ${like} OR ${emailSenders.domain} ilike ${like} OR coalesce(${emailSenders.displayName}, '') ilike ${like})`,
    );
  }
  bulkConds.push(dominantKindWhere('marketing'));

  const [rows, totalRow, bulkMarketingRow] = await Promise.all([
    db
      .select({
        address: emailSenders.address,
        domain: emailSenders.domain,
        displayName: emailSenders.displayName,
        messageCount: emailSenders.messageCount,
        directCount: emailSenders.directCount,
        listCount: emailSenders.listCount,
        automatedCount: emailSenders.automatedCount,
        marketingCount: emailSenders.marketingCount,
        firstSeenAt: emailSenders.firstSeenAt,
        lastSeenAt: emailSenders.lastSeenAt,
        sourceAccountId: emailSenders.sourceAccountId,
      })
      .from(emailSenders)
      .where(and(...conds))
      .orderBy(desc(emailSenders.messageCount), desc(emailSenders.lastSeenAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(emailSenders)
      .where(and(...conds)),
    tab === 'pending'
      ? db
          .select({ c: sql<number>`count(*)::int` })
          .from(emailSenders)
          .where(and(...bulkConds))
      : Promise.resolve([{ c: 0 }]),
  ]);
  const total = totalRow[0]?.c ?? 0;
  const bulkMarketingCount = bulkMarketingRow[0]?.c ?? 0;

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
      <SetPageTitle title="Senders" />

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

      <div className="flex flex-wrap items-center justify-between gap-2">
        <KindFilter active={kind} tab={tab} search={search} />
        {/*
          Bulk-deny visibility — show only when the action lines up with
          what the operator is currently looking at:
            - the pending tab (it's the only tab where deny makes sense)
            - AND no kind filter, OR specifically the marketing filter
          When the operator is filtered to list / automated / direct, the
          button would be confusing — it'd deny senders they can't see.
          The action's WHERE clause still scopes to marketing globally, so
          it stays correct even if shown in those contexts; we just hide
          it for clarity.
        */}
        {tab === 'pending' && (kind === null || kind === 'marketing') && (
          <DenyMarketingButton count={bulkMarketingCount} search={search} />
        )}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {search && kind
            ? `No ${tab} ${kind} senders match “${search}”.`
            : kind
              ? `No ${tab} senders classified as ${kind} yet.`
              : search
                ? `No ${tab} senders match “${search}”.`
                : tab === 'pending'
                  ? 'No pending senders. Connect an IMAP account or wait for the next sync.'
                  : `No ${tab} senders yet.`}
        </p>
      ) : (
        <div className="rounded-md border border-border">
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const accountAddr = r.sourceAccountId ? accountById.get(r.sourceAccountId) : undefined;
            const domainOverride = domainStatus.get(r.domain);
            const rowKind = dominantKind(r);
            // hrefBase that preserves the operator's current tab + search so
            // tapping a pill narrows without losing context.
            const pillHrefBase =
              `/settings/senders?tab=${tab}` + (search ? `&q=${encodeURIComponent(search)}` : '');
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
                    <KindPill kind={rowKind} hrefBase={pillHrefBase} />
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
        <SendersPager page={page} total={total} pageSize={PAGE_SIZE} />
        </div>
      )}
    </div>
  );
}
