import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { FactsClient } from './facts-client';

/** Debug → Facts. Data-free: FactsClient fetches GET /api/debug/facts. */
export default async function DebugFactsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || '';

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Facts" />
      <FactsClient page={page} query={query} />
    </div>
  );
}
