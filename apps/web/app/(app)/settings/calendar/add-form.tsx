'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addIcsFeedAction, type AddFeedResult } from './actions';

const initial: AddFeedResult | undefined = undefined;

/** Subscribe to an iCalendar feed. Controlled-free: on success the form resets
 *  so the next feed can be added immediately. */
export function AddFeedForm() {
  const [state, formAction] = useActionState(addIcsFeedAction, initial);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Subscribe to a calendar</h3>
        <p className="text-xs text-muted-foreground">
          Paste a calendar&apos;s <strong>iCal / .ics URL</strong> — Google (Settings → your calendar →
          “Secret address in iCal format”), Outlook (Publish calendar → ICS), Apple, or any CalDAV
          feed.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="displayName">Name</Label>
        <Input id="displayName" name="displayName" placeholder="Work calendar" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="url">iCal URL</Label>
        <Input
          id="url"
          name="url"
          type="url"
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          required
        />
      </div>
      {state && !state.ok && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
          Subscribed. First sync runs within two minutes.
        </p>
      )}
      <SubmitButton size="sm">
        <Plus /> Subscribe
      </SubmitButton>
    </form>
  );
}
