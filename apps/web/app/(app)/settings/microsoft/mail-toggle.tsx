'use client';

import { Mail } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiFetch, apiSend } from '@/lib/api-fetch';

/** Opt-in toggle for Outlook mail sync on a connected account. Mail flows
 *  through the same pipeline (and contact gate) as IMAP. Self-fetches its
 *  enabled state via `/api/microsoft/accounts/[id]/mail`. `canSend` reflects
 *  whether the granted scopes include Mail.Send — accounts connected before
 *  that scope existed must reconnect to also SEND from this address. */
export function MailToggle({ msAccountId, canSend }: { msAccountId: string; canSend: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ['microsoft', 'mail', msAccountId];

  const mailQuery = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ enabled: boolean }>(`/api/microsoft/accounts/${msAccountId}/mail`).then(
        (r) => r.enabled,
      ),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      apiSend(`/api/microsoft/accounts/${msAccountId}/mail`, 'PATCH', { enabled }),
    onSuccess: (_res, enabled) => queryClient.setQueryData(key, enabled),
    onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
  });

  const enabled = mailQuery.data ?? false;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Outlook mail</div>
        <div className="text-xs text-muted-foreground">
          Sync inbox mail into the brain. Only messages from your{' '}
          <a href="/contacts" className="underline underline-offset-2">
            contacts
          </a>{' '}
          are ingested.
        </div>
        {!canSend && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Sending from this address is off — it was connected before send permission was
            requested. Reconnect the account to also send mail from it.
          </div>
        )}
      </div>
      <Switch
        checked={enabled}
        disabled={mailQuery.isPending || toggle.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label="Sync Outlook mail"
      />
    </div>
  );
}
