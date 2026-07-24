import { DebugTabs } from '../../debug-tabs';
import { BackLink } from '@mantle/web-ui/layout/back-link';
import { JourneyDetailClient } from './journey-detail-client';

/**
 * Journey detail — the reaction story for one action. Data-free:
 * JourneyDetailClient fetches it from GET /api/debug/journey/[traceId] and
 * renders the step timeline + brain layers.
 */
export default async function JourneyDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId } = await params;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <DebugTabs />
      <BackLink href="/debug/journey">Back to activity</BackLink>
      <JourneyDetailClient traceId={traceId} />
    </div>
  );
}
