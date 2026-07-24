import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { TopicsClient } from './topics-client';

/** Debug → Topics. Data-free: TopicsClient fetches GET /api/debug/topics. */
export default async function DebugTopicsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || '';

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Topics" />
      <TopicsClient page={page} query={query} />
    </div>
  );
}
