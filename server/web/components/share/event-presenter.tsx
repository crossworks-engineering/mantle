import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CalendarDays, Clock, Download, MapPin } from 'lucide-react';
import { formatDateTime } from '@mantle/web-ui/lib/format-datetime';
import { buildIcsHref } from '@mantle/web-ui/lib/event-time';

type EventView = {
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
};

/** Public event render — a clean card with time, location, and an .ics link. */
export function EventPresenter({ view }: { view: EventView }) {
  const ics = buildIcsHref(view);
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 md:py-16">
      <div className="rounded-xl border border-border bg-card p-6">
        <div className="flex items-start gap-3">
          <CalendarDays className="mt-1 size-6 shrink-0 text-primary" aria-hidden />
          <h1 className="text-2xl font-bold tracking-tight text-balance">{view.title}</h1>
        </div>

        <dl className="mt-5 space-y-2 text-sm">
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
