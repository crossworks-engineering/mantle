import { AppDetailClient } from './app-detail-client';

/**
 * App editor: data-free. AppDetailClient fetches the app (source + draft +
 * build state) from GET /api/apps/[id] and drives build/publish/discard/assist
 * via the /api/apps/[id]/** routes, setting the page title once loaded.
 */
export default async function AppDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppDetailClient id={id} />;
}
