import type { ActionCategory } from '@mantle/web-ui/journey-format';
import { DebugTabs } from '../debug-tabs';
import { SetPageTitle } from '@/components/layout/page-title';
import { ActiveNow } from '@/components/journey/active-now';
import { JourneyClient } from './journey-client';

/**
 * Journey view — Activity → Reaction. A feed of actions each linking to the
 * reaction story. Data-free: the page parses the cat/done URL state; the
 * always-on ActiveNow header self-polls /api/activity, and JourneyClient
 * fetches the feed from GET /api/debug/journey.
 */
export default async function JourneyPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; done?: string }>;
}) {
  const { cat, done } = await searchParams;
  const category = (['content', 'dialog', 'automation'] as const).find((c) => c === cat) as
    ActionCategory | undefined;
  const processedOnly = done === '1';

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Journey" />
      <ActiveNow />
      <JourneyClient category={category} processedOnly={processedOnly} />
    </div>
  );
}
