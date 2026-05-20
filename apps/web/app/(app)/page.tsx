import Link from 'next/link';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { Mail, Plug, UserCheck } from 'lucide-react';
import { db, emailAccounts, emails, emailAttachments, emailSenders } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { EmailRow } from '@/components/email-row';
import { parseSort, type SortKey } from '@/components/inbox-sort';
import { InboxToolbar } from '@/components/inbox-toolbar';
import { ReadingPane } from '@/components/reading-pane';
import { FleetLayout } from '@/components/layout/fleet-layout';

const INBOX_LIMIT = 100;

/** Translate a sort key to the right ORDER BY clause. */
function orderClause(key: SortKey): SQL {
  switch (key) {
    case 'date_asc':
      return asc(emails.internalDate);
    case 'ingested_desc':
      return desc(emails.createdAt);
    case 'from_asc':
      return asc(emails.fromAddr);
    case 'date_desc':
    default:
      return desc(emails.internalDate);
  }
}

/** Build a same-page URL that preserves `sort` and swaps `email`. */
function rowHref(sort: SortKey, emailId: string): string {
  const params = new URLSearchParams();
  if (sort !== 'date_desc') params.set('sort', sort);
  params.set('email', emailId);
  return `/?${params.toString()}`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; email?: string }>;
}) {
  const user = await requireOwner();
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const selectedId = params.email;

  // Auto-mark-read on view. Runs before the list/selected queries so the
  // very same render reflects the flip (no second navigation needed).
  // Idempotent: the `is_read = false` clause keeps it a no-op once already
  // read, and the account subquery scopes it to this user's mail.
  if (selectedId) {
    const ownedAccounts = db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, user.id));
    await db
      .update(emails)
      .set({ isRead: true })
      .where(
        and(
          eq(emails.id, selectedId),
          eq(emails.isRead, false),
          inArray(emails.accountId, ownedAccounts),
        ),
      );
  }

  // Gate: no connected accounts → connect prompt.
  const accounts = await db
    .select({ id: emailAccounts.id, address: emailAccounts.address })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, user.id));
  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-16 text-center">
        <Mail className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-xl font-semibold">Your inbox is empty because nothing's plugged in.</h2>
        <p className="text-sm text-muted-foreground">
          Connect your first email account and Mantle will start pulling messages, attachments, and
          metadata into your tree.
        </p>
        <Button asChild>
          <Link href="/settings/accounts">
            <Plug className="mr-2 size-4" aria-hidden /> Connect an account
          </Link>
        </Button>
      </div>
    );
  }

  // Gate: account is connected but no approved senders → curation nudge.
  const [approvedCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'approved')));
  if ((approvedCount?.n ?? 0) === 0) {
    const [pendingCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(emailSenders)
      .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')));
    const pending = pendingCount?.n ?? 0;
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-16 text-center">
        <UserCheck className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-xl font-semibold">
          {pending > 0 ? `${pending} senders waiting for review.` : 'Scanning your mailbox…'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {pending > 0
            ? "Approve the senders worth keeping. Mantle only stores bodies and attachments for senders you've green-lit — newsletters never touch your disk."
            : 'The first sync is running. Senders will appear here as Mantle scans the last 12 months of headers.'}
        </p>
        {pending > 0 && (
          <Button asChild>
            <Link href="/settings/senders">Review senders</Link>
          </Button>
        )}
      </div>
    );
  }

  // List for the left column.
  const rows = await db
    .select({
      id: emails.id,
      fromAddr: emails.fromAddr,
      fromName: emails.fromName,
      subject: emails.subject,
      snippet: emails.snippet,
      internalDate: emails.internalDate,
      isRead: emails.isRead,
    })
    .from(emails)
    .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
    .where(eq(emailAccounts.userId, user.id))
    .orderBy(orderClause(sort))
    .limit(INBOX_LIMIT);

  // Selected email for the right column (full row + attachments). Owner-
  // scoped via the join so a stolen UUID can't surface another user's mail.
  const selectedEmail = selectedId
    ? (
        await db
          .select()
          .from(emails)
          .innerJoin(emailAccounts, eq(emails.accountId, emailAccounts.id))
          .where(and(eq(emails.id, selectedId), eq(emailAccounts.userId, user.id)))
          .limit(1)
      )[0]?.emails ?? null
    : null;
  const attachments = selectedEmail
    ? await db
        .select()
        .from(emailAttachments)
        .where(eq(emailAttachments.emailId, selectedEmail.id))
    : [];

  return (
    <FleetLayout
      leftClassName="flex-1 lg:flex-none lg:w-2/5"
      rightClassName="lg:w-3/5"
      left={
        <div className="-mr-1">
          <div className="sticky top-0 z-10 bg-background">
            <InboxToolbar sort={sort} count={rows.length} />
          </div>
          <div className="divide-y divide-border">
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                First sync hasn't landed yet. The worker polls every couple of minutes.
              </p>
            ) : (
              rows.map((r) => (
              <EmailRow
                key={r.id}
                id={r.id}
                fromAddr={r.fromAddr}
                fromName={r.fromName}
                subject={r.subject}
                snippet={r.snippet}
                internalDate={r.internalDate}
                isRead={r.isRead}
                selected={r.id === selectedId}
                href={rowHref(sort, r.id)}
              />
              ))
            )}
          </div>
        </div>
      }
      right={<ReadingPane email={selectedEmail} attachments={attachments} />}
    />
  );
}
