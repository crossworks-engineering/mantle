import { requireOwner } from '@/lib/auth';
import { SecretDetailClient } from './secret-detail-client';

/** Deep-link to one secret. Data-free — SecretDetailClient fetches the metadata
 *  from GET /api/secrets/[id] and reuses the shared SecretDetail. */
export default async function SecretDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  return (
    <div className="mx-auto max-w-3xl py-2">
      <SecretDetailClient id={id} />
    </div>
  );
}
