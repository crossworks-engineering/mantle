import type { Metadata } from 'next';
import { TeamOverview } from '@/components/team-workspace/team-overview';

export const metadata: Metadata = { title: 'Team' };

// No server-side DB reads (detached-dev safe; the surface is public) — the
// shell in the layout resolves the session against /api/team/workspace and
// renders the token prompt on 401. The old curated hub lives on at /hub.
export default function TeamOverviewPage() {
  return <TeamOverview />;
}
