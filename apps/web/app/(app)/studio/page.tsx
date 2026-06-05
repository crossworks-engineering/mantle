import { requireOwner } from '@/lib/auth';
import { buildStudioGraph } from '@/lib/studio/graph';
import { SetPageTitle } from '@/components/layout/page-title';
import { StudioView } from './studio-view';

// Reads live agent/skill/worker rows + runs the integrity checker on each load.
export const dynamic = 'force-dynamic';

export default async function StudioPage() {
  const user = await requireOwner();
  const graph = await buildStudioGraph(user.id);
  return (
    <>
      <SetPageTitle title="Studio" />
      <StudioView graph={graph} />
    </>
  );
}
