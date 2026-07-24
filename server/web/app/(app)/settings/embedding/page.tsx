import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { EmbeddingClient } from './embedding-client';

/**
 * /settings/embedding — the single embedder config (primary + backup routes +
 * perf knobs). Data-free: EmbeddingClient fetches GET /api/embedding and mutates
 * via POST /api/embedding (save), /api/embedding/test (probe a route's dim), and
 * /api/embedding/rebuild (re-embed the corpus).
 */
export default async function EmbeddingPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Embedding" />
      <EmbeddingClient />
    </>
  );
}
