import { SetPageTitle } from '@/components/layout/page-title';
import { AiWorkersClient } from './ai-workers-client';

/**
 * AI workers settings — client data-fetching (Phase 2 · Task 4). Data-free page
 * (auth gate only); the worker list, api keys, and the worker-form config
 * (native-PDF providers + tailnet peers) are fetched in the client with TanStack
 * Query against /api/ai-workers, /api/keys, /api/ai-workers/config. Create/edit/
 * delete + the test/discover RPCs all run through /api/ai-workers/**.
 */
export default async function AiWorkersPage() {
  return (
    <>
      <SetPageTitle title="AI workers" />
      <AiWorkersClient />
    </>
  );
}
