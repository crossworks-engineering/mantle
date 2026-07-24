'use client';

/**
 * Discover unknown senders — a live mailbox scan (nothing persisted) of who's
 * recently emailed you but isn't yet a contact, so their mail isn't being
 * ingested. One click promotes a sender to a contact (and backfills 90 days).
 *
 * All data is client-fetched (Phase 2 · Task 4): the enabled-account gate via
 * `GET /api/email/accounts`, the scan via `GET /api/email/discover`, and the
 * promote via `POST /api/email/discover/contacts`.
 */
import Link from 'next/link';
import { Loader2, Plug, RefreshCw, UserPlus } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@mantle/web-ui/ui/button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { useToast } from '@mantle/web-ui/ui/toast';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { apiFetch, apiSend } from '@mantle/web-ui/api-fetch';

/** A recent sender who isn't a contact yet — wire shape of `/api/email/discover`. */
type UnknownSender = {
  fromAddr: string;
  fromName?: string;
  count: number;
  lastDate: string; // ISO
  subject?: string;
};

export function DiscoverClient() {
  const toast = useToast();
  const queryClient = useQueryClient();

  // Gate: any enabled account can be scanned — IMAP directly, Microsoft
  // companions over Graph (the discover API resolves the provider per row).
  const accountsQuery = useQuery({
    queryKey: ['email', 'accounts'],
    queryFn: () =>
      apiFetch<{ accounts: { provider: string; enabled: boolean }[] }>('/api/email/accounts').then(
        (r) => r.accounts,
      ),
  });
  const hasAccounts = (accountsQuery.data ?? []).some((a) => a.enabled);

  const scanQuery = useQuery({
    queryKey: ['email', 'discover'],
    queryFn: () =>
      apiFetch<{ ok: true; senders: UnknownSender[] }>('/api/email/discover').then(
        (r) => r.senders,
      ),
    enabled: hasAccounts,
    // A live mailbox read — don't auto-refetch on focus/remount.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const addContact = useMutation({
    mutationFn: (s: UnknownSender) =>
      apiSend<{ ok: true; id: string }>('/api/email/discover/contacts', 'POST', {
        address: s.fromAddr,
        displayName: s.fromName,
      }),
    onSuccess: (_res, s) => {
      toast.success(`Added ${s.fromName || s.fromAddr} — backfilling their mail`);
      // Optimistically drop the row rather than re-running the slow mailbox scan.
      queryClient.setQueryData<UnknownSender[]>(['email', 'discover'], (old) =>
        (old ?? []).filter((x) => x.fromAddr !== s.fromAddr),
      );
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  if (accountsQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (accountsQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p className="text-muted-foreground">
          {accountsQuery.error instanceof Error
            ? accountsQuery.error.message
            : 'Failed to load accounts.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => accountsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!hasAccounts) {
    return (
      <div className="space-y-4 rounded-lg border border-border bg-muted/20 px-6 py-12 text-center">
        <Plug className="mx-auto size-7 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          No email accounts connected yet — connect one to discover senders.
        </p>
        <Button asChild>
          <Link href="/settings/accounts">
            <Plug aria-hidden /> Connect an account
          </Link>
        </Button>
      </div>
    );
  }

  const senders = scanQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Recent senders (last 30 days) who aren&apos;t in your contacts — so their mail isn&apos;t
          being ingested. Add the ones worth keeping.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => scanQuery.refetch()}
          disabled={scanQuery.isFetching}
        >
          {scanQuery.isFetching ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <RefreshCw aria-hidden />
          )}
          Rescan
        </Button>
      </div>

      {scanQuery.isPending || scanQuery.isFetching ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Scanning your mailbox…
        </div>
      ) : scanQuery.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {scanQuery.error instanceof Error ? scanQuery.error.message : 'Scan failed.'}
        </div>
      ) : senders.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No unknown senders in the last 30 days — everyone who&apos;s written is already a contact.
        </div>
      ) : (
        <ul className="space-y-2">
          {senders.map((s) => (
            <li
              key={s.fromAddr}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.fromName || s.fromAddr}</div>
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  {s.fromName && <span className="truncate">{s.fromAddr}</span>}
                  <span className="whitespace-nowrap">
                    {s.count} msg{s.count === 1 ? '' : 's'}
                  </span>
                  <span className="whitespace-nowrap">last {formatDateTime(s.lastDate)}</span>
                </div>
                {s.subject && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                    “{s.subject}”
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={() => addContact.mutate(s)}
                disabled={addContact.isPending && addContact.variables?.fromAddr === s.fromAddr}
              >
                {addContact.isPending && addContact.variables?.fromAddr === s.fromAddr ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <UserPlus aria-hidden />
                )}
                Add as contact
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
