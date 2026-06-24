import { asc, eq } from 'drizzle-orm';
import { CheckCircle2, Cloud, Plus } from 'lucide-react';
import { db, msAccounts } from '@mantle/db';
import { isMicrosoftConfigured } from '@mantle/microsoft';
import { requireOwner } from '@/lib/auth';
import { formatDateTime } from '@/lib/format-datetime';
import { SetPageTitle } from '@/components/layout/page-title';
import { Button } from '@/components/ui/button';
import { DisconnectButton } from './disconnect-button';

export const dynamic = 'force-dynamic';

type Search = { connected?: string; error?: string };

export default async function MicrosoftSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Search>;
}) {
  const user = await requireOwner();
  const sp = (await searchParams) ?? {};
  const configured = isMicrosoftConfigured();

  const rows = await db
    .select()
    .from(msAccounts)
    .where(eq(msAccounts.userId, user.id))
    .orderBy(asc(msAccounts.upn));

  return (
    <>
      <SetPageTitle title="Microsoft" />
      <div className="mx-auto max-w-2xl space-y-5 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Cloud className="size-5 text-muted-foreground" aria-hidden />
              Microsoft accounts
            </h2>
            <p className="text-sm text-muted-foreground">
              Connect a Microsoft 365 account to bring SharePoint, OneDrive, and Outlook into
              Mantle. Sign-in is delegated — Mantle only sees what you can.
            </p>
          </div>
          {configured && (
            <Button asChild size="sm">
              {/* Plain anchor: this is an API route that 302s to Microsoft, not client nav. */}
              <a href="/api/microsoft/oauth/start">
                <Plus /> Connect
              </a>
            </Button>
          )}
        </div>

        {sp.connected && (
          <p className="flex items-center gap-2 rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            Connected <span className="font-medium">{sp.connected}</span>.
          </p>
        )}
        {sp.error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {sp.error === 'not_configured'
              ? 'Microsoft integration isn’t configured on this Mantle. Set MS_CLIENT_ID and MS_CLIENT_SECRET.'
              : sp.error}
          </p>
        )}

        {!configured && (
          <div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Not configured yet</p>
            <p className="mt-1">
              An admin needs to register an Azure AD app and set{' '}
              <code className="font-mono text-xs">MS_CLIENT_ID</code> /{' '}
              <code className="font-mono text-xs">MS_CLIENT_SECRET</code> (plus an admin-consented
              redirect URI). See <code className="font-mono text-xs">docs/microsoft-graph-ingest.md</code>.
            </p>
          </div>
        )}

        {configured && rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No accounts connected. Click <strong>Connect</strong> to sign in with Microsoft.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const needsReconnect = !r.accessTokenEnc || !r.refreshTokenEnc;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                >
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
                      {r.scopes.length} scope{r.scopes.length === 1 ? '' : 's'} · token valid until{' '}
                      {formatDateTime(r.tokenExpiresAt ?? null)}
                    </div>
                    {r.lastSyncError && (
                      <div className="mt-0.5 truncate text-xs text-destructive">⚠ {r.lastSyncError}</div>
                    )}
                  </div>
                  <DisconnectButton accountId={r.id} upn={r.upn} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
