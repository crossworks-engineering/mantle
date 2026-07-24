import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Events' };

export default function TeamEventsPage() {
  return (
    <Suspense>
      <TeamSection type="event" />
    </Suspense>
  );
}
