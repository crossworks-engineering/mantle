import { EventDetailClient } from './event-detail-client';

/**
 * /events/[id] — deep link to one event (auth gate only). The event is
 * client-fetched via `GET /api/events/[id]` (Phase 2 · Task 4).
 */
export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-3xl py-2">
      <EventDetailClient eventId={id} />
    </div>
  );
}
