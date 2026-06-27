'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, MapPin, Plus, Repeat, Search } from 'lucide-react';
import { useRealtime } from '@/components/realtime/use-realtime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ListPager } from '@/components/layout/list-pager';
import { useListNav } from '@/lib/use-list-nav';
import { apiFetch, apiSend, ApiError } from '@/lib/api-fetch';
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

type EventsListResponse = {
  events: EventRow[];
  total: number;
  page: number;
  pageSize: number;
};

export function EventsClient() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { pending: navPending, go } = useListNav();
  const toast = useToast();
  const now = useNow(60_000); // minute tick drives live badges + grouping
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);

  // URL is the source of truth (matches the old SSR page).
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const query = searchParams.get('q')?.trim() ?? '';
  const windowParam = searchParams.get('window');
  const window: 'upcoming' | 'past' | 'all' =
    windowParam === 'past' || windowParam === 'all' ? windowParam : 'upcoming';

  const listQuery = useQuery({
    queryKey: ['events', { q: query, window, page }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (query) qs.set('q', query);
      if (window !== 'upcoming') qs.set('window', window);
      if (page > 1) qs.set('page', String(page));
      const s = qs.toString();
      return apiFetch<EventsListResponse>(`/api/events${s ? `?${s}` : ''}`);
    },
    placeholderData: (prev) => prev,
  });

  const total = listQuery.data?.total ?? 0;
  const pageSize = listQuery.data?.pageSize ?? 50;

  // Local working copy, so mutations update optimistically; seeded from the query
  // and reconciled whenever the server data changes (incl. a mutation's invalidate).
  const [events, setEvents] = useState<EventRow[]>([]);
  useEffect(() => setEvents(listQuery.data?.events ?? []), [listQuery.data]);

  const [searchInput, setSearchInput] = useState(query);
  const [pending, startTransition] = useTransition();
  // null = "not yet defaulted"; the effect below selects the first event (or
  // create mode) once the list loads.
  const [sel, setSel] = useState<Selection>(null);
  useEffect(() => {
    if (sel !== null) return;
    setSel(events[0] ? { mode: 'view', id: events[0].id } : { mode: 'create' });
  }, [events, sel]);

  // Debounced search → URL (?q=); resets to page 1.
  useEffect(() => {
    const h = setTimeout(() => {
      if (searchInput.trim() !== query) go({ q: searchInput.trim() || null, page: null });
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // Live db-watch: Saskia adds an event / a reminder edit / another tab → refetch.
  useRealtime(['event'], () => {
    void queryClient.invalidateQueries({ queryKey: ['events'] });
  });

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
    let event: EventRow;
    try {
      ({ event } = await apiSend<{ event: EventRow }>('/api/events', 'POST', payload));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // already bounced to /login
      toast.error(e instanceof Error ? e.message : 'Could not save event');
      return;
    }
    setEvents((p) => [event, ...p]);
    setSel({ mode: 'view', id: event.id });
    toast.success(`Saved “${event.title}”`);
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['events'] });
    });
  };

  const onUpdated = (e: EventRow) => {
    setEvents((p) => p.map((x) => (x.id === e.id ? e : x)));
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['events'] });
    });
  };

  const onDeleted = (id: string) => {
    const next = all.filter((e) => e.id !== id);
    setEvents((p) => p.filter((e) => e.id !== id));
    setSel(next[0] ? { mode: 'view', id: next[0].id } : { mode: 'create' });
    startTransition(async () => {
      await queryClient.invalidateQueries({ queryKey: ['events'] });
    });
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
          'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
          isSel && 'border-l-primary',
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

  if (listQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (listQuery.isError && !listQuery.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-muted-foreground">
          {listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load events.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => listQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

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
