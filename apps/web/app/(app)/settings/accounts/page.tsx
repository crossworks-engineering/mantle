import { desc, eq, inArray } from 'drizzle-orm';
import { Activity, FolderTree, Mail } from 'lucide-react';
import { db, emailAccounts, syncRuns, type SyncRun } from '@mantle/db';
import { requireOwner } from '@/lib/auth';
import { Button } from '@/components/ui/button';

interface ImapCursorShape {
  folders?: Record<string, { uidvalidity: number; lastUid: number }>;
}

export default async function AccountsSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ connected?: string; error?: string }>;
}) {
  const user = await requireOwner();
  const params = (await searchParams) ?? {};
  const googleConfigured = !!process.env['GOOGLE_CLIENT_ID'] && !!process.env['GOOGLE_CLIENT_SECRET'];
  const rows = await db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.userId, user.id));

  // Latest sync_runs row per account (and any currently-running ones).
  // Two cheap queries beats a fancy DISTINCT ON for this volume.
  const accountIds = rows.map((r) => r.id);
  const latestRuns: Map<string, SyncRun> = new Map();
  if (accountIds.length > 0) {
    const recent = await db
      .select()
      .from(syncRuns)
      .where(inArray(syncRuns.accountId, accountIds))
      .orderBy(desc(syncRuns.startedAt))
      .limit(accountIds.length * 5);
    for (const r of recent) {
      // First hit per account wins (rows are date-desc).
      if (!latestRuns.has(r.accountId)) latestRuns.set(r.accountId, r);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Email accounts</h1>
        <p className="text-sm text-muted-foreground">
          Plug Mantle into your inboxes. We pull every message into Postgres and route them onto your tree
          using your ingest rules.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Connected</h2>
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            No accounts yet.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((r) => {
              const imapCursor = (r.syncState as { imap?: ImapCursorShape } | null)?.imap;
              const touchedFolders = imapCursor?.folders ? Object.keys(imapCursor.folders).sort() : [];
              const latest = latestRuns.get(r.id);
              return (
                <li key={r.id} className="space-y-2 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Mail className="size-4 text-muted-foreground" aria-hidden />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium">{r.address}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.provider}
                        {r.provider === 'imap' && r.imapHost && (
                          <>
                            {' · '}
                            {r.imapHost}:{r.imapPort}
                          </>
                        )}
                        {' · '}last sync {r.lastSyncAt?.toLocaleString() ?? 'never'}
                      </div>
                      {r.lastSyncError && (
                        <div className="mt-1 text-xs text-destructive">⚠ {r.lastSyncError}</div>
                      )}
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                        latest?.status === 'running'
                          ? 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100'
                          : r.enabled
                          ? 'bg-green-100 text-green-900'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {latest?.status === 'running'
                        ? 'syncing now'
                        : r.enabled
                        ? 'idle'
                        : 'paused'}
                    </span>
                  </div>

                  {latest && (
                    <div className="ml-7 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Activity className="size-3" aria-hidden />
                      <span>
                        Last run: {latest.status}
                        {latest.durationMs != null && ` in ${(latest.durationMs / 1000).toFixed(1)}s`}
                        {' · '}scanned <span className="text-foreground/70">{latest.scanned}</span>
                        {' · '}ingested <span className="text-foreground/70">{latest.ingested}</span>
                        {' · '}new senders <span className="text-foreground/70">{latest.newSenders}</span>
                      </span>
                    </div>
                  )}

                  {r.provider === 'imap' && (
                    <div className="ml-7 space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-start gap-1.5">
                        <FolderTree className="mt-0.5 size-3 shrink-0" aria-hidden />
                        <div className="min-w-0">
                          {touchedFolders.length > 0 ? (
                            <>
                              <span className="font-medium text-foreground/70">Scanning:</span>{' '}
                              {touchedFolders.join(', ')}
                            </>
                          ) : (
                            <span className="italic">No folders touched yet — first sync still pending.</span>
                          )}
                        </div>
                      </div>
                      {r.imapExcludedFolders.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <span className="w-3 shrink-0" aria-hidden />
                          <div className="min-w-0">
                            <span className="font-medium text-foreground/70">Excluded:</span>{' '}
                            {r.imapExcludedFolders.join(', ')}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Add an account</h2>

        {params.connected && (
          <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
            Connected <span className="font-medium">{params.connected}</span>. First sync will run within
            two minutes.
          </p>
        )}
        {params.error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {params.error}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3">
          {googleConfigured ? (
            <Button asChild variant="outline">
              <a href="/api/oauth/google/start">Connect Gmail</a>
            </Button>
          ) : (
            <Button variant="outline" disabled title="Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local">
              Connect Gmail
            </Button>
          )}
          <Button asChild variant="outline" disabled title="Microsoft 365 adapter not implemented yet">
            <span>Connect Microsoft 365</span>
          </Button>
          <Button asChild variant="outline">
            <a href="/settings/accounts/imap">Add IMAP</a>
          </Button>
        </div>
        {!googleConfigured && (
          <p className="text-xs text-muted-foreground">
            Gmail needs Google Cloud OAuth credentials. See <code className="font-mono">README.md</code>{' '}
            "Connecting Gmail" for the setup steps.
          </p>
        )}
      </section>
    </div>
  );
}
