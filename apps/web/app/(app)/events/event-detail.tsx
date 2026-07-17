'use client';

import { useState, useTransition } from 'react';
import {
  Bell,
  CalendarCheck,
  CalendarPlus,
  Clock,
  MapPin,
  Pencil,
  Repeat,
  Trash2,
} from 'lucide-react';
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
} from '@/components/ui/alert-dialog';
import { useToast } from '@/components/ui/toast';
import { apiSend, ApiError } from '@/lib/api-fetch';
import { ShareControl } from '@/components/share/share-control';
import { formatDateTime } from '@/lib/format-datetime';
import { useNow } from '@/components/use-now';
import {
  approachProgress,
  buildIcsHref,
  countdownParts,
  eventProgress,
  eventState,
  formatRelativeShort,
} from '@/lib/event-time';
import { EventForm, eventToForm, type EventPayload } from './event-form';
import type { EventRow } from '@mantle/content';

// Wire shape is the GET /api/events mapper's output — single source of truth.
// Re-exported so the list client keeps importing it from here; drift is a
// compile error. (The canonical row also carries `timezone`, unused here.)
export type { EventRow };

const pad = (n: number) => String(n).padStart(2, '0');

/** Circular progress ring (theme-token stroke). progress 0..1. */
function Ring({ progress, children }: { progress: number; children: React.ReactNode }) {
  const C = 2 * Math.PI * 52;
  return (
    <div className="relative grid size-36 shrink-0 place-items-center">
      <svg viewBox="0 0 120 120" className="absolute size-36 -rotate-90">
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          strokeWidth="7"
          style={{ stroke: 'var(--muted)' }}
        />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          style={{
            stroke: 'var(--primary)',
            strokeDasharray: C,
            strokeDashoffset: C * (1 - Math.min(1, Math.max(0, progress))),
            transition: 'stroke-dashoffset 1s linear',
          }}
        />
      </svg>
      <div className="text-center">{children}</div>
    </div>
  );
}

/** The live countdown hero — ring for upcoming, pulse+bar for in-progress,
 *  muted for past. Renders a static date until `now` ticks (SSR-safe). */
