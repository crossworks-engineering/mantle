import { SetPageTitle } from '@/components/layout/page-title';
import { PendingClient } from './pending-client';

/**
 * Pending approvals: data-free. PendingClient fetches the rows from
 * GET /api/pending and decides via PATCH /api/pending/[id].
 */
export default async function PendingPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <SetPageTitle title="Pending approvals" />
      <PendingClient devMode={process.env.NODE_ENV !== 'production'} />
    </div>
  );
}
