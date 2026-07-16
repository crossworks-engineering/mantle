'use client';

import { Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { apiSend } from '@/lib/api-fetch';

/** Destructive confirm before dropping a connected Microsoft account's tokens.
 *  Per the style guide: AlertDialog (not window.confirm), red action. */
export function DisconnectButton({ accountId, upn }: { accountId: string; upn: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const disconnect = useMutation({
    mutationFn: () => apiSend(`/api/microsoft/accounts/${accountId}`, 'DELETE'),
    onSuccess: () => {
      toast.success(`Disconnected ${upn}`);
      void queryClient.invalidateQueries({ queryKey: ['microsoft', 'accounts'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

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
            Mantle will delete its stored access for this Microsoft account and stop syncing it. You
            can reconnect any time. Content already ingested is not removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: 'destructive' }))}
            onClick={() => disconnect.mutate()}
          >
            Disconnect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
