'use client';

import { useQuery } from '@tanstack/react-query';
import type { CalendarAccountDTO } from '@mantle/client-types';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { Button } from '@mantle/web-ui/ui/button';
import { Spinner } from '@mantle/web-ui/ui/spinner';
import { AddFeedForm } from './add-form';
import { CalendarRow } from './calendar-row';

/** Client list for /settings/calendar — the subscribe form + the subscribed
 *  feeds, fetched over HTTP so the page stays data-free. Mutations (add /
 *  toggle / delete) invalidate the ['calendar'] query. */
export function CalendarClient() {
  const calendarsQuery = useQuery({
    queryKey: ['calendar'],
    queryFn: () =>
      apiFetch<{ accounts: CalendarAccountDTO[] }>('/api/calendar').then((r) => r.accounts),
  });
  const accounts = calendarsQuery.data ?? [];

  return (
    <>
      <AddFeedForm />
      {calendarsQuery.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : calendarsQuery.isError && accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
          <p>Couldn&apos;t load calendars.</p>
          <Button variant="outline" size="sm" onClick={() => calendarsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : accounts.length === 0 ? (
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
    </>
  );
}
