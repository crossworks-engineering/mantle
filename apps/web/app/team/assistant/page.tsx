import type { Metadata } from 'next';
import { TeamChatClient } from '@/components/team-chat/team-chat-client';

export const metadata: Metadata = { title: 'Team · Assistant' };

// The member Assistant = the team-responder agent (retrieval-only, whole-brain
// grounding, per-member thread + audit). Same component the hub used; auth
// rides the same team cookie the shell already established.
export default function TeamAssistantPage() {
  return <TeamChatClient />;
}
