'use client';

import { useTransition } from 'react';
import { Mail } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toggleMailAction } from './actions';

/** Opt-in toggle for Outlook mail sync on a connected account. Mail flows
 *  through the same pipeline (and contact gate) as IMAP. */
export function MailToggle({ msAccountId, enabled }: { msAccountId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Outlook mail</div>
        <div className="text-xs text-muted-foreground">
          Sync inbox mail into the brain. Only messages from your{' '}
          <a href="/contacts" className="underline underline-offset-2">contacts</a> are ingested.
        </div>
      </div>
      <Switch
        checked={enabled}
        disabled={pending}
        onCheckedChange={(next) => startTransition(() => toggleMailAction(msAccountId, next))}
        aria-label="Sync Outlook mail"
      />
    </div>
  );
}
