import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Pages' };

export default function TeamPagesPage() {
  return (
    <Suspense>
      <TeamSection type="page" />
    </Suspense>
  );
}
