import Link from 'next/link';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { listAccountFolders } from '../../folders-actions';
import { FolderPicker } from './folder-picker';

/**
 * Per-account "which IMAP folders do we scan?" config. Server-rendered;
 * `listAccountFolders` hits the live IMAP server (owner-scoped) and returns
 * the full folder tree plus the current selection, so the picker can prefill.
 */
export default async function AccountFoldersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwner();
  const { id } = await params;
  const result = await listAccountFolders(id);

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

      {result.ok ? (
        <FolderPicker
          accountId={id}
          allFolders={result.allFolders}
          included={result.included}
          excluded={result.excluded}
          scanned={result.scanned}
        />
      ) : (
        <div className="space-y-2">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Couldn’t list folders: {result.error}
          </div>
          <Link
            href={`/settings/accounts/${id}/folders`}
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            Retry
          </Link>
        </div>
      )}
    </div>
  );
}
