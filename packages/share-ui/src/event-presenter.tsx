'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CalendarCheck, CalendarDays, Clock, Download, MapPin, Repeat, Tag } from 'lucide-react';
import { formatDateTime } from '@mantle/client-types/lib/format-datetime';
import { buildIcsHref } from '@mantle/client-types/lib/event-time';
import { isEmbedded, type PresenterChrome } from './lib/presenter-chrome';
import { cn } from './lib/utils';

type EventView = {
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  /** Optional — an older brain omits these and the rows simply don't render. */
  recur?: string | null;
  recurUntil?: string | null;
  tags?: string[];
};

/** Live clock, ticking only after mount. On the static /s render (no
 *  hydration for the event kind) this stays null and the hero shows the
 *  date-anchored snapshot instead — same SSR-safe fallback the owner pane
 *  uses. */
function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function remainingLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86_400);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(s / 3600);
  if (hours >= 1) return `${hours} h ${Math.floor((s % 3600) / 60)} min`;
  const min = Math.floor(s / 60);
  return `${min}:${String(s % 60).padStart(2, '0')} min`;
}

/**
 * The countdown hero — the owner pane's signature, ported for members: a
 * coming event leads with HOW SOON, a running one says so live, a past one
 * closes the loop. Left-aligned like every other row (the member asked "when
 * is this", not for a poster). Degrades to plain dates with no JS.
 */
function CountdownHero({ startsAt, endsAt }: { startsAt: string; endsAt: string | null }) {
  const now = useNow();
  const start = Date.parse(startsAt);
  const end = endsAt ? Date.parse(endsAt) : start + 60 * 60 * 1000;
  if (now === null) {
    return <p className="text-sm font-medium text-primary-ink">{formatDateTime(startsAt)}</p>;
  }
  if (now < start) {
    return (
      <div>
        <p className="text-3xl font-bold tabular-nums tracking-tight">
          {remainingLabel(start - now)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">until it starts</p>
      </div>
    );
  }
  if (now <= end) {
    return (
      <div className="flex items-center gap-2">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-success" />
        </span>
        <div>
          <p className="text-lg font-semibold">Happening now</p>
          {endsAt && <p className="text-xs text-muted-foreground">ends {formatDateTime(endsAt)}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      <CalendarCheck className="size-5 shrink-0" aria-hidden />
      <p className="text-sm">Ended {formatDateTime(endsAt ?? startsAt)}</p>
    </div>
  );
}

/**
 * Public event render — countdown, time, location, recurrence, tags, and an
 * .ics link: the owner pane's details, member-safe (reminders stay private).
 *
 * On the standalone page this is a card in a measured column: the card border
 * is what tells a reader where the event begins and ends on an otherwise empty
 * page. Embedded in a pane that already has a header rule and a border of its
 * own, that same card is the "floating box in the middle" — so embedded drops
 * the frame and the title, and lays the detail out on the pane. Everything is
 * left-aligned in both modes. See `PresenterChrome`.
 */
export function EventPresenter({ view, chrome }: { view: EventView; chrome?: PresenterChrome }) {
  const ics = buildIcsHref(view);
  const embedded = isEmbedded(chrome);
  const recur = view.recur && view.recur !== 'none' ? view.recur : null;
  return (
    <div className={embedded ? 'w-full px-6 py-6' : 'mx-auto max-w-2xl px-6 py-12 md:py-16'}>
      <div className={cn(!embedded && 'rounded-xl border border-border bg-card p-6')}>
        {!embedded && (
          <div className="flex items-start gap-3">
            <CalendarDays className="mt-1 size-6 shrink-0 text-primary-ink" aria-hidden />
            <h1 className="text-2xl font-bold tracking-tight text-balance">{view.title}</h1>
          </div>
        )}

        {view.startsAt && (
          <div className={cn(!embedded && 'mt-5')}>
            <CountdownHero startsAt={view.startsAt} endsAt={view.endsAt} />
          </div>
        )}

        <dl className={cn('space-y-2 text-sm', view.startsAt ? 'mt-4' : !embedded && 'mt-5')}>
          {view.startsAt && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="size-4 shrink-0" aria-hidden />
              <span>
                {formatDateTime(view.startsAt)}
                {view.endsAt ? ` – ${formatDateTime(view.endsAt)}` : ''}
              </span>
            </div>
          )}
          {view.location && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <MapPin className="size-4 shrink-0" aria-hidden />
              <span>{view.location}</span>
            </div>
          )}
          {recur && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Repeat className="size-4 shrink-0" aria-hidden />
              <span className="capitalize">
                {recur}
                {view.recurUntil ? ` · until ${formatDateTime(view.recurUntil)}` : ''}
              </span>
            </div>
          )}
          {(view.tags?.length ?? 0) > 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Tag className="size-4 shrink-0" aria-hidden />
              <span className="flex flex-wrap gap-1">
                {view.tags!.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </span>
            </div>
          )}
        </dl>

        {view.body && (
          <div className="prose prose-sm dark:prose-invert mt-5 max-w-none border-t border-border pt-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.body}</ReactMarkdown>
          </div>
        )}

        {ics && (
          <a
            href={ics}
            download={`${view.title || 'event'}.ics`}
            className="mt-6 inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent/40"
          >
            <Download className="size-4" aria-hidden /> Add to calendar
          </a>
        )}
      </div>
    </div>
  );
}
