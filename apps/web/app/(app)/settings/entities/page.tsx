import { requireOwner } from '@/lib/auth';
import { findDuplicateCandidates } from '@mantle/content';
import { SetPageTitle } from '@/components/layout/page-title';
import { EntitiesClient } from './entities-client';

export default async function EntitiesSettingsPage() {
  const user = await requireOwner();
  const candidates = await findDuplicateCandidates(user.id);
  return (
    <>
      <SetPageTitle title="Entities" />
      <EntitiesClient initial={candidates} />
    </>
  );
}
