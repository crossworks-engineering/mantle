'use client';

import { useTransition } from 'react';
import { FolderGit2, HardDrive, RefreshCw } from 'lucide-react';
import type { MsDrive } from '@mantle/db';
import { Switch } from '@/components/ui/switch';
import { SubmitButton } from '@/components/ui/submit-button';
import { formatDateTime } from '@/lib/format-datetime';
import { discoverDrivesAction, toggleDriveAction } from './actions';

/**
 * Per-account drive picker. Drives are opt-in — nothing syncs until toggled on.
 * "Refresh" re-enumerates OneDrive + followed SharePoint libraries.
 */
export function DrivesList({ accountId, drives }: { accountId: string; drives: MsDrive[] }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Drives to sync
        </h4>
        <form action={discoverDrivesAction}>
          <input type="hidden" name="accountId" value={accountId} />
          <SubmitButton variant="outline" size="sm">
            <RefreshCw /> Refresh drives
          </SubmitButton>
        </form>
      </div>

      {drives.length === 0 ? (
        <p className="px-1 py-3 text-xs text-muted-foreground">
          No drives discovered yet. Click <strong>Refresh drives</strong> to list this account&apos;s
          OneDrive and followed SharePoint libraries.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {drives.map((d) => (
            <DriveRow key={d.id} drive={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DriveRow({ drive }: { drive: MsDrive }) {
  const [pending, startTransition] = useTransition();
  const isSharePoint = !!drive.siteName;
  const Icon = isSharePoint ? FolderGit2 : HardDrive;

  return (
    <li className="flex items-center gap-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {drive.siteName ? `${drive.siteName} · ${drive.name}` : drive.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {isSharePoint ? 'SharePoint' : 'OneDrive'}
          {drive.enabled
            ? drive.lastSyncAt
              ? ` · last sync ${formatDateTime(drive.lastSyncAt)}`
              : ' · sync pending'
            : ' · off'}
          {drive.lastError ? ` · ⚠ ${drive.lastError}` : ''}
        </div>
      </div>
      <Switch
        checked={drive.enabled}
        disabled={pending}
        onCheckedChange={(next) => startTransition(() => toggleDriveAction(drive.id, next))}
        aria-label={`Sync ${drive.name}`}
      />
    </li>
  );
}
