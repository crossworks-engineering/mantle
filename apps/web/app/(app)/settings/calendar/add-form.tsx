'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { apiSend } from '@/lib/api-fetch';
import { SubmitButton } from '@/components/ui/submit-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Subscribe to an iCalendar feed. On success the form resets so the next feed
 *  can be added immediately, and the ['calendar'] list is invalidated. */
export function AddFeedForm() {
  const queryClient = useQueryClient();
  const ref = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setOk(false);
    try {
      await apiSend('/api/calendar', 'POST', {
        displayName: String(fd.get('displayName') ?? ''),
        url: String(fd.get('url') ?? ''),
      });
      setOk(true);
      ref.current?.reset();
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      ref={ref}
      onSubmit={onSubmit}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Subscribe to a calendar</h3>
        <p className="text-xs text-muted-foreground">
          Paste a calendar&apos;s <strong>iCal / .ics URL</strong> — Google (Settings → your
          calendar → “Secret address in iCal format”), Outlook (Publish calendar → ICS), Apple, or
          any CalDAV feed.
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
      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {ok && (
        <p className="rounded-md border border-green-500/30 bg-green-50 px-3 py-2 text-sm text-green-900 dark:bg-green-950/40 dark:text-green-100">
          Subscribed. First sync runs within two minutes.
        </p>
      )}
      <SubmitButton size="sm" pending={pending}>
        <Plus /> Subscribe
      </SubmitButton>
    </form>
  );
}
