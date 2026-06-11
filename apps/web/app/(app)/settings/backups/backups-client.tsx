'use client';

/**
 * Backup settings form + run-now + dump listing.
 *
 * One card configures the schedule (enable, frequency, hour in the user's
 * timezone, retention, destination directory); a second shows the last-run
 * status and the dumps currently on disk. The offsite story is one sentence
 * of guidance, not a feature: point your own sync tool at the directory.
 */

import { useState, useTransition } from 'react';
import { DatabaseBackup, FolderOpen } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { SubmitButton } from '@/components/ui/submit-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import type { BackupConfig, BackupFile, BackupStatus } from '@mantle/content';

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function BackupsClient({
  config,
  status,
  dumps,
  resolvedDir,
  timezone,
  saveAction,
  runNowAction,
}: {
  config: BackupConfig;
  status: BackupStatus | null;
  dumps: BackupFile[];
  resolvedDir: string;
  timezone: string;
  saveAction: (formData: FormData) => Promise<void>;
  runNowAction: () => Promise<BackupStatus>;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(config.enabled);
  const [frequency, setFrequency] = useState(config.frequency);
  const [hour, setHour] = useState(String(config.hour));
  const [saving, startSaving] = useTransition();
  const [running, startRunning] = useTransition();

  const onSave = (formData: FormData) => {
    startSaving(async () => {
      try {
        await saveAction(formData);
        toast.success('Backup settings saved');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not save backup settings');
      }
    });
  };

  const onRunNow = () => {
    startRunning(async () => {
      try {
        const s = await runNowAction();
        if (s.ok) {
          toast.success(`Backup written${s.bytes ? ` (${fmtBytes(s.bytes)})` : ''}`);
        } else {
          toast.error(s.error ?? 'Backup failed');
        }
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
            <input type="hidden" name="enabled" value={enabled ? 'on' : ''} />
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
                <input type="hidden" name="frequency" value={frequency} />
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
                <input type="hidden" name="hour" value={hour} />
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
