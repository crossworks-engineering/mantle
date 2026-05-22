'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRealtime } from '@/components/realtime/use-realtime';
import { Bell, Calendar, MapPin, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';

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

const REMIND_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'At start' },
  { value: 5, label: '5 min before' },
  { value: 15, label: '15 min before' },
  { value: 60, label: '1 hour before' },
  { value: 60 * 24, label: '1 day before' },
];

function fmt(iso: string): string {
  // Pinned to 'en-GB' so the SSR render matches the client render.
  // Without a locale arg, Node and browser produce different strings
  // and React throws a hydration mismatch. See lib/format-datetime.ts.
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const h = Math.round(abs / 3_600_000);
  if (h < 1) return diff > 0 ? 'soon' : 'just now';
  if (h < 24) return diff > 0 ? `in ${h}h` : `${h}h ago`;
  const days = Math.round(h / 24);
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

export function EventsClient({
  initialUpcoming,
  initialPast,
}: {
  initialUpcoming: EventRow[];
  initialPast: EventRow[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [upcoming, setUpcoming] = useState(initialUpcoming);
  const [past, setPast] = useState(initialPast);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: '',
    body: '',
    startsAt: '',
    endsAt: '',
    location: '',
    remindMinutesBefore: 0,
    tags: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Keep the lists current when the server re-renders (e.g. a realtime refresh
  // below). The props are the source of truth; local optimistic edits reconcile
  // on the next refresh.
  useEffect(() => setUpcoming(initialUpcoming), [initialUpcoming]);
  useEffect(() => setPast(initialPast), [initialPast]);

  // Live db-watch: when an event node lands (Saskia creates one, a reminder
  // edit, another tab) the SSE stream fires and we refetch — no manual refresh.
  useRealtime(['event'], () => router.refresh());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.title.trim()) return setError('Title is required');
    if (!form.startsAt) return setError('Start time is required');
    // Capture the browser's IANA tz so the reminder formatter (and
    // the assistant later) can show times in the user's wall clock,
    // not the agent process's. Falls back to UTC inside the lib if
    // we somehow got nothing back.
    const tz =
      Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    const payload: Record<string, unknown> = {
      title: form.title.trim(),
      body: form.body,
      startsAt: new Date(form.startsAt).toISOString(),
      remindMinutesBefore: form.remindMinutesBefore,
      timezone: tz,
      tags: form.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    };
    if (form.endsAt) payload.endsAt = new Date(form.endsAt).toISOString();
    if (form.location) payload.location = form.location;
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? `request failed (${res.status})`);
      return;
    }
    const { event } = await res.json();
    if (new Date(event.startsAt) >= new Date()) {
      setUpcoming((prev) => [event, ...prev].sort(
        (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      ));
    } else {
      setPast((prev) => [event, ...prev]);
    }
    setForm({
      title: '',
      body: '',
      startsAt: '',
      endsAt: '',
      location: '',
      remindMinutesBefore: 0,
      tags: '',
    });
    setOpen(false);
    startTransition(() => router.refresh());
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this event? Pending reminders will not fire.')) return;
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not delete event (${res.status})`);
      return;
    }
    setUpcoming((prev) => prev.filter((e) => e.id !== id));
    setPast((prev) => prev.filter((e) => e.id !== id));
    startTransition(() => router.refresh());
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus /> New event
        </Button>
      </div>

      {upcoming.length === 0 && past.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/30 px-6 py-12 text-center text-sm text-muted-foreground">
          No events yet. Click &ldquo;New event&rdquo; or ask your assistant
          to add one (&ldquo;remind me of my meeting at 10am&rdquo;).
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Upcoming
              </h2>
              <EventList rows={upcoming} onDelete={handleDelete} />
            </section>
          )}
          {past.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Past (recent)
              </h2>
              <EventList rows={past} onDelete={handleDelete} dim />
            </section>
          )}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New event</DialogTitle>
            <DialogDescription>
              The reminder fires <em>remind-minutes-before</em> the start
              time and pings your most-recent Telegram DM.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                autoFocus
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
                <Label htmlFor="endsAt">Ends (optional)</Label>
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
              <Label htmlFor="location">Location (optional)</Label>
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
                rows={4}
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
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : 'Save event'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EventList({
  rows,
  onDelete,
  dim,
}: {
  rows: EventRow[];
  onDelete: (id: string) => void;
  dim?: boolean;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((e) => (
        <li
          key={e.id}
          className={`group flex items-start gap-3 px-3 py-2.5 ${dim ? 'opacity-70' : ''}`}
        >
          <Calendar className="mt-1 size-4 text-muted-foreground" />
          <Link href={`/events/${e.id}`} className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="truncate font-medium">{e.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {relTime(e.startsAt)}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {fmt(e.startsAt)}
              {e.endsAt && ` → ${fmt(e.endsAt)}`}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {e.location && (
                <span className="inline-flex items-center gap-0.5">
                  <MapPin className="size-3" /> {e.location}
                </span>
              )}
              <span className="inline-flex items-center gap-0.5">
                <Bell className="size-3" />
                {e.reminderSentAt
                  ? 'sent'
                  : e.remindMinutesBefore === 0
                    ? 'at start'
                    : `${e.remindMinutesBefore}m before`}
              </span>
              {e.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]"
                >
                  {t}
                </span>
              ))}
            </div>
            {e.summary && (
              <p className="line-clamp-1 text-xs italic text-muted-foreground">
                {e.summary}
              </p>
            )}
          </Link>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(e.id)}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label={`Delete ${e.title}`}
          >
            <Trash2 />
          </Button>
        </li>
      ))}
    </ul>
  );
}
