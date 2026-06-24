'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { disconnectMsAccount } from './actions';

/** Destructive confirm before dropping a connected Microsoft account's tokens.
 *  Per the style guide: AlertDialog (not window.confirm), red action. */
export function DisconnectButton({ accountId, upn }: { accountId: string; upn: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive">
          <Trash2 /> Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {upn}?</AlertDialogTitle>
          <AlertDialogDescription>
            Mantle will delete its stored access for this Microsoft account and stop syncing it.
            You can reconnect any time. Content already ingested is not removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={disconnectMsAccount}>
            <input type="hidden" name="accountId" value={accountId} />
            <AlertDialogAction
              type="submit"
              className={cn(buttonVariants({ variant: 'destructive' }))}
            >
              Disconnect
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
