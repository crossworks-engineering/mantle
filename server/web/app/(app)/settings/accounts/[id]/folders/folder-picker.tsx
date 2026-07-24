'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SubmitButton } from '@mantle/web-ui/ui/submit-button';
import { useToast } from '@mantle/web-ui/ui/toast';
import { apiSend } from '@mantle/web-ui/api-fetch';

/**
 * Checkbox picker over an account's IMAP folders. On submit it PUTs the checked,
 * non-excluded folders to `/api/email/accounts/[id]/folders` and lands on the
 * accounts list. Empty selection ⇒ the endpoint stores NULL = "scan all
 * non-excluded".
 */
export function FolderPicker({
  accountId,
  allFolders,
  included,
  excluded,
  scanned,
}: {
  accountId: string;
  allFolders: string[];
  included: string[] | null;
  excluded: string[];
  scanned: string[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const scannedSet = useMemo(() => new Set(scanned), [scanned]);
  // Prefill: the explicit include-list if set; otherwise the folders the sync
  // has actually been touching, so the default state mirrors today's behaviour.
  const initial = useMemo(
    () => new Set(included && included.length > 0 ? included : scanned),
    [included, scanned],
  );
  const [checked, setChecked] = useState<Set<string>>(initial);

  const selectable = useMemo(
    () => allFolders.filter((f) => !excludedSet.has(f)),
    [allFolders, excludedSet],
  );

  function toggle(folder: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }
  function setAll(on: boolean) {
    setChecked(on ? new Set(selectable) : new Set());
  }

  const save = useMutation({
    // Only checked, non-excluded folders. Empty array = "scan all non-excluded".
    mutationFn: () =>
      apiSend(`/api/email/accounts/${accountId}/folders`, 'PUT', {
        folders: selectable.filter((f) => checked.has(f)),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['email', 'accounts'] });
      // Land on the probe-free list — re-rendering the folders pane re-probes IMAP
      // (slow/flaky) and contends with the rescan we just kicked.
      router.push('/settings/accounts');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-4"
    >
      {included === null && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Currently scanning <strong>all non-excluded folders</strong>. Pick a subset to scan only
          those. Saving with nothing checked reverts to scanning all.
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {checked.size} of {selectable.length} selected
        </p>
        <div className="flex gap-3 text-xs">
          <button
            type="button"
            onClick={() => setAll(true)}
            className="underline-offset-2 hover:underline"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setAll(false)}
            className="underline-offset-2 hover:underline"
          >
            Clear
          </button>
        </div>
      </div>

      <ul className="divide-y divide-border rounded-md border border-border">
        {allFolders.map((folder) => {
          const isExcluded = excludedSet.has(folder);
          return (
            <li key={folder} className="flex items-center gap-3 px-3 py-2 text-sm">
              <input
                type="checkbox"
                name="folders"
                value={folder}
                checked={!isExcluded && checked.has(folder)}
                disabled={isExcluded}
                onChange={() => toggle(folder)}
                className="size-4 accent-primary"
              />
              <span className={isExcluded ? 'text-muted-foreground line-through' : ''}>
                {folder}
              </span>
              {isExcluded ? (
                <span className="ml-auto text-xs text-muted-foreground">excluded</span>
              ) : scannedSet.has(folder) ? (
                <span className="ml-auto text-xs text-muted-foreground">scanning</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        Newly-added folders stay empty until the next sync runs and their senders are approved.
        Saving kicks an immediate rescan.
      </p>

      <SubmitButton pending={save.isPending}>Save &amp; rescan</SubmitButton>
    </form>
  );
}
