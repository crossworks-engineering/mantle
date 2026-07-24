import { CalendarDays } from 'lucide-react';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { CalendarClient } from './calendar-client';

/**
 * Calendar subscriptions (read-only ICS sync). Data-free: CalendarClient fetches
 * the feeds over HTTP (GET /api/calendar) and mutates via POST /api/calendar +
 * PATCH/DELETE /api/calendar/[id].
 */
export default async function CalendarSettingsPage() {
  await requireOwner();

  return (
    <>
      <SetPageTitle title="Calendars" />
      <div className="mx-auto max-w-2xl space-y-5 p-6">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CalendarDays className="size-5 text-muted-foreground" aria-hidden />
            Calendar subscriptions
          </h2>
          <p className="text-sm text-muted-foreground">
            Sync external calendars into Mantle. Subscribed events appear in your{' '}
            <a href="/events" className="underline underline-offset-2">
              events
            </a>
            , in search, and in the knowledge graph. Read-only — the source calendar stays in
            charge.
          </p>
        </div>

        <CalendarClient />
      </div>
    </>
  );
}
