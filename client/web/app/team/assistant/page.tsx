import type { Metadata } from 'next';
import { TeamChatClient } from '@/components/team-chat/team-chat-client';

export const metadata: Metadata = { title: 'Team · Chat archive' };

// The old 1:1 assistant chat, kept as a READ-ONLY archive — conversations
// moved to the shared Forum (/team/forum). The member's history stays
// browsable; the composer is gone.
export default function TeamAssistantPage() {
  return <TeamChatClient archive />;
}
