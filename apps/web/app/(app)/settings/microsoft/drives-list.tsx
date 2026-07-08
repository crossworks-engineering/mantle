'use client';

import { useState } from 'react';
import { FolderGit2, HardDrive, ListTree, Loader2, RefreshCw } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MsDriveDTO } from '@mantle/client-types';
import { DriveScopeDialog } from './drive-scope-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format-datetime';
import { apiFetch, apiSend } from '@/lib/api-fetch';

/**
 * Per-account drive picker. Drives are opt-in — nothing syncs until toggled on.
 * "Refresh" re-enumerates OneDrive + followed SharePoint libraries. Self-fetches
 * via `/api/microsoft/accounts/[id]/drives`.
 */
export function DrivesList({ accountId }: { accountId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [picking, setPicking] = useState<MsDriveDTO | null>(null);
  const key = ['microsoft', 'drives', accountId];

  const drivesQuery = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ drives: MsDriveDTO[] }>(`/api/microsoft/accounts/${accountId}/drives`).then(
        (r) => r.drives,
      ),
  });

  const discover = useMutation({
    mutationFn: () => apiSend<{ drives: MsDriveDTO[] }>(`/api/microsoft/accounts/${accountId}/drives`, 'POST'),
    onSuccess: (res) => queryClient.setQueryData(key, res.drives),
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const toggle = useMutation({
    mutationFn: ({ driveDbId, enabled }: { driveDbId: string; enabled: boolean }) =>
      apiSend(`/api/microsoft/drives/${driveDbId}`, 'PATCH', { enabled }),
    onSuccess: (_res, { driveDbId, enabled }) =>
      queryClient.setQueryData<MsDriveDTO[]>(key, (old) =>
        (old ?? []).map((d) => (d.id === driveDbId ? { ...d, enabled } : d)),
      ),
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const drives = drivesQuery.data ?? [];

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Drives to sync
        </h4>
        <Button
          variant="outline"
          size="sm"
          onClick={() => discover.mutate()}
          disabled={discover.isPending}
        >
          {discover.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh drives
        </Button>
      </div>

      {drivesQuery.isPending ? (
        <div className="flex items-center justify-center py-4">
          <Spinner />
        </div>
      ) : drivesQuery.isError ? (
        <p className="px-1 py-3 text-xs text-destructive">
          {drivesQuery.error instanceof Error ? drivesQuery.error.message : 'Failed to load drives.'}
        </p>
      ) : drives.length === 0 ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">
          No drives discovered yet. Click <strong>Refresh drives</strong> to list this account&apos;s
          OneDrive and followed SharePoint libraries.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {drives.map((d) => {
            const isSharePoint = !!d.siteName;
            const Icon = isSharePoint ? FolderGit2 : HardDrive;
            return (
              <li key={d.id} className="flex items-center gap-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {d.siteName ? `${d.siteName} · ${d.name}` : d.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {isSharePoint ? 'SharePoint' : 'OneDrive'}
                    {d.enabled
                      ? d.lastSyncAt
                        ? ` · last sync ${formatDateTime(d.lastSyncAt)}`
                        : ' · sync pending'
                      : ' · off'}
                    {d.enabled
                      ? d.scopeCount > 0
                        ? ` · ${d.scopeCount} selection${d.scopeCount === 1 ? '' : 's'}`
                        : ' · everything'
                      : ''}
                    {d.lastError ? ` · ⚠ ${d.lastError}` : ''}
                  </div>
                </div>
                {d.enabled && (
                  <Button variant="ghost" size="sm" onClick={() => setPicking(d)}>
                    <ListTree /> Choose content
                  </Button>
                )}
                <Switch
                  checked={d.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(next) => toggle.mutate({ driveDbId: d.id, enabled: next })}
                  aria-label={`Sync ${d.name}`}
                />
              </li>
            );
          })}
        </ul>
      )}
      {picking && (
        <DriveScopeDialog accountId={accountId} drive={picking} onClose={() => setPicking(null)} />
      )}
      <p className="px-1 text-xs text-muted-foreground">
        Listed here: this account&apos;s OneDrive plus the document libraries of SharePoint sites it{' '}
        <strong>follows</strong>. Missing a site? Follow it in SharePoint (the ☆ Follow button on the
        site), then Refresh drives. Access alone isn&apos;t enough — unfollowed sites don&apos;t appear.
      </p>
    </div>
  );
}
