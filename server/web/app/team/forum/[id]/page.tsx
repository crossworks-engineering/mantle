import type { Metadata } from 'next';
import { TopicViewClient } from '@/components/team-forum/topic-view-client';

export const metadata: Metadata = { title: 'Team · Forum' };

// One forum topic. `?turn=<id>` carries an in-flight turn from "New topic" so
// the view attaches to the live stream instead of waiting for a refetch.
export default async function TeamForumTopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ turn?: string }>;
}) {
  const { id } = await params;
  const { turn } = await searchParams;
  return <TopicViewClient topicId={id} initialTurnId={turn} />;
}
