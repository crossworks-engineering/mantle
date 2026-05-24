import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CalendarDays, Clock, Download, MapPin } from 'lucide-react';
import { formatDateTime } from '@/lib/format-datetime';

type EventView = {
  title: string;
  body: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
};

/** RFC5545 UTC stamp: 20260524T143000Z. */
function icsStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Build an .ics data URL so visitors can add the event to their calendar. */
function icsHref(view: EventView): string | null {
  if (!view.startsAt) return null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mantle//Sharing//EN',
    'BEGIN:VEVENT',
    `UID:${icsStamp(view.startsAt)}-${Math.random().toString(36).slice(2)}@mantle`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(view.startsAt)}`,
    ...(view.endsAt ? [`DTEND:${icsStamp(view.endsAt)}`] : []),
    `SUMMARY:${icsEscape(view.title)}`,
    ...(view.location ? [`LOCATION:${icsEscape(view.location)}`] : []),
    ...(view.body ? [`DESCRIPTION:${icsEscape(view.body)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`;
}

/** Public event render — a clean card with time, location, and an .ics link. */
export function EventPresenter({ view }: { view: EventView }) {
  const ics = icsHref(view);
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
