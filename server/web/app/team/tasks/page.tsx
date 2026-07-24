import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Tasks' };

export default function TeamTasksPage() {
  return (
    <Suspense>
      <TeamSection type="task" />
    </Suspense>
  );
}
