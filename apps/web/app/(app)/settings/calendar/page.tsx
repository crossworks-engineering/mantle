import { CalendarDays } from 'lucide-react';
import { listCalendarAccounts } from '@mantle/calendar';
import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { AddFeedForm } from './add-form';
import { CalendarRow } from './calendar-row';

export const dynamic = 'force-dynamic';

export default async function CalendarSettingsPage() {
  const user = await requireOwner();
  const accounts = await listCalendarAccounts(user.id);

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
            <a href="/events" className="underline underline-offset-2">events</a>, in search, and in
            the knowledge graph. Read-only — the source calendar stays in charge.
          </p>
        </div>

        <AddFeedForm />

        {accounts.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            No calendars yet. Subscribe to one above.
          </p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a) => (
              <CalendarRow key={a.id} account={a} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
