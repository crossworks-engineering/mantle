import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Files' };

export default function TeamFoldersPage() {
  return (
    <Suspense>
      <TeamSection type="branch" emptyHint="No folders are shared yet." />
    </Suspense>
  );
}
