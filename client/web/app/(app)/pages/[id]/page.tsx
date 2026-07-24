import { PageDetailClient } from './page-detail-client';

/**
 * /pages/[id] — the page editor (auth gate only). The page row + backlinks are
 * client-fetched via `GET /api/pages/[id]` and `…/backlinks` (Phase 2 · Task 4).
 * No wrapper: the client owns its chromeless, width-toggling canvas.
 */
export default async function PageEditorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PageDetailClient pageId={id} />;
}
