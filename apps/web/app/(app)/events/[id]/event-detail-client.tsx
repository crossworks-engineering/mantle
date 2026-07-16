'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { SetPageTitle } from '@/components/layout/page-title';
import { BackLink } from '@/components/layout/back-link';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api-fetch';
import { EventDetail, type EventRow } from '../event-detail';

/**
 * Deep-link wrapper for /events/[id]. The master-detail list (/events) is the
 * primary surface; this route stays working as a shareable deep link, reusing
 * the same EventDetail (live countdown + edit/delete) with added page chrome.
 * The event is client-fetched via `GET /api/events/[id]` (Phase 2 · Task 4).
 */
export function EventDetailClient({ eventId }: { eventId: string }) {
  const q = useQuery({
    queryKey: ['events', eventId],
    queryFn: () => apiFetch<{ event: EventRow }>(`/api/events/${eventId}`).then((r) => r.event),
  });

  if (q.isPending) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }
  if (q.isError) {
    const notFound = q.error instanceof Error && /not found|404/i.test(q.error.message);
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center text-sm">
        <p className="text-muted-foreground">
          {notFound ? 'Event not found.' : 'Failed to load event.'}
        </p>
        <BackLink href="/events">All events</BackLink>
      </div>
    );
  }

  return <EventDetailInner initial={q.data} />;
}

function EventDetailInner({ initial }: { initial: EventRow }) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.title);
  return (
    <>
      <SetPageTitle title={title} />
      <div className="px-6 pt-2">
        <BackLink href="/events">All events</BackLink>
      </div>
      <EventDetail
        event={initial}
        onUpdated={(e) => setTitle(e.title)}
        onDeleted={() => router.push('/events')}
      />
    </>
  );
}
