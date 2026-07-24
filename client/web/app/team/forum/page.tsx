import type { Metadata } from 'next';
import { TopicListClient } from '@/components/team-forum/topic-list-client';

export const metadata: Metadata = { title: 'Team · Forum' };

// The Forum = the team's shared threads with the brain (successor to the 1:1
// assistant chat). Auth rides the team cookie the shell established.
export default function TeamForumPage() {
  return <TopicListClient />;
}