function Countdown({ event, now }: { event: EventRow; now: number }) {
  if (!now) {
    return (
      <div className="grid size-36 shrink-0 place-items-center rounded-full border border-border text-center">
        <span className="px-2 text-xs text-muted-foreground">{formatDateTime(event.startsAt)}</span>
      </div>
    );
  }

  const state = eventState(event.startsAt, event.endsAt, now);

  if (state === 'upcoming') {
    const p = countdownParts(event.startsAt, now);
    const underADay = p.days < 1;
    return (
      <div className="flex flex-col items-center gap-1.5">
        <Ring progress={approachProgress(event.startsAt, now)}>
          {underADay ? (
            <>
              <div className="text-2xl font-bold tabular-nums">
                {pad(p.hours)}:{pad(p.minutes)}:{pad(p.seconds)}
              </div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                to go
              </div>
            </>
          ) : (
            <>
              <div className="text-4xl font-bold tabular-nums leading-none">{p.days}</div>
              <div className="text-xs text-muted-foreground">day{p.days === 1 ? '' : 's'}</div>
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                {p.hours}h {p.minutes}m
              </div>
            </>
          )}
        </Ring>
      </div>
    );
  }

  if (state === 'in_progress') {
    const prog = eventProgress(event.startsAt, event.endsAt, now);
    return (
      <div className="flex w-40 flex-col items-center gap-3 py-4">
        <span className="relative flex size-3">
          <span
            className="absolute inline-flex size-full animate-ping rounded-full opacity-60"
            style={{ background: 'var(--primary)' }}
          />
          <span
            className="inline-flex size-3 rounded-full"
            style={{ background: 'var(--primary)' }}
          />
        </span>
        <div className="text-lg font-semibold" style={{ color: 'var(--primary)' }}>
          Happening now
        </div>
        {event.endsAt && (
          <div className="w-full space-y-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-[width] duration-1000"
                style={{ width: `${Math.round(prog * 100)}%`, background: 'var(--primary)' }}
              />
            </div>
            <div className="text-center text-xs text-muted-foreground">
              ends {formatRelativeShort(event.endsAt, now)}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex w-36 flex-col items-center gap-2 py-6 text-muted-foreground">
      <CalendarCheck className="size-9" aria-hidden />
      <div className="text-sm">
        Ended {formatRelativeShort(event.endsAt ?? event.startsAt, now)}
      </div>
    </div>
  );
}

/**
 * Chrome-free event detail: a live countdown hero + metadata + add-to-calendar,
 * edit, delete. Reused by the master-detail right pane and the /events/[id]
 * deep link (which adds page chrome). Mount with `key={event.id}` so selecting
 * another event resets edit state.
 */
export function EventDetail({
  event,
  onUpdated,
  onDeleted,
}: {
  event: EventRow;
  onUpdated?: (e: EventRow) => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  const now = useNow(1000);
  const [meta, setMeta] = useState(event);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const saveEdit = async (payload: EventPayload) => {
    let updated: EventRow;
    try {
      ({ event: updated } = await apiSend<{ event: EventRow }>(
        `/api/events/${meta.id}`,
        'PATCH',
        payload,
      ));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Save failed');
      return;
    }
    setMeta(updated);
    setEditing(false);
    onUpdated?.(updated);
  };

  const confirmDelete = async () => {
    setDeleteOpen(false);
    try {
      await apiSend(`/api/events/${meta.id}`, 'DELETE');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not delete event');
      return;
    }
    toast.success(`Deleted “${meta.title}”`);
    startTransition(() => onDeleted?.());
  };

  if (editing) {
    return (
      <div className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">Edit event</h2>
        <EventForm
          initial={eventToForm(meta)}
          submitLabel="Save event"
          submitting={pending}
          onSubmit={saveEdit}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  const ics = buildIcsHref(meta);

  return (
    // Width-lock matches the contacts form (mx-auto max-w-2xl) so the detail
    // doesn't sprawl across wide screens.
    <div className="mx-auto max-w-2xl space-y-5 p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <Countdown event={meta} now={now} />

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 text-xl font-semibold">{meta.title}</h2>
            <div className="flex shrink-0 items-center gap-2">
              <ShareControl nodeId={meta.id} iconOnly />
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </div>

          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Clock className="size-4 shrink-0" aria-hidden />
            <span>
              {formatDateTime(meta.startsAt)}
              {meta.endsAt && ` → ${formatDateTime(meta.endsAt)}`}
            </span>
          </p>
          {meta.location && (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="size-4 shrink-0" aria-hidden /> {meta.location}
            </p>
          )}
          <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Bell className="size-3.5 shrink-0" aria-hidden />
            {meta.reminderSentAt
              ? `Reminder sent ${formatDateTime(meta.reminderSentAt)}`
              : `Reminder ${
                  meta.remindMinutesBefore === 0
                    ? 'at start'
                    : `${meta.remindMinutesBefore}m before`
                } · fires ${formatDateTime(meta.remindAt)}`}
          </p>
          {meta.recur !== 'none' && (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Repeat className="size-3.5 shrink-0" aria-hidden />
              <span className="capitalize">{meta.recur}</span>
              {meta.recurUntil && (
                <span className="lowercase">until {formatDateTime(meta.recurUntil)}</span>
              )}
            </p>
          )}
          {meta.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {meta.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {ics && (
            <div className="pt-1">
              <a
                href={ics}
                download={`${meta.title || 'event'}.ics`}
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/40"
              >
                <CalendarPlus className="size-4" aria-hidden /> Add to calendar
              </a>
            </div>
          )}
        </div>
      </div>

      {meta.body && (
        <pre className="whitespace-pre-wrap rounded-md border border-border bg-card p-4 font-sans text-sm">
          {meta.body}
        </pre>
      )}
      {meta.summary && (
        <p className="text-xs italic text-muted-foreground">Indexed: {meta.summary}</p>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{meta.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Any pending reminder won&apos;t fire. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
