import Link from 'next/link';
import { SystemVitals } from '@/components/dashboard/system-vitals';
import { SetPageTitle } from '@/components/layout/page-title';
import { DashboardClient } from './dashboard-client';

/**
 * Dashboard — the "brain health" overview. Data-free: the live host/Postgres
 * vitals come from the <SystemVitals> island polling /api/health, and the
 * brain metrics (KPIs, charts, ops panels) are fetched by <DashboardClient>
 * from GET /api/dashboard. The deep operator view stays at /debug.
 */
export default async function DashboardPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <SetPageTitle title="Dashboard" />
      <header className="flex flex-wrap items-center justify-end gap-2">
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/debug" className="text-primary underline-offset-2 hover:underline">
            Operator view
          </Link>
          <Link href="/traces" className="text-primary underline-offset-2 hover:underline">
            Traces
          </Link>
        </nav>
      </header>

      <SystemVitals />

      <DashboardClient />
    </div>
  );
}
