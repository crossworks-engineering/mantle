import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Drawings' };

export default function TeamDrawPage() {
  return (
    <Suspense>
      <TeamSection type="draw" />
    </Suspense>
  );
}
