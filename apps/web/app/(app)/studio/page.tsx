import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { StudioClient } from './studio-view';

/** Agent Studio. Data-free: StudioClient fetches the graph (live agent/skill/
 *  worker rows + the integrity report) from GET /api/studio. */
export default async function StudioPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Studio" />
      <StudioClient />
    </>
  );
}
