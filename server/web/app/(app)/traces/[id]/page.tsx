import { requireOwner } from '@/lib/auth';
import { TracePageClient } from './trace-page-client';

/** Deep link to one trace. Data-free — TracePageClient fetches it from
 *  GET /api/traces/[id] and reuses the shared TraceDetailView. */
export default async function TraceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <TracePageClient id={id} />
    </div>
  );
}
