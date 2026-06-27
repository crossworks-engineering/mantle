'use client';

import { useQuery } from '@tanstack/react-query';
import type { AccountFoldersResult } from '@mantle/email';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api-fetch';
import { FolderPicker } from './folder-picker';

/** Fetches the live IMAP folder tree for an account and renders the picker.
 *  The folder probe is a slow live read, so it's staleTime: Infinity. */
export function AccountFoldersClient({ accountId }: { accountId: string }) {
  const q = useQuery({
    queryKey: ['email', 'accounts', accountId, 'folders'],
    queryFn: () => apiFetch<AccountFoldersResult>(`/api/email/accounts/${accountId}/folders`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // A folder probe can fail two ways: the HTTP call throws (q.isError) or the
  // payload reports ok:false (an IMAP-level error). Render both the same.
  const failure = (message: string) => (
    <div className="space-y-2">
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        Couldn’t list folders: {message}
      </div>
      <button
        type="button"
        onClick={() => q.refetch()}
        className="text-sm text-primary underline-offset-2 hover:underline"
      >
        Retry
      </button>
    </div>
  );

  if (q.isPending) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }
  if (q.isError) {
    return failure(q.error instanceof Error ? q.error.message : 'unknown error');
  }
  if (!q.data.ok) {
    return failure(q.data.error);
  }

  return (
    <FolderPicker
      accountId={accountId}
      allFolders={q.data.allFolders}
      included={q.data.included}
      excluded={q.data.excluded}
      scanned={q.data.scanned}
    />
  );
}
