import Link from 'next/link';
import { cookies } from 'next/headers';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Mail, Plug, UserCheck } from 'lucide-react';
import { db, emailAccounts, emails, emailAttachments, emailSenders } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { EmailRow } from '@/components/email-row';
import { ReadingPane } from '@/components/reading-pane';
import { MailClient } from '@/components/mail/mail-client';
import { SetPageTitle } from '@/components/layout/page-title';
import { folderLabel } from '@/components/mail/folder-icon';
import type { FolderLink } from '@/components/mail/mail-nav';

const INBOX_LIMIT = 100;

type Search = { account?: string; folder?: string; tab?: string; email?: string };

/** Build a /inbox URL preserving the 3-pane navigation context. */
function inboxHref(p: {
  account: string;
  folder?: string | null;
  tab?: string;
  email?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('account', p.account);
  if (p.folder) params.set('folder', p.folder);
  if (p.tab && p.tab !== 'all') params.set('tab', p.tab);
  if (p.email) params.set('email', p.email);
  return `/inbox?${params.toString()}`;
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireOwner();
  const params = await searchParams;

  // Gate: no connected accounts → connect prompt.
  const accounts = await db
    .select({ id: emailAccounts.id, address: emailAccounts.address, provider: emailAccounts.provider })
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, user.id))
    .orderBy(emailAccounts.address);
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
            <Plug aria-hidden /> Connect an account
          </Link>
        </Button>
      </div>
    );
  }

  // Gate: account connected but no approved senders → curation nudge.
  const [approvedCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'approved')));
  const [pendingRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailSenders)
    .where(and(eq(emailSenders.userId, user.id), eq(emailSenders.status, 'pending')));
  const pendingCount = pendingRow?.n ?? 0;
  if ((approvedCount?.n ?? 0) === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-6 py-16 text-center">
        <UserCheck className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h2 className="text-xl font-semibold">
          {pendingCount > 0 ? `${pendingCount} senders waiting for review.` : 'Scanning your mailbox…'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {pendingCount > 0
            ? "Approve the senders worth keeping. Mantle only stores bodies and attachments for senders you've green-lit — newsletters never touch your disk."
            : 'The first sync is running. Senders will appear here as Mantle scans the last 12 months of headers.'}
        </p>
        {pendingCount > 0 && (
          <Button asChild>
            <Link href="/settings/senders">Review senders</Link>
          </Button>
        )}
      </div>
    );
  }

  // Resolve the selected account (param if owned, else first).
  const currentAccount = accounts.find((a) => a.id === params.account) ?? accounts[0]!;
  const accountId = currentAccount.id;

  // Auto-mark-read on view. Owner-scoped + idempotent (no-op once read).
  const selectedId = params.email;
  if (selectedId) {
    const owned = db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, user.id));
    await db
      .update(emails)
      .set({ isRead: true })
      .where(
        and(eq(emails.id, selectedId), eq(emails.isRead, false), inArray(emails.accountId, owned)),
      );
  }

  // Folder facets for the selected account (drives the nav). Counts reflect
  // INGESTED mail, not server totals — a freshly-enabled folder reads 0 until
  // its sync + sender approvals land.
  const facetRows = await db
    .select({
      folder: emails.folder,
      n: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${emails.isRead} = false)::int`,
    })
    .from(emails)
    .where(eq(emails.accountId, accountId))
    .groupBy(emails.folder)
    .orderBy(desc(sql`count(*)`));

  const facetNames = facetRows.map((f) => f.folder).filter((f): f is string => !!f);
  const selectedFolder =
    (params.folder && facetNames.includes(params.folder) ? params.folder : null) ??
    facetNames.find((f) => f.toUpperCase() === 'INBOX') ??
    facetNames[0] ??
    null;

  const tab: 'all' | 'unread' = params.tab === 'unread' ? 'unread' : 'all';

  const folders: FolderLink[] = facetRows
    .filter((f): f is { folder: string; n: number; unread: number } => !!f.folder)
    .map((f) => ({
      name: f.folder,
      count: f.n,
      unread: f.unread,
      active: f.folder === selectedFolder,
      href: inboxHref({ account: accountId, folder: f.folder, tab }),
    }));

  // Message list for the centre pane.
  const listConds = [eq(emails.accountId, accountId)];
  if (selectedFolder) listConds.push(eq(emails.folder, selectedFolder));
  if (tab === 'unread') listConds.push(eq(emails.isRead, false));
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
    .where(and(...listConds))
    .orderBy(desc(emails.internalDate))
    .limit(INBOX_LIMIT);

  // Selected email + attachments. Owner-scoped via the join so a stolen UUID
  // (even from another account) can't surface another user's mail.
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
    ? await db.select().from(emailAttachments).where(eq(emailAttachments.emailId, selectedEmail.id))
    : [];

  // Restore the nav-collapsed state from the cookie the shell writes.
  const cookieStore = await cookies();
  const defaultCollapsed = cookieStore.get('react-resizable-panels:collapsed')?.value === 'true';

  const folderTitle = selectedFolder ? folderLabel(selectedFolder) : 'All mail';

  const listSlot =
    rows.length === 0 ? (
      <p className="px-4 py-6 text-sm text-muted-foreground">No messages here yet.</p>
    ) : (
      <div className="divide-y divide-border">
        {rows.map((r) => (
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
            href={inboxHref({ account: accountId, folder: selectedFolder, tab, email: r.id })}
          />
        ))}
      </div>
    );

  return (
    <>
    <SetPageTitle title="Inbox" />
    <MailClient
      accounts={accounts}
      currentAccountId={accountId}
      folders={folders}
      folderTitle={folderTitle}
      tab={tab}
      tabAllHref={inboxHref({ account: accountId, folder: selectedFolder, tab: 'all', email: selectedId })}
      tabUnreadHref={inboxHref({
        account: accountId,
        folder: selectedFolder,
        tab: 'unread',
        email: selectedId,
      })}
      pendingCount={pendingCount}
      defaultCollapsed={defaultCollapsed}
      listSlot={listSlot}
      readerSlot={<ReadingPane email={selectedEmail} attachments={attachments} />}
    />
    </>
  );
}
