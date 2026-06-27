'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Trash2 } from 'lucide-react';
import type { CalendarAccount } from '@mantle/db';
import { apiSend } from '@/lib/api-fetch';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-datetime';

export function CalendarRow({ account }: { account: CalendarAccount }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['calendar'] });

  async function toggle(next: boolean) {
    setPending(true);
    try {
      await apiSend(`/api/calendar/${account.id}`, 'PATCH', { enabled: next });
      invalidate();
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    await apiSend(`/api/calendar/${account.id}`, 'DELETE');
    invalidate();
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{account.displayName}</div>
        <div className="truncate text-xs text-muted-foreground">
          {account.provider.toUpperCase()}
          {account.enabled
            ? account.lastSyncAt
              ? ` · ${account.lastEventCount ?? 0} events · last sync ${formatDateTime(account.lastSyncAt)}`
              : ' · sync pending'
            : ' · off'}
        </div>
        {account.lastSyncError && (
          <div className="truncate text-xs text-destructive">⚠ {account.lastSyncError}</div>
        )}
      </div>

      <Switch
        checked={account.enabled}
        disabled={pending}
        onCheckedChange={toggle}
        aria-label={`Sync ${account.displayName}`}
      />

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsubscribe from {account.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the subscription and every event it synced into your calendar. Events you
              created yourself are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={remove}
              className={cn(buttonVariants({ variant: 'destructive' }))}
            >
              Unsubscribe
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
