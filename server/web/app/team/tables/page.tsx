import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Tables' };

export default function TeamTablesPage() {
  return (
    <Suspense>
      <TeamSection type="table" />
    </Suspense>
  );
}
