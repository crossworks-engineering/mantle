import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { EntitiesClient } from './entities-client';

/**
 * Entities: data-free. EntitiesClient fetches duplicate candidates from
 * GET /api/entities/candidates and resolves them via POST /api/entities/merge
 * and POST /api/entities/dismiss.
 */
export default async function EntitiesSettingsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Entities" />
      <EntitiesClient />
    </>
  );
}
