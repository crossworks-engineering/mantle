import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
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
      <header className="space-y-1">
        <Link
          href="/settings/accounts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden /> Accounts
        </Link>
        <h1 className="text-2xl font-semibold">Folders to scan</h1>
        {result.ok ? (
          <p className="text-sm text-muted-foreground">{result.address}</p>
        ) : null}
      </header>

      <p className="text-sm text-muted-foreground">
        Choose which IMAP folders Mantle scans for this account. Mail is still only ingested from{' '}
        <Link href="/settings/senders" className="text-primary underline-offset-2 hover:underline">
          approved senders
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
