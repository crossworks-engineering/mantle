import type { Metadata } from 'next';
import { Suspense } from 'react';
import { TeamSection } from '@/components/team-workspace/team-section';

export const metadata: Metadata = { title: 'Team · Apps' };

export default function TeamAppsPage() {
  return (
    <Suspense>
      <TeamSection type="app" />
    </Suspense>
  );
}
