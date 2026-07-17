'use client';

/**
 * Microsoft settings orchestrator — fetches the Azure-app config + connected
 * accounts and renders the config form, the connect affordance, the OAuth
 * result banner, and each account (with its mail + drives sub-pickers, which
 * self-fetch). Replaces the old server-rendered page body (Phase 2 · Task 4).
 */

import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Cloud, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { MsConfigStatus, PublicMsAccount } from '@mantle/microsoft';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatDateTime } from '@/lib/format-datetime';
import { apiFetch } from '@/lib/api-fetch';
import { DisconnectButton } from './disconnect-button';
import { MsConfigForm } from './config-form';
import { DrivesList } from './drives-list';
import { MailToggle } from './mail-toggle';

type ConfigPayload = { status: MsConfigStatus; suggestedRedirectUri: string };

export function MicrosoftClient() {
  const sp = useSearchParams();
  const connected = sp.get('connected');
  const error = sp.get('error');

  const configQuery = useQuery({
    queryKey: ['microsoft', 'config'],
    queryFn: () => apiFetch<ConfigPayload>('/api/microsoft/config'),
  });
  const accountsQuery = useQuery({
    queryKey: ['microsoft', 'accounts'],
    queryFn: () =>
      apiFetch<{ accounts: PublicMsAccount[] }>('/api/microsoft/accounts').then((r) => r.accounts),
  });

  if (configQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (configQuery.isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p className="text-muted-foreground">
          {configQuery.error instanceof Error ? configQuery.error.message : 'Failed to load.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => configQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const { status, suggestedRedirectUri } = configQuery.data;
  const accounts = accountsQuery.data ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Cloud className="size-5 text-muted-foreground" aria-hidden />
            Microsoft accounts
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect a Microsoft 365 account to bring SharePoint, OneDrive, and Outlook into Mantle.
            Sign-in is delegated — Mantle only sees what you can.
          </p>
        </div>
        {status.configured && (
          <Button asChild size="sm">
            {/* Plain anchor: this is an API route that 302s to Microsoft, not client nav. */}
            <a href="/api/microsoft/oauth/start">
              <Plus /> Connect
            </a>
          </Button>
        )}
      </div>

      {connected && (
        <p className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Connected <span className="font-medium">{connected}</span>.
        </p>
      )}
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error === 'not_configured'
            ? 'Microsoft integration isn’t configured yet — fill in the Azure app details below.'
            : error}
        </p>
      )}

      {/* Azure app config — UI-editable (DB row overrides MS_* env). */}
      <MsConfigForm status={status} suggestedRedirectUri={suggestedRedirectUri} />

      {/* Connected accounts */}
      {accountsQuery.isPending ? (
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
      ) : status.configured && accounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No accounts connected. Click <strong>Connect</strong> to sign in with Microsoft.
        </p>
      ) : (
        accounts.length > 0 && (
          <div className="space-y-4">
            {accounts.map((r) => {
              const needsReconnect = !r.hasAccessToken || !r.hasRefreshToken;
              return (
                <div key={r.id} className="space-y-2">
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.upn}</span>
                        <span
                          className={
                            needsReconnect
                              ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive'
                              : 'rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-900 dark:bg-green-950 dark:text-green-100'
                          }
                        >
                          {needsReconnect ? 'needs reconnect' : 'connected'}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {r.displayName ? `${r.displayName} · ` : ''}
                        {r.scopes.length} scope{r.scopes.length === 1 ? '' : 's'} · token valid
                        until {formatDateTime(r.tokenExpiresAt ?? null)}
                      </div>
                      {r.lastSyncError && (
                        <div className="mt-0.5 truncate text-xs text-destructive">
                          ⚠ {r.lastSyncError}
                        </div>
                      )}
                    </div>
                    <DisconnectButton accountId={r.id} upn={r.upn} />
                  </div>
                  {!needsReconnect && (
                    // 'Mail.Send' as a literal: MAIL_SEND_SCOPE lives in the
                    // server-only package root (pulls in the DB), so a client
                    // bundle can't import it.
                    <MailToggle msAccountId={r.id} canSend={r.scopes.includes('Mail.Send')} />
                  )}
                  {!needsReconnect && <DrivesList accountId={r.id} />}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
