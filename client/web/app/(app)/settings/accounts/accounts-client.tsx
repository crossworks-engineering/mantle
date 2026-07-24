'use client';

/**
 * Email-accounts master-detail (Phase 2 · Task 4). URL-driven like the old
 * server page (`?selected=&mode=add|edit|folders`), but the account list comes
 * from `GET /api/email/accounts` and the folder tree from
 * `GET /api/email/accounts/[id]/folders` — no SSR props, no in-process DB read.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, FolderTree, Mail, Pencil, Plus, SlidersHorizontal } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { PublicEmailAccount, SyncRun, AccountFoldersResult } from '@mantle/email';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import { Button } from '@mantle/web-ui/ui/button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { cn } from '@mantle/web-ui/lib/utils';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { ImapForm } from './imap/imap-form';
import { FolderPicker } from './[id]/folders/folder-picker';

type AccountRow = PublicEmailAccount;
interface ImapCursorShape {
  folders?: Record<string, { uidvalidity: number; lastUid: number }>;
}

type AccountsView = { accounts: AccountRow[]; latestRuns: Record<string, SyncRun> };

export function AccountsClient() {
  const sp = useSearchParams();
  const connected = sp.get('connected');
  const error = sp.get('error');
  const modeParam = sp.get('mode');
  const mode =
    modeParam === 'add' || modeParam === 'edit' || modeParam === 'folders' ? modeParam : null;

  const accountsQuery = useQuery({
    queryKey: ['email', 'accounts'],
    queryFn: () => apiFetch<AccountsView>('/api/email/accounts'),
  });

  const rows = accountsQuery.data?.accounts ?? [];
  const latestRuns = accountsQuery.data?.latestRuns ?? {};

  const showAdd = mode === 'add' || rows.length === 0;
  const selectedId = showAdd ? null : (sp.get('selected') ?? rows[0]?.id ?? null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  // Live IMAP folder tree, only when the folders pane is open.
  const foldersQuery = useQuery({
    queryKey: ['email', 'accounts', selected?.id, 'folders'],
    queryFn: () => apiFetch<AccountFoldersResult>(`/api/email/accounts/${selected!.id}/folders`),
    enabled: mode === 'folders' && !!selected,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  if (accountsQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (accountsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
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

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: account list ─────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Accounts
          </h2>
          <Button asChild size="sm">
            <Link href="/settings/accounts?mode=add">
              <Plus /> Add
            </Link>
          </Button>
        </div>
        <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              No accounts yet. Click <strong>Add</strong> to connect one.
            </p>
          ) : (
            rows.map((r) => {
              const latest = latestRuns[r.id];
              const isSelected = !showAdd && selectedId === r.id;
              return (
                <Link
                  key={r.id}
                  href={`/settings/accounts?selected=${r.id}`}
                  className={cn(
                    'block rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 transition-colors hover:bg-muted/50',
                    isSelected && 'border-l-primary',
                    !r.enabled && 'opacity-70',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate text-sm font-medium">{r.address}</span>
                    <span className={cn('ml-auto shrink-0', statusBadgeClass(r, latest))}>
                      {statusLabel(r, latest)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.provider}
                    {r.provider === 'imap' && r.imapHost ? ` · ${r.imapHost}:${r.imapPort}` : ''}
                  </div>
                  {r.lastSyncError && (
                    <div className="mt-0.5 truncate text-xs text-destructive">
                      ⚠ {r.lastSyncError}
                    </div>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>

      {/* ── Right: add / edit / folders / detail ───────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {(connected || error) && (
          <div className="p-4 pb-0">
            {connected && (
              <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
                Connected <span className="font-medium">{connected}</span>. First sync runs within
                two minutes.
              </p>
            )}
            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        )}

        {showAdd ? (
          <div className="max-w-md space-y-4 p-6">
            <div>
              <h2 className="text-lg font-semibold">Add IMAP account</h2>
              <p className="text-xs text-muted-foreground">
                Gmail and most providers connect over IMAP with an app password.
              </p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Microsoft 365 / Outlook.com mailbox? Connect it with OAuth on the{' '}
              <Link
                href="/settings/microsoft"
                className="text-primary underline-offset-2 hover:underline"
              >
                Microsoft page
              </Link>{' '}
              instead — Microsoft has retired app-password IMAP for most accounts.
            </div>
            <ImapForm />
            <p className="text-xs text-muted-foreground">
              Generate an app password (
              <a
                className="underline"
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
              >
                Google
              </a>
              ), enable 2FA, then paste it above with the provider&apos;s host (e.g.{' '}
              <code className="font-mono">imap.gmail.com</code>).
            </p>
          </div>
        ) : mode === 'edit' && selected ? (
          <div className="max-w-md space-y-4 p-6">
            <div className="space-y-1">
              <BackLink href={`/settings/accounts?selected=${selected.id}`}>Back</BackLink>
              <h2 className="text-lg font-semibold">Edit {selected.address}</h2>
            </div>
            {selected.provider === 'microsoft' ? (
              <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                This mailbox is a connected Microsoft account — there&apos;s no IMAP config to edit.
                Manage it (including the Outlook mail toggle) on the{' '}
                <Link
                  href="/settings/microsoft"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  Microsoft page
                </Link>
                .
              </p>
            ) : (
              <ImapForm
                account={{
                  id: selected.id,
                  address: selected.address,
                  displayName: selected.displayName,
                  imapHost: selected.imapHost,
                  imapPort: selected.imapPort,
                  imapSecure: selected.imapSecure,
                  smtpHost: selected.smtpHost,
                  smtpPort: selected.smtpPort,
                  smtpSecure: selected.smtpSecure,
                  firstScanDays: selected.firstScanDays,
                }}
              />
            )}
          </div>
        ) : mode === 'folders' && selected ? (
          <div className="max-w-2xl space-y-4 p-6">
            <div className="space-y-1">
              <BackLink href={`/settings/accounts?selected=${selected.id}`}>Back</BackLink>
              <h2 className="text-lg font-semibold">Folders to scan — {selected.address}</h2>
              <p className="text-sm text-muted-foreground">
                Which IMAP folders Mantle scans. Mail is still only ingested from people in your{' '}
                <Link href="/contacts" className="text-primary underline-offset-2 hover:underline">
                  contacts
                </Link>
                .
              </p>
            </div>
            {foldersQuery.isPending ? (
              <div className="flex items-center justify-center py-10">
                <Spinner />
              </div>
            ) : foldersQuery.isError ? (
              <FoldersError
                accountId={selected.id}
                message={
                  foldersQuery.error instanceof Error ? foldersQuery.error.message : 'unknown error'
                }
              />
            ) : foldersQuery.data.ok ? (
              <FolderPicker
                accountId={selected.id}
                allFolders={foldersQuery.data.allFolders}
                included={foldersQuery.data.included}
                excluded={foldersQuery.data.excluded}
                scanned={foldersQuery.data.scanned}
              />
            ) : (
              <FoldersError accountId={selected.id} message={foldersQuery.data.error} />
            )}
          </div>
        ) : selected ? (
          <AccountDetail account={selected} latest={latestRuns[selected.id]} />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select an account, or add one.
          </div>
        )}
      </div>
    </div>
  );
}

function FoldersError({ accountId, message }: { accountId: string; message: string }) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        Couldn’t list folders: {message}
      </div>
      <Link
        href={`/settings/accounts?selected=${accountId}&mode=folders`}
        className="text-sm text-primary underline-offset-2 hover:underline"
      >
        Retry
      </Link>
    </div>
  );
}

function statusLabel(r: AccountRow, latest: SyncRun | undefined): string {
  if (latest?.status === 'running') return 'syncing';
  return r.enabled ? 'idle' : 'paused';
}

function statusBadgeClass(r: AccountRow, latest: SyncRun | undefined): string {
  const base = 'rounded-full px-2 py-0.5 text-xs';
  if (latest?.status === 'running')
    return `${base} bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100`;
  if (r.enabled) return `${base} bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100`;
  return `${base} bg-muted text-muted-foreground`;
}

function AccountDetail({
  account: r,
  latest,
}: {
  account: AccountRow;
  latest: SyncRun | undefined;
}) {
  const imapCursor = (r.syncState as { imap?: ImapCursorShape } | null)?.imap;
  const touchedFolders = imapCursor?.folders ? Object.keys(imapCursor.folders).sort() : [];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 truncate text-lg font-semibold">
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {r.address}
          </h2>
          <p className="text-xs text-muted-foreground">
            {r.provider}
            {r.provider === 'imap' && r.imapHost ? ` · ${r.imapHost}:${r.imapPort}` : ''} · last
            sync {formatDateTime(r.lastSyncAt ?? null)}
          </p>
        </div>
        <span className={cn('shrink-0', statusBadgeClass(r, latest))}>
          {statusLabel(r, latest)}
        </span>
      </div>

      {r.lastSyncError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          ⚠ {r.lastSyncError}
        </p>
      )}

      {latest && (
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Activity className="size-3.5 shrink-0" aria-hidden />
          <span>
            Last run: <span className="text-foreground">{latest.status}</span>
            {latest.durationMs != null && ` in ${(latest.durationMs / 1000).toFixed(1)}s`} · scanned{' '}
            <span className="text-foreground">{latest.scanned}</span> · ingested{' '}
            <span className="text-foreground">{latest.ingested}</span>
          </span>
        </div>
      )}

      {r.provider === 'imap' && (
        <div className="space-y-1.5 text-sm text-muted-foreground">
          <div className="flex items-start gap-1.5">
            <FolderTree className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              {touchedFolders.length > 0 ? (
                <>
                  <span className="font-medium text-foreground">Scanning:</span>{' '}
                  {touchedFolders.join(', ')}
                </>
              ) : (
                <span className="italic">No folders touched yet — first sync still pending.</span>
              )}
            </div>
          </div>
          {r.imapExcludedFolders.length > 0 && (
            <div className="pl-6">
              <span className="font-medium text-foreground">Excluded:</span>{' '}
              {r.imapExcludedFolders.join(', ')}
            </div>
          )}
          {r.imapIncludedFolders && r.imapIncludedFolders.length > 0 && (
            <div className="pl-6">
              <span className="font-medium text-foreground">Only:</span>{' '}
              {r.imapIncludedFolders.join(', ')}
            </div>
          )}
          <div className="pl-6">
            <span className="font-medium text-foreground">History:</span> first scan reaches back{' '}
            {r.firstScanDays} days
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {r.provider === 'microsoft' ? (
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/microsoft">
              <SlidersHorizontal /> Manage Microsoft account
            </Link>
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link href={`/settings/accounts?selected=${r.id}&mode=edit`}>
              <Pencil /> Edit account
            </Link>
          </Button>
        )}
        {r.provider === 'imap' && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/settings/accounts?selected=${r.id}&mode=folders`}>
              <SlidersHorizontal /> Configure folders
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
