import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { AccountFoldersClient } from './folders-client';

/**
 * Per-account "which IMAP folders do we scan?" config (auth gate only). The live
 * folder tree is fetched client-side via `GET /api/email/accounts/[id]/folders`
 * (Phase 2 · Task 4).
 */
export default async function AccountFoldersPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <SetPageTitle title="Folders to scan" />
      <header className="space-y-1">
        <BackLink href="/settings/accounts">Accounts</BackLink>
      </header>

      <p className="text-sm text-muted-foreground">
        Choose which IMAP folders Mantle scans for this account. Mail is still only ingested from
        people in your{' '}
        <Link href="/contacts" className="text-primary underline-offset-2 hover:underline">
          contacts
        </Link>{' '}
        — this just controls which mailboxes get looked at.
      </p>

      <AccountFoldersClient accountId={id} />
    </div>
  );
}
