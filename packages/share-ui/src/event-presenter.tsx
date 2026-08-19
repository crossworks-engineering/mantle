import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CalendarDays, Clock, Download, MapPin } from 'lucide-react';
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
};

/**
 * Public event render — time, location, and an .ics link.
 *
 * On the standalone page this is a centred card: the card border is what tells
 * a reader where the event begins and ends on an otherwise empty page. Embedded
 * in a pane that already has a header rule and a border of its own, that same
 * card is the "floating box in the middle" — so embedded drops the frame and
 * the title, and lays the detail out on the pane. See `PresenterChrome`.
 */
export function EventPresenter({ view, chrome }: { view: EventView; chrome?: PresenterChrome }) {
  const ics = buildIcsHref(view);
  const embedded = isEmbedded(chrome);
  return (
    <div className={embedded ? 'w-full px-6 py-6' : 'mx-auto max-w-2xl px-6 py-12 md:py-16'}>
      <div className={cn(!embedded && 'rounded-xl border border-border bg-card p-6')}>
        {!embedded && (
          <div className="flex items-start gap-3">
            <CalendarDays className="mt-1 size-6 shrink-0 text-primary-ink" aria-hidden />
            <h1 className="text-2xl font-bold tracking-tight text-balance">{view.title}</h1>
          </div>
        )}

        <dl className={cn('space-y-2 text-sm', !embedded && 'mt-5')}>
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
