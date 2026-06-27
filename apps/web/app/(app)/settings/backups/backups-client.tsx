'use client';

/**
 * Backup settings form + run-now + dump listing.
 *
 * One card configures the schedule (enable, frequency, hour in the user's
 * timezone, retention, destination directory); a second shows the last-run
 * status and the dumps currently on disk. The offsite story is one sentence
 * of guidance, not a feature: point your own sync tool at the directory.
 *
 * Data-free: the outer component fetches GET /api/backups; the inner form mounts
 * only once loaded so its useState initializers seed correctly. Save / run-now
 * are apiSend mutations that invalidate the query.
 */

import { useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, FolderOpen } from 'lucide-react';
import { apiFetch, apiSend } from '@/lib/api-fetch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { BackupConfig, BackupFile, BackupStatus } from '@mantle/content';

type BackupsData = {
  config: BackupConfig;
  status: BackupStatus | null;
  dumps: BackupFile[];
  resolvedDir: string;
  timezone: string;
};

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function BackupsClient() {
  const backupsQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => apiFetch<BackupsData>('/api/backups'),
  });
  if (backupsQuery.isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (backupsQuery.isError && !backupsQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
        <p>Couldn&apos;t load backup settings.</p>
        <Button variant="outline" size="sm" onClick={() => backupsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <BackupsView data={backupsQuery.data} />;
}

function BackupsView({ data }: { data: BackupsData }) {
  const { config, status, dumps, resolvedDir, timezone } = data;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(config.enabled);
  const [frequency, setFrequency] = useState(config.frequency);
  const [hour, setHour] = useState(String(config.hour));
  const [saving, startSaving] = useTransition();
  const [running, startRunning] = useTransition();

  const onSave = (formData: FormData) => {
    startSaving(async () => {
      try {
        await apiSend('/api/backups', 'POST', {
          enabled,
          frequency,
          hour: Number(hour),
          keep: Number(formData.get('keep')),
          location: String(formData.get('location') ?? '').trim(),
        });
        toast.success('Backup settings saved');
        queryClient.invalidateQueries({ queryKey: ['backups'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save backup settings');
      }
    });
  };

  const onRunNow = () => {
    startRunning(async () => {
      try {
        const { status: s } = await apiSend<{ status: BackupStatus }>('/api/backups/run', 'POST');
        if (s.ok) {
          toast.success(`Backup written${s.bytes ? ` (${fmtBytes(s.bytes)})` : ''}`);
        } else {
          toast.error(s.error ?? 'Backup failed');
        }
        queryClient.invalidateQueries({ queryKey: ['backups'] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Backup failed');
      }
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Scheduled backups</CardTitle>
              <CardDescription>
                Dumps the database (everything your brain knows) to a local folder on the
                configured schedule and keeps the newest copies. Getting that folder
                off this machine is up to you — point rsync, rclone, restic, or any sync
                tool at it.
              </CardDescription>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable scheduled backups"
            />
          </div>
        </CardHeader>
        <CardContent>
          <form action={onSave} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="backup-frequency">Frequency</Label>
                <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}>
                  <SelectTrigger id="backup-frequency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly (Sundays)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-hour">At hour</Label>
                <Select value={hour} onValueChange={setHour}>
                  <SelectTrigger id="backup-hour">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {String(h).padStart(2, '0')}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{timezone}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-keep">Keep</Label>
                <Input
                  id="backup-keep"
                  name="keep"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={config.keep}
                />
                <p className="text-xs text-muted-foreground">newest dumps retained</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="backup-location">Folder</Label>
              <Input
                id="backup-location"
                name="location"
                defaultValue={config.location ?? ''}
                placeholder={resolvedDir}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for the default shown above. Your files and attachments
                (<code>data/files</code>, <code>data/minio</code>) already live on disk
                beside it — include them in your offsite copy.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <SubmitButton pending={saving}>Save backup settings</SubmitButton>
              <Button type="button" variant="outline" onClick={onRunNow} disabled={running}>
                <DatabaseBackup />
                {running ? 'Backing up…' : 'Run backup now'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Scheduled runs fire while the events worker is up — if the stack was down
              during the window, the next window catches it.
            </p>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>On disk</CardTitle>
          <CardDescription className="flex items-center gap-2">
            <FolderOpen className="size-4 shrink-0" />
            <code className="break-all">{resolvedDir}</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status && (
            <div
              className={
                status.ok
                  ? 'rounded-md border border-border bg-accent px-3 py-2 text-sm text-accent-foreground'
                  : 'rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-foreground'
              }
            >
              {status.ok ? (
                <>
                  Last backup succeeded {new Date(status.lastRunAt).toLocaleString()} (
                  {status.bytes ? fmtBytes(status.bytes) : '—'}, {status.trigger})
                </>
              ) : (
                <>
                  Last backup <span className="font-medium">failed</span>{' '}
                  {new Date(status.lastRunAt).toLocaleString()}: {status.error}
                  {status.lastSuccessAt && (
                    <> — last good dump {new Date(status.lastSuccessAt).toLocaleString()}</>
                  )}
                </>
              )}
            </div>
          )}
          {dumps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No backups yet. Enable the schedule or run one now.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {dumps.map((d) => (
                <li key={d.name} className="flex items-center justify-between gap-4 py-2">
                  <span className="truncate font-mono">{d.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {fmtBytes(d.bytes)} · {new Date(d.mtime).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
