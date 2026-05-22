'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, MapPin, Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { formatDateTime } from '@/lib/format-datetime';

type EventRow = {
  id: string;
  title: string;
  body: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  remindMinutesBefore: number;
  remindAt: string;
  reminderSentAt: string | null;
  tags: string[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

const REMIND_PRESETS = [
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min before' },
  { value: 15, label: '15 min before' },
  { value: 60, label: '1 hour before' },
  { value: 60 * 24, label: '1 day before' },
];

function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  // Convert UTC ISO to a value that <input type=datetime-local> accepts.
  const d = new Date(iso);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

export function EventDetailClient({ initial }: { initial: EventRow }) {
  const router = useRouter();
  const toast = useToast();
  const [event, setEvent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: event.title,
    body: event.body,
    startsAt: fmtLocal(event.startsAt),
    endsAt: fmtLocal(event.endsAt),
    location: event.location ?? '',
    remindMinutesBefore: event.remindMinutesBefore,
    tags: event.tags.join(', '),
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // Re-capture the browser TZ on save so an edit from a different
    // device/timezone reflects the user's current wall-clock context.
    const tz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    const payload: Record<string, unknown> = {
      title: form.title.trim(),
      body: form.body,
      remindMinutesBefore: form.remindMinutesBefore,
      timezone: tz,
      tags: form.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    };
    if (form.startsAt) payload.startsAt = new Date(form.startsAt).toISOString();
    payload.endsAt = form.endsAt ? new Date(form.endsAt).toISOString() : null;
    payload.location = form.location || null;
    const res = await fetch(`/api/events/${event.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? 'save failed');
      return;
    }
    const { event: updated } = await res.json();
    setEvent(updated);
    setEditing(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async () => {
    if (!confirm('Delete this event? Pending reminders will not fire.')) return;
    const res = await fetch(`/api/events/${event.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not delete event (${res.status})`);
      return;
    }
    router.push('/events');
  };

  return (
    <div className="space-y-4">
      <SetPageTitle title={event.title} />
      <BackLink href="/events">All events</BackLink>

      {!editing ? (
        <>
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(event.startsAt)}
                  {event.endsAt && ` → ${formatDateTime(event.endsAt)}`}
                </p>
                {event.location && (
                  <p className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <MapPin className="size-3" /> {event.location}
                  </p>
                )}
                <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Bell className="size-3" />
                  {event.reminderSentAt
                    ? `Reminder sent ${formatDateTime(event.reminderSentAt)}`
                    : `Reminder ${
                        event.remindMinutesBefore === 0
                          ? 'at start'
                          : `${event.remindMinutesBefore}m before`
                      } · fires ${formatDateTime(event.remindAt)}`}
                </p>
                {event.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {event.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  <Pencil className="size-3" /> Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={handleDelete} aria-label="Delete event">
                  <Trash2 />
                </Button>
              </div>
            </div>
          </header>

          {event.body && (
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-sans text-sm">
              {event.body}
            </pre>
          )}
          {event.summary && (
            <p className="text-xs italic text-muted-foreground">
              Indexed: {event.summary}
            </p>
          )}
        </>
      ) : (
        <form onSubmit={save} className="space-y-3">
          <header className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Edit event</h1>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                <X className="size-3" /> Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                <Save className="size-3" /> {isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </header>
          <div className="space-y-1">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="startsAt">Starts</Label>
              <Input
                id="startsAt"
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="endsAt">Ends</Label>
              <Input
                id="endsAt"
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="remind">Remind</Label>
            <select
              id="remind"
              value={form.remindMinutesBefore}
              onChange={(e) =>
                setForm({ ...form, remindMinutesBefore: Number(e.target.value) })
              }
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {REMIND_PRESETS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="location">Location</Label>
            <Input
              id="location"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="body">Notes</Label>
            <textarea
              id="body"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tags">Tags (comma-separated)</Label>
            <Input
              id="tags"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      )}
    </div>
  );
}
