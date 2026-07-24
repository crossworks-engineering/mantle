import { requireOwner } from '@/lib/auth';
import { HeartbeatDetailClient } from './heartbeat-detail-client';

/**
 * /heartbeats/[id] — single-heartbeat biography. Data-free:
 * HeartbeatDetailClient fetches the summary, fires, and profile-formatted date
 * labels from GET /api/heartbeats/[id]/detail.
 */
export default async function HeartbeatDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  return <HeartbeatDetailClient id={id} />;
}
