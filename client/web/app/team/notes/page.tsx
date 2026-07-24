import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Notes' };

export default function TeamNotesPage() {
  return (
    <Suspense>
      <TeamSection type="note" />
    </Suspense>
  );
}
