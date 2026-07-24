import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { ContextClient } from './context-client';

/**
 * /debug/context — per-turn retrieval audit. Data-free: ContextClient fetches
 * GET /api/debug/context (question · context sent · response), so you can judge
 * whether the retrieved context matched the question.
 */
export default async function DebugContextPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || '';

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Context" />
      <ContextClient page={page} query={query} />
    </div>
  );
}
