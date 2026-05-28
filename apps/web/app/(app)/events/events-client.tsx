'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, MapPin, Plus, Repeat, Search } from 'lucide-react';
import { useRealtime } from '@/components/realtime/use-realtime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useNow } from '@/components/use-now';
import { dayGroup, eventState, formatRelativeShort, type DayGroup } from '@/lib/event-time';
import { EventForm, emptyEventForm, type EventPayload } from './event-form';
import { EventDetail, type EventRow } from './event-detail';

type Selection = { mode: 'create' } | { mode: 'view'; id: string } | null;

const GROUP_ORDER: DayGroup[] = ['today', 'tomorrow', 'this_week', 'later', 'past'];
const GROUP_LABEL: Record<DayGroup, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  this_week: 'This week',
  later: 'Later',
  past: 'Past',
};

/** Date label for a card — pinned to en-GB so SSR matches the client. */
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });
}

export function EventsClient({
  initialEvents,
  total,
  page,
  pageSize,
  query,
  window,
}: {
  initialEvents: EventRow[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  window: 'upcoming' | 'past' | 'all';
}) {
  const router = useRouter();
  const { pending: navPending, go } = useListNav();
  const toast = useToast();
  const now = useNow(60_000); // minute tick drives live badges + grouping
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  const [events, setEvents] = useState(initialEvents);
  const [searchInput, setSearchInput] = useState(query);
  const [pending, startTransition] = useTransition();
  const [sel, setSel] = useState<Selection>(() =>
    initialEvents[0] ? { mode: 'view', id: initialEvents[0].id } : { mode: 'create' },
  );

  // Re-seed on SSR nav (search / window / page).
  useEffect(() => setEvents(initialEvents), [initialEvents]);

  // Debounced search → URL (?q=); resets to page 1.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() !== query) go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Live db-watch: Saskia adds an event / a reminder edit / another tab → refetch.
  useRealtime(['event'], () => router.refresh());

  const all = events;
  const selected = sel?.mode === 'view' ? (all.find((e) => e.id === sel.id) ?? null) : null;

  // Group by day once mounted; before that, a flat upcoming→past list (SSR-safe).
  const groups = useMemo(() => {
    if (!now) return null;
    const buckets: Record<DayGroup, EventRow[]> = {
      today: [],
      tomorrow: [],
      this_week: [],
      later: [],
      past: [],
    };
    for (const e of all) buckets[dayGroup(e.startsAt, now, tz)].push(e);
    for (const k of GROUP_ORDER) buckets[k].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
    buckets.past.reverse(); // most-recent first
    return buckets;
  }, [now, all, tz]);

  const createEvent = async (payload: EventPayload) => {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? `Could not save event (${res.status})`);
      return;
    }
    const { event } = (await res.json()) as { event: EventRow };
    setEvents((p) => [event, ...p]);
    setSel({ mode: 'view', id: event.id });
    toast.success(`Saved “${event.title}”`);
    startTransition(() => router.refresh());
  };

  const onUpdated = (e: EventRow) => {
    setEvents((p) => p.map((x) => (x.id === e.id ? e : x)));
    startTransition(() => router.refresh());
  };

  const onDeleted = (id: string) => {
    const next = all.filter((e) => e.id !== id);
    setEvents((p) => p.filter((e) => e.id !== id));
    setSel(next[0] ? { mode: 'view', id: next[0].id } : { mode: 'create' });
    startTransition(() => router.refresh());
  };

  const renderCard = (e: EventRow) => {
    const isSel = sel?.mode === 'view' && sel.id === e.id;
    const state = now ? eventState(e.startsAt, e.endsAt, now) : 'upcoming';
    const live = state === 'in_progress';
    const isPast = state === 'past';
    return (
      <button
        key={e.id}
        type="button"
        onClick={() => setSel({ mode: 'view', id: e.id })}
        className={cn(
          'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-accent/40',
          isSel && 'border-l-primary bg-accent/50',
          live && !isSel && 'border-l-primary',
          isPast && !isSel && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{e.title}</span>
          <span className={cn('ml-auto shrink-0 text-xs tabular-nums', live ? 'font-medium text-primary' : 'text-muted-foreground')}>
            {now ? (live ? 'now' : formatRelativeShort(e.startsAt, now)) : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          {e.recur !== 'none' && <Repeat className="size-3 shrink-0" aria-label={`repeats ${e.recur}`} />}
          <span className="truncate">{fmt(e.startsAt)}</span>
        </div>
        {(e.location || e.tags.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            {e.location && (
              <span className="inline-flex items-center gap-0.5">
                <MapPin className="size-3" /> {e.location}
              </span>
            )}
            {e.tags.map((t) => (
              <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                {t}
              </span>
            ))}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
      {/* ── Left: event list ─────────────────────────────────────── */}
      <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between gap-2 border-b border-border p-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Events
          </h2>
          <Button type="button" size="sm" onClick={() => setSel({ mode: 'create' })}>
            <Plus /> New
          </Button>
        </div>
        <div className="space-y-2 border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search events…"
              className="h-9 pl-8"
            />
          </div>
          <select
            value={window}
            onChange={(e) => go({ window: e.target.value === 'upcoming' ? null : e.target.value, page: null })}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            aria-label="Filter events"
          >
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="space-y-3 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
          {all.length === 0 ? (
            <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
              {query || window !== 'upcoming' ? (
                'No events match your search or filter.'
              ) : (
                <>
                  No upcoming events. Click <strong>New</strong>, or ask Saskia (“remind me of my
                  meeting at 10am”).
                </>
              )}
            </p>
          ) : groups ? (
            GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => (
              <section key={g} className="space-y-2">
                <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {GROUP_LABEL[g]}
                </h3>
                <div className="space-y-2">{groups[g].map(renderCard)}</div>
              </section>
            ))
          ) : (
            // Pre-mount fallback: flat list (matches SSR order).
            <div className="space-y-2">{all.map(renderCard)}</div>
          )}
        </div>
        <ListPager
          page={page}
          total={total}
          pageSize={pageSize}
          pending={navPending}
          onGo={(p) => go({ page: p > 1 ? p : null })}
        />
      </div>

      {/* ── Right: create | detail | empty ───────────────────────── */}
      <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
        {sel?.mode === 'create' ? (
          // Width-lock matches the contacts form (mx-auto max-w-2xl) so the
          // detail/form doesn't sprawl across wide screens.
          <div className="mx-auto max-w-2xl space-y-4 p-6">
            <div className="flex items-center gap-2">
              <CalendarClock className="size-5 text-primary" aria-hidden />
              <h2 className="text-lg font-semibold">New event</h2>
            </div>
            <p className="text-xs text-muted-foreground">
              The reminder fires the chosen lead time before the start and pings your most-recent
              Telegram chat.
            </p>
            <EventForm
              initial={emptyEventForm()}
              submitLabel="Save event"
              submitting={pending}
              onSubmit={createEvent}
              onCancel={() => {
                const first = all[0];
                setSel(first ? { mode: 'view', id: first.id } : { mode: 'create' });
              }}
            />
          </div>
        ) : selected ? (
          <EventDetail
            key={selected.id}
            event={selected}
            onUpdated={onUpdated}
            onDeleted={() => onDeleted(selected.id)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
            Select an event, or add a new one.
          </div>
        )}
      </div>
    </div>
  );
}
