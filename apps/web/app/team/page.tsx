import type { Metadata } from 'next';
import { TeamChatClient } from '@/components/team-chat/team-chat-client';

export const metadata: Metadata = { title: 'Team Chat' };

// No server-side DB reads here (detached-dev safe; the surface is public) —
// the client resolves its session against /api/team/messages and renders the
// token prompt on 401.
export default function TeamChatPage() {
  return <TeamChatClient />;
}
