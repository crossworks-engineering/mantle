import { requireOwner } from '@/lib/auth';
import { listEvents } from '@/lib/events';
import { SetPageTitle } from '@/components/layout/page-title';
import { EventsClient } from './events-client';

export default async function EventsPage() {
  const user = await requireOwner();
  const [upcoming, past] = await Promise.all([
    listEvents(user.id, { window: 'upcoming' }),
    listEvents(user.id, { window: 'past' }),
  ]);
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
      <SetPageTitle title="Events" />
      <EventsClient initialUpcoming={upcoming} initialPast={past.slice(0, 25)} />
    </div>
  );
}
