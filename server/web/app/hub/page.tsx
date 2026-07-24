import type { Metadata } from 'next';
import { TeamHubShell } from '@/components/team-chat/team-hub-client';

export const metadata: Metadata = { title: 'Team Hub' };

// No server-side DB reads here (detached-dev safe; the surface is public) —
// the client resolves its session against /api/team/hub and renders the
// token prompt on 401. Renders the designated hub app full-bleed when the
// brain has one; the built-in briefing hub otherwise.
export default function TeamHubPage() {
  return <TeamHubShell />;
}
