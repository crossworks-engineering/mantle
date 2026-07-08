import type { Metadata } from 'next';
import { TeamHubShell } from '@/components/team-chat/team-hub-client';

export const metadata: Metadata = { title: 'Team Hub' };

// No server-side DB reads here (detached-dev safe; the surface is public) —
// the client resolves its session against /api/team/hub and renders the
// token prompt on 401. The hub is the landing; chat is a view switch inside
// the shell (same gate, same cookie).
export default function TeamHubPage() {
  return <TeamHubShell />;
}
